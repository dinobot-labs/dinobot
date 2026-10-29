import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { definePlugin, type PluginSubagent, type PluginTool, type PluginToolCall, type PluginTurnEnd } from "../types.ts";
import { commitFacts, runCheck } from "./git.ts";
import {
	addItemsErrors, CHECK_TIMEOUT_MAX_SEC, COMMIT, type Facts, ID, ITEM_STATUSES, type Ledger, LEDGER_STATUSES, type Op, progress,
	renderMarkdown, TERMINAL, transitionErrors, turnFindings,
} from "./model.ts";
import { LedgerStore } from "./store.ts";

const config = Type.Object(
	{
		/** Directory of the ledger files; default `<dataDir>/pm`. Registered as host storage either way. */
		root: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const ledgerId = Type.String({ pattern: ID.source, description: "Ledger id" });
const itemId = Type.String({ pattern: ID.source, description: "Item id" });

function check<T extends TSchema>(schema: T, args: unknown): Static<T> {
	if (Value.Check(schema, args)) return args;
	throw new Error(`invalid arguments: ${[...Value.Errors(schema, args)].map((error) => `${error.instancePath || "/"}: ${error.message}`).join("; ")}`);
}

function tool<T extends TSchema>(name: string, description: string, schema: T, run: (args: Static<T>, call: PluginToolCall) => Promise<unknown>, readOnly = false, maxDurationMs?: number): PluginTool {
	return { name, description, inputSchema: schema as unknown as PluginTool["inputSchema"], ...(readOnly ? { readOnly: true } : {}), ...(maxDurationMs !== undefined ? { maxDurationMs } : {}), execute: async (args, call) => await run(check(schema, args), call) };
}

/** pm_run_check runs a check of up to CHECK_TIMEOUT_MAX_SEC plus git bookkeeping; a codemode cell calling it waits this long. */
export const RUN_CHECK_MAX_MS = (CHECK_TIMEOUT_MAX_SEC + 45) * 1000;

class Rejected extends Error {
	constructor(readonly errors: readonly string[]) {
		super(`rejected:\n- ${errors.join("\n- ")}`);
	}
}

function within(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function actor(call: PluginToolCall): string {
	if (!call.conversationId) throw new Error("pm tools need a conversation; the host did not attribute this call");
	return call.conversationId;
}

function owned(ledger: Ledger, who: string): void {
	if (ledger.owner !== who) throw new Rejected([`ledger ${ledger.id} is owned by conversation ${ledger.owner}; only its PM conversation may change it (workers report, the PM records)`]);
}

const summary = (ledger: Ledger, now: number) => {
	const p = progress(ledger, now);
	return { id: ledger.id, title: ledger.title, status: ledger.status, owner: ledger.owner, wipLimit: ledger.wipLimit, ...p };
};

const PROMPT = [
	"pm: event-sourced project ledger for long multi-worker work. The ledger, not the conversation, is the source of truth.",
	"- Only the conversation that created a ledger may change it. Workers report; the PM records with pm_transition.",
	"- doing needs a running subagent taskId as worker; done needs a commit that exists (and is reachable from the integration ref) and a passing pm_run_check for every required check on exactly that commit.",
	"- When you end a turn, the host checks the ledger mechanically: finished workers not recorded, doing items without a live worker, idle WIP capacity with ready items, or an all-final ledger still active continue your run.",
	"- Use pm_status for progress and ETA; pause the ledger with a reason to stop dispatch on purpose.",
].join("\n");

export const pmPlugin = definePlugin({
	id: "pm",
	config,
	load(options, host) {
		const root = options.root !== undefined ? resolve(options.root) : host.dataDir !== undefined ? join(host.dataDir, "pm") : undefined;
		if (root === undefined) throw new Error("needs root or a bot data directory");
		const store = new LedgerStore(root);
		const now = () => Date.now();

		async function facts(ledger: Ledger, call: PluginToolCall, commit: string | undefined, to?: string): Promise<Facts & { full?: string }> {
			const subagents = call.subagents ? await call.subagents() : undefined;
			let commitFact: Facts["commit"];
			let full: string | undefined;
			if (ledger.repo !== undefined && commit !== undefined && COMMIT.test(commit)) {
				const found = await commitFacts(ledger.repo, commit, to === "done" ? ledger.integrationRef : undefined, call.signal);
				commitFact = { exists: found.exists, ...(found.reachable !== undefined ? { reachable: found.reachable } : {}) };
				full = found.full;
			}
			return { ...(subagents ? { subagents } : {}), ...(commitFact ? { commit: commitFact } : {}), ...(full ? { full } : {}) };
		}

		const tools: PluginTool[] = [
			tool(
				"create_ledger",
				"Create a project ledger owned by this conversation. checks maps a check id to a shell command run by pm_run_check in a clean work tree at the item's commit; defaultChecks are required for every item that does not name its own.",
				Type.Object({
					id: ledgerId,
					title: Type.String({ minLength: 1, maxLength: 200 }),
					repo: Type.Optional(Type.String({ minLength: 1, description: "Absolute path of the git repository commits are checked in" })),
					integrationRef: Type.Optional(Type.String({ minLength: 1, description: "Ref a done commit must be reachable from, e.g. origin/main" })),
					wipLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
					checks: Type.Optional(Type.Record(Type.String({ pattern: ID.source }), Type.Object({ command: Type.String({ minLength: 1 }), timeoutSec: Type.Optional(Type.Integer({ minimum: 1, maximum: CHECK_TIMEOUT_MAX_SEC })) }, { additionalProperties: false }))),
					defaultChecks: Type.Optional(Type.Array(Type.String({ pattern: ID.source }))),
				}, { additionalProperties: false }),
				async (args, call) => {
					const who = actor(call);
					if (args.repo !== undefined && !isAbsolute(args.repo)) throw new Rejected([`repo must be an absolute path: ${args.repo}`]);
					if (args.integrationRef !== undefined && args.repo === undefined) throw new Rejected(["integrationRef needs repo"]);
					const checks = Object.fromEntries(Object.entries(args.checks ?? {}).map(([key, spec]) => [key, { command: spec.command, timeoutSec: spec.timeoutSec ?? CHECK_TIMEOUT_MAX_SEC }]));
					const missing = (args.defaultChecks ?? []).filter((key) => !(key in checks));
					if (missing.length) throw new Rejected(missing.map((key) => `defaultChecks names unknown check ${key}`));
					return await store.mutate(args.id, who, now, async (current) => {
						if (current) throw new Rejected([`ledger ${args.id} already exists`]);
						const ledger = {
							id: args.id, title: args.title, owner: who, wipLimit: args.wipLimit ?? 5, checks, defaultChecks: args.defaultChecks ?? [], createdAt: now(),
							...(args.repo !== undefined ? { repo: args.repo } : {}),
							...(args.integrationRef !== undefined ? { integrationRef: args.integrationRef } : {}),
						};
						return { ops: [{ op: "create", ledger }], result: (state) => summary(state, now()) };
					});
				},
			),
			tool("list_ledgers", "List ledgers with their owner, status and progress.", Type.Object({}, { additionalProperties: false }), async () => {
				const out: unknown[] = [];
				for (const id of await store.ids()) {
					try {
						const { ledger } = await store.load(id);
						const p = progress(ledger, now());
						out.push({ id, title: ledger.title, status: ledger.status, owner: ledger.owner, done: p.counts.done, total: p.total, percentDone: p.percentDone });
					} catch (error) {
						out.push({ id, error: error instanceof Error ? error.message : String(error) });
					}
				}
				return { ledgers: out };
			}, true),
			tool(
				"add_items",
				"Add work items (todo). Ids are unique and permanent; deps must exist in the ledger or the same batch and stay acyclic.",
				Type.Object({
					ledger: ledgerId,
					items: Type.Array(Type.Object({
						id: itemId,
						title: Type.String({ minLength: 1, maxLength: 300 }),
						area: Type.Optional(Type.String({ maxLength: 60 })),
						size: Type.Optional(Type.Union([Type.Literal("S"), Type.Literal("M"), Type.Literal("L")])),
						deps: Type.Optional(Type.Array(itemId)),
						checks: Type.Optional(Type.Array(Type.String({ pattern: ID.source }))),
					}, { additionalProperties: false }), { minItems: 1, maxItems: 256 }),
				}, { additionalProperties: false }),
				async (args, call) => {
					const who = actor(call);
					return await store.mutate(args.ledger, who, now, async (current) => {
						if (!current) throw new Rejected([`unknown ledger ${args.ledger}`]);
						owned(current.ledger, who);
						if (current.ledger.status === "closed") throw new Rejected([`ledger ${args.ledger} is closed`]);
						const errors = addItemsErrors(current.ledger, args.items);
						if (errors.length) throw new Rejected(errors);
						const items = args.items.map((item) => ({ id: item.id, title: item.title, deps: item.deps ?? [], ...(item.area ? { area: item.area } : {}), ...(item.size ? { size: item.size } : {}), ...(item.checks ? { checks: item.checks } : {}) }));
						return { ops: [{ op: "add_items", items }], result: (state) => ({ added: items.map((item) => item.id), ...summary(state, now()) }) };
					});
				},
			),
			tool(
				"transition",
				"Move an item along todo -> doing -> review -> done (also blocked, excluded, back to todo). The host checks every rule: worker liveness, dependencies, WIP limit, commit existence and reachability, and passing required checks on that commit. Rejected moves record nothing.",
				Type.Object({
					ledger: ledgerId,
					item: itemId,
					to: Type.Union(ITEM_STATUSES.map((status) => Type.Literal(status))),
					worker: Type.Optional(Type.String({ minLength: 1, description: "Subagent taskId; only with to=doing" })),
					commit: Type.Optional(Type.String({ pattern: COMMIT.source })),
					reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
				}, { additionalProperties: false }),
				async (args, call) => {
					const who = actor(call);
					return await store.mutate(args.ledger, who, now, async (current) => {
						if (!current) throw new Rejected([`unknown ledger ${args.ledger}`]);
						owned(current.ledger, who);
						const item = current.ledger.items.find((candidate) => candidate.id === args.item);
						const commit = args.commit ?? item?.commit;
						const known = await facts(current.ledger, call, commit, args.to);
						const errors = transitionErrors(current.ledger, args, known);
						if (errors.length) throw new Rejected(errors);
						const op: Op = {
							op: "transition", item: args.item, to: args.to,
							...(args.worker !== undefined ? { worker: args.worker } : {}),
							...(args.commit !== undefined ? { commit: known.full ?? args.commit } : {}),
							...(args.reason !== undefined ? { reason: args.reason } : {}),
						};
						return { ops: [op], result: (state) => ({ item: state.items.find((candidate) => candidate.id === args.item), progress: summary(state, now()) }) };
					});
				},
			),
			tool(
				"run_check",
				"Run one configured check of an item in a git work tree (cwd) that sits exactly at commit with no tracked changes. The exit code, duration and output hash are recorded; only exit 0 on an unchanged clean tree passes.",
				Type.Object({
					ledger: ledgerId,
					item: itemId,
					check: Type.String({ pattern: ID.source }),
					commit: Type.String({ pattern: COMMIT.source }),
					cwd: Type.String({ minLength: 1, description: "Work tree to run in; relative to the conversation's directory" }),
				}, { additionalProperties: false }),
				async (args, call) => {
					const who = actor(call);
					const { ledger } = await store.load(args.ledger);
					owned(ledger, who);
					const item = ledger.items.find((candidate) => candidate.id === args.item);
					if (!item) throw new Rejected([`unknown item ${args.item}`]);
					if (TERMINAL.has(item.status)) throw new Rejected([`${item.id} is ${item.status}`]);
					const spec = ledger.checks[args.check];
					if (!spec) throw new Rejected([`unknown check ${args.check}; configured: ${Object.keys(ledger.checks).join(", ") || "none"}`]);
					if (ledger.repo !== undefined && !(await commitFacts(ledger.repo, args.commit, undefined, call.signal)).exists) throw new Rejected([`commit ${args.commit} does not exist in ${ledger.repo}`]);
					const cwd = resolve(call.cwd ?? process.cwd(), args.cwd);
					if (within(store.root, cwd)) throw new Rejected(["a check may not run inside the ledger storage"]);
					const result = await runCheck(args.check, spec, cwd, args.commit, now, call.signal);
					return await store.mutate(args.ledger, who, now, async (current) => {
						if (!current) throw new Rejected([`unknown ledger ${args.ledger}`]);
						return { ops: [{ op: "check_run", item: args.item, run: result }], result: () => result };
					});
				},
				false,
				RUN_CHECK_MAX_MS,
			),
			tool(
				"record_decision",
				"Append a numbered decision (D1, D2, ...). Decisions are append-only.",
				Type.Object({ ledger: ledgerId, text: Type.String({ minLength: 1, maxLength: 4000 }), items: Type.Optional(Type.Array(itemId)) }, { additionalProperties: false }),
				async (args, call) => {
					const who = actor(call);
					return await store.mutate(args.ledger, who, now, async (current) => {
						if (!current) throw new Rejected([`unknown ledger ${args.ledger}`]);
						owned(current.ledger, who);
						const unknown = (args.items ?? []).filter((id) => !current.ledger.items.some((item) => item.id === id));
						if (unknown.length) throw new Rejected(unknown.map((id) => `unknown item ${id}`));
						return { ops: [{ op: "decision", text: args.text, items: args.items ?? [] }], result: (state) => state.decisions.at(-1) };
					});
				},
			),
			tool(
				"set_status",
				"Set the ledger active, paused (stops the turn-end dispatch rule) or closed (only when every item is done or excluded).",
				Type.Object({ ledger: ledgerId, status: Type.Union(LEDGER_STATUSES.map((status) => Type.Literal(status))), reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })) }, { additionalProperties: false }),
				async (args, call) => {
					const who = actor(call);
					return await store.mutate(args.ledger, who, now, async (current) => {
						if (!current) throw new Rejected([`unknown ledger ${args.ledger}`]);
						owned(current.ledger, who);
						const errors: string[] = [];
						if (current.ledger.status === "closed") errors.push(`ledger ${args.ledger} is closed`);
						if (args.status === "paused" && !args.reason) errors.push("paused needs a reason");
						const open = current.ledger.items.filter((item) => !TERMINAL.has(item.status)).map((item) => item.id);
						if (args.status === "closed" && open.length) errors.push(`cannot close with open items: ${open.join(", ")}`);
						if (errors.length) throw new Rejected(errors);
						return { ops: [{ op: "ledger_status", status: args.status, ...(args.reason ? { reason: args.reason } : {}) }], result: (state) => summary(state, now()) };
					});
				},
			),
			tool("status", "Progress, ready frontier, doing items with workers, blocked items, critical path and an ETA computed from recorded timestamps, plus the turn-end findings for this conversation.", Type.Object({ ledger: ledgerId }, { additionalProperties: false }), async (args, call) => {
				const { ledger } = await store.load(args.ledger);
				const subagents = call.subagents ? await call.subagents() : undefined;
				return { ...summary(ledger, now()), findings: subagents && call.conversationId === ledger.owner ? turnFindings(ledger, subagents) : [] };
			}, true),
			tool("verify", "Recheck a ledger file: hash chain, replay, and that every done item still has its commit and passing required checks.", Type.Object({ ledger: ledgerId }, { additionalProperties: false }), async (args, call) => {
				const { ledger, events } = await store.load(args.ledger);
				const problems: string[] = [];
				for (const item of ledger.items.filter((candidate) => candidate.status === "done")) {
					const revisit = { ...ledger, status: "active" as const, items: ledger.items.map((other) => (other.id === item.id ? { ...other, status: "review" as const } : other)) };
					const known = await facts(ledger, call, item.commit, "done");
					problems.push(...transitionErrors(revisit, { item: item.id, to: "done" }, { ...(known.commit ? { commit: known.commit } : {}) }));
				}
				return { ledger: ledger.id, events: events.length, head: events.at(-1)?.hash, chain: "ok", problems };
			}, true),
			tool(
				"export_markdown",
				"Write a human-readable Markdown view of the ledger to path (relative to the conversation's directory). The file is a view; the ledger stays authoritative.",
				Type.Object({ ledger: ledgerId, path: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
				async (args, call) => {
					const { ledger } = await store.load(args.ledger);
					const path = resolve(call.cwd ?? process.cwd(), args.path);
					if (within(store.root, path)) throw new Rejected(["the Markdown view may not be written inside the ledger storage"]);
					await mkdir(dirname(path), { recursive: true });
					await writeFile(path, renderMarkdown(ledger, now()), "utf8");
					return { path };
				},
			),
		];

		/** Owner of every ledger seen intact, so a later integrity failure still reaches its PM. */
		const owners = new Map<string, string>();
		return {
			tools,
			prompt: PROMPT,
			storagePaths: [root],
			async onTurnEnd(turn: PluginTurnEnd): Promise<string | undefined> {
				const lines: string[] = [];
				for (const id of await store.ids()) {
					let ledger: Ledger;
					try {
						ledger = (await store.load(id)).ledger;
						owners.set(id, ledger.owner);
					} catch (error) {
						if (owners.get(id) === turn.conversationId) lines.push(`- ledger ${id}: integrity: ${error instanceof Error ? error.message : String(error)}`);
						continue;
					}
					if (ledger.owner !== turn.conversationId) continue;
					const findings = turnFindings(ledger, turn.subagents as readonly PluginSubagent[]);
					if (findings.length) lines.push(`- ledger ${id} (${ledger.title}):`, ...findings.map((finding) => `  - [${finding.rule}] ${finding.text}`));
				}
				if (!lines.length) return undefined;
				return ["The pm ledger is not settled, so this turn does not end yet:", ...lines, "Resolve each finding with the pm tools (or pause the ledger with a reason), then continue."].join("\n");
			},
		};
	},
});
