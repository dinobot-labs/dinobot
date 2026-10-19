import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { skillsCommand } from "../src/commands/skills.ts";
import type { CommandIO, CommandInvocation } from "../src/commands/types.ts";
import { openBot, type Bot } from "../src/core/bot.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { SkillFinalizationSummaryDoc } from "../src/core/skills/confirmation.ts";

const context = BACKGROUND_CONTEXT;

test("operational status renders each durable finalization reason once", async () => {
	// Given a real bot with a durable refusal diagnostic, not prose pinned in a test.
	const bot = await openBot({
		storage: new MemoryStorage(), models: createModels(), defaultModel: { provider: "faux", modelId: "one" },
		plugins: [], toolMode: "direct",
	}, context);
	const sentinel = "E_FINALIZATION_FIXTURE";
	try {
		await bot.harness.commit(async (tx) => {
			(await tx.doc(SkillFinalizationSummaryDoc)).latest = {
				jobId: "fixture-job", evidenceId: "fixture-evidence",
				status: "not-published", reason: sentinel, publicationId: null,
			};
		}, context);
		const output: string[] = [];
		// When the existing command renderer displays the operational state.
		await skillsCommand(bot).run("evolution status", {
			surface: "tui", channel: "tui", threadKey: "main", userId: "local", context,
			io: {
				signal: new AbortController().signal, interactive: false,
				print: (text) => { output.push(text); }, notify() {}, state() {},
				prompt: async () => { throw new Error("Unexpected prompt"); },
			},
		});
		// Then the machine-supplied reason is not duplicated by the presentation.
		expect(output.join("\n").split(sentinel).length - 1).toBe(1);
	} finally {
		await bot.close(context);
	}
});

function setup() {
	const calls: { method: string; args: unknown[] }[] = [];
	const events: string[] = [];
	const output: string[] = [];
	const abort = new AbortController();
	const proposal = { proposalId: "p1", name: "review", operation: "edit", status: "approved", expectedGeneration: 2, version: "v3" };
	const diff = { ...proposal, before: "old instructions", after: "new instructions" };
	let summaries = [{ name: "review", description: "Live skill", generation: 2, version: "v2", source: "managed", modified: true }];
	const record = (method: string, args: unknown[]) => {
		calls.push({ method, args });
		events.push(method);
	};
	const skills = {
		async list(...args: unknown[]) { record("list", args); return summaries; },
		async pending(...args: unknown[]) { record("pending", args); return [{ ...proposal, candidate: { body: "private candidate instructions" }, actor: "proposer" }]; },
		async diff(...args: unknown[]) { record("diff", args); return diff; },
		async history(...args: unknown[]) { record("history", args); return [{ version: "v1" }]; },
		async reject(...args: unknown[]) { record("reject", args); },
		async publish(...args: unknown[]) { record("publish", args); return { name: "review", generation: 3, version: "v3" }; },
	};
	const curation = {
		async status(...args: unknown[]) {
			record("status", args);
			return { skills: summaries.map((summary) => ({ name: summary.name, provenance: "agent", lifecycle: "active" })) };
		},
	};
	const io: CommandIO = {
		signal: abort.signal,
		interactive: false,
		print(text) { output.push(text); events.push("output"); },
		notify() {},
		state() {},
		async prompt() { throw new Error("must not ask for owner approval"); },
	};
	const invocation: CommandInvocation = { surface: "tui", channel: "tui", threadKey: "main", userId: "untrusted-request-user", context, io };
	const command = skillsCommand({ skills, curation } as unknown as Bot);
	return { command, invocation, io, calls, output, events, abort, diff, proposal, setSummaries(value: typeof summaries) { summaries = value; } };
}

test("skills lists the current store on every invocation rather than a plugin snapshot", async () => {
	const f = setup();
	const context = expect.objectContaining({ abortSignal: f.io.signal });
	// A non-interactive TUI invocation prints the text list instead of opening the checklist.
	await f.command.run("", f.invocation);
	expect(f.output[0]).toContain("[x] review  agent");
	expect(f.output[0]).toContain("Live skill");
	expect(f.output[0]).toContain("enabled 1/1");
	f.setSummaries([]);
	await f.command.run("  ", f.invocation);
	expect(f.output[1]).toBe("no skills loaded");
	expect(f.calls).toEqual([
		{ method: "list", args: [context] }, { method: "status", args: [context] },
		{ method: "list", args: [context] }, { method: "status", args: [context] },
	]);
	expect(f.command.usage).toContain("publish <id>");
	expect(f.command.usage).not.toContain("approve");
});

test("channels can inspect unpublished proposals, exact diffs and history", async () => {
	const f = setup();
	const context = expect.objectContaining({ abortSignal: f.io.signal });
	const invocation = { ...f.invocation, surface: "channel" as const };
	await f.command.run("pending", invocation);
	await f.command.run("diff p1", invocation);
	await f.command.run("history review", invocation);
	expect(f.output.map((text) => JSON.parse(text))).toEqual([[f.proposal], f.diff, [{ version: "v1" }]]);
	expect(f.output[0]).not.toContain("private candidate instructions");
	expect(f.output[0]).not.toContain("candidate");
	expect(f.output[0]).not.toContain("actor");
	expect(f.calls).toEqual([
		{ method: "pending", args: [context] },
		{ method: "diff", args: ["p1", context] },
		{ method: "history", args: ["review", context] },
	]);
});

test("manual publication and rejection commands remain local TUI operations", async () => {
	const f = setup();
	for (const action of ["publish", "reject"]) {
		await expect(f.command.run(`${action} p1`, { ...f.invocation, surface: "channel", userId: "local-owner" })).rejects.toThrow("local TUI");
	}
	expect(f.calls).toEqual([]);
	expect(f.events).toEqual([]);
});

test("publication displays the diff and publishes without an interactive approval prompt", async () => {
	const f = setup();
	const context = expect.objectContaining({ abortSignal: f.io.signal });
	await f.command.run("publish p1", f.invocation);
	expect(f.events).toEqual(["diff", "output", "publish", "output"]);
	expect(JSON.parse(f.output[0]!)).toEqual(f.diff);
	expect(f.calls.slice(1)).toEqual([
		{ method: "publish", args: [{ proposalId: "p1", requestId: "command:publish:p1" }, "local-owner", context] },
	]);
	await f.command.run("publish p1", f.invocation);
	expect(f.calls.filter((call) => call.method === "publish").map((call) => call.args[0])).toEqual([
		{ proposalId: "p1", requestId: "command:publish:p1" },
		{ proposalId: "p1", requestId: "command:publish:p1" },
	]);
});

test("lost-response retry of a published proposal does not mutate or reactivate it", async () => {
	const f = setup();
	f.diff.status = "published";
	await f.command.run("publish p1", f.invocation);
	expect(f.calls.map((call) => call.method)).toEqual(["diff"]);
	expect(f.output).toEqual(["skill proposal p1 already published; current active version unchanged"]);
});

test("abort after displaying the diff never publishes", async () => {
	const f = setup();
	f.io.print = () => { f.abort.abort(); };
	await expect(f.command.run("publish p1", f.invocation)).rejects.toThrow();
	expect(f.calls.map((call) => call.method)).toEqual(["diff"]);
});

test("local rejection uses the host actor without publishing", async () => {
	const f = setup();
	const context = expect.objectContaining({ abortSignal: f.io.signal });
	await f.command.run("reject p1", f.invocation);
	expect(f.calls).toEqual([{ method: "reject", args: ["p1", "local-owner", context] }]);
});

test("invalid syntax and removed approval command never touch the store", async () => {
	for (const args of ["unknown", "pending extra", "diff", "history", "publish", "reject", "publish p1 extra", "approve p1", "diff p1 extra", "list extra", "on", "off", "on a b", "unknown p1"]) {
		const f = setup();
		await expect(f.command.run(args, f.invocation)).rejects.toThrow("usage: /skills");
		expect(f.calls).toEqual([]);
	}
});

test("already-aborted mutations cannot touch state", async () => {
	const f = setup();
	f.abort.abort();
	for (const action of ["publish", "reject"]) {
		await expect(f.command.run(`${action} p1`, f.invocation)).rejects.toThrow();
	}
	expect(f.calls).toEqual([]);
});

function curationSetup() {
	const calls: { method: string; args: unknown[] }[] = [];
	const output: string[] = [];
	const report = { at: 0, run: 1, dryRun: false, threshold: 149, minIdleMs: 14 * 86_400_000, alpha: 0.05, pMax: 0.02, skills: [{ name: "agent-flow", provenance: "agent", state: "stale", run: 80, uses: 0, exposures: 80, idleMs: 86_400_000, action: "none", reason: null }] };
	const curation = {
		async status(...args: unknown[]) {
			calls.push({ method: "status", args });
			return {
				config: { enabled: true, alpha: 0.05, pMax: 0.02, minIdleMs: 14 * 86_400_000, settleMs: 3_600_000, intervalMs: 21_600_000, includeUser: false, includeBundled: false, threshold: 149 },
				lastRunAt: null, runs: 0, lastReport: null, archived: ["old-flow"],
				skills: [
					{ name: "agent-flow", provenance: "agent", lifecycle: "active", pinned: true, state: "active", activationGeneration: 2, activatedAt: 0, archivedAt: null, reason: null, lastRun: null },
					{ name: "old-flow", provenance: "agent", lifecycle: "inactive", pinned: false, state: "archived", activationGeneration: 1, activatedAt: 0, archivedAt: 0, reason: "unused", lastRun: null },
				],
			};
		},
		async run(...args: unknown[]) { calls.push({ method: "run", args }); return { ...report, dryRun: (args[0] as { dryRun: boolean }).dryRun }; },
		async archive(...args: unknown[]) { calls.push({ method: "archive", args }); return { generation: 7 }; },
		async restore(...args: unknown[]) { calls.push({ method: "restore", args }); return { generation: 8 }; },
		async pin(...args: unknown[]) { calls.push({ method: "pin", args }); },
	};
	const io: CommandIO = {
		signal: new AbortController().signal, interactive: false,
		print(text) { output.push(text); }, notify() {}, state() {},
		async prompt() { throw new Error("must not prompt"); },
	};
	const invocation: CommandInvocation = { surface: "tui", channel: "tui", threadKey: "main", userId: "local", context, io };
	return { command: skillsCommand({ curation } as unknown as Bot), calls, output, invocation };
}

test("curator status, dry run and archived list are readable from channels", async () => {
	const f = curationSetup();
	const channel = { ...f.invocation, surface: "channel" as const };
	await f.command.run("curator", channel);
	await f.command.run("curator status", channel);
	await f.command.run("curator dry-run", channel);
	await f.command.run("archived", channel);
	expect(f.calls.map((call) => call.method)).toEqual(["status", "status", "run", "status"]);
	expect(f.calls[2]!.args[0]).toEqual({ dryRun: true });
	expect(f.output[0]).toContain("archive after 149 unused root exposures");
	expect(f.output[0]).toContain("agent-flow  agent  active  pinned");
	expect(f.output[0]).toContain("Archived: old-flow");
	expect(f.output[2]).toContain("dry run");
	expect(f.output[2]).toContain("agent-flow  agent  stale  run 80/149");
	expect(f.output[3]).toContain("old-flow");
	expect(f.output[3]).not.toContain("agent-flow");
	expect(f.command.usage).toContain("curator");
});

test("curator run, archive, restore, pin and unpin are local TUI mutations", async () => {
	const f = curationSetup();
	const channel = { ...f.invocation, surface: "channel" as const, userId: "local-owner" };
	for (const args of ["curator run", "archive agent-flow", "restore old-flow", "pin agent-flow", "unpin agent-flow"]) {
		await expect(f.command.run(args, channel)).rejects.toThrow("local TUI");
	}
	expect(f.calls).toEqual([]);
	await f.command.run("curator run", f.invocation);
	await f.command.run("archive agent-flow", f.invocation);
	await f.command.run("restore old-flow", f.invocation);
	await f.command.run("pin agent-flow", f.invocation);
	await f.command.run("unpin agent-flow", f.invocation);
	expect(f.calls.map((call) => call.method)).toEqual(["run", "archive", "restore", "pin", "pin"]);
	expect(f.calls[0]!.args[0]).toEqual({ dryRun: false });
	expect(f.calls[1]!.args.slice(0, 2)).toEqual(["agent-flow", expect.objectContaining({ actor: "local-owner", requestId: expect.stringMatching(/^command:archive:/) })]);
	expect(f.calls[2]!.args.slice(0, 2)).toEqual(["old-flow", expect.objectContaining({ actor: "local-owner", requestId: expect.stringMatching(/^command:restore:/) })]);
	expect(f.calls[3]!.args.slice(0, 2)).toEqual(["agent-flow", true]);
	expect(f.calls[4]!.args.slice(0, 2)).toEqual(["agent-flow", false]);
	expect(f.output.slice(1)).toEqual([
		expect.stringContaining("archived skill agent-flow"), expect.stringContaining("restored skill old-flow"),
		expect.stringContaining("pinned skill agent-flow"), expect.stringContaining("unpinned skill agent-flow"),
	]);
});

test("invalid curation syntax never touches the curator", async () => {
	for (const args of ["curator bogus", "curator run extra", "archived extra", "archive", "restore", "pin", "unpin", "archive a b"]) {
		const f = curationSetup();
		await expect(f.command.run(args, f.invocation)).rejects.toThrow("usage: /skills");
		expect(f.calls).toEqual([]);
	}
});

test("TUI archive and restore change the default catalog of a real bot", async () => {
	const bot = await openBot({
		storage: new MemoryStorage(), models: createModels(), defaultModel: { provider: "faux", modelId: "one" },
		plugins: [], toolMode: "direct",
	}, context);
	try {
		await bot.curation.run({ dryRun: true }, context);
		const staged = await bot.skills.propose({ name: "agent-flow", description: "Agent flow", body: "Follow it.", files: {}, expectedGeneration: 0, requestId: "propose-agent-flow" }, "agent:1", context);
		await bot.skills.publish({ proposalId: staged.proposalId, requestId: "publish-agent-flow" }, "agent:1", context);
		const output: string[] = [];
		const io: CommandIO = { signal: new AbortController().signal, interactive: false, print(text) { output.push(text); }, notify() {}, state() {}, async prompt() { throw new Error("must not prompt"); } };
		const invocation: CommandInvocation = { surface: "tui", channel: "tui", threadKey: "main", userId: "local", context, io };
		const command = skillsCommand(bot);
		const names = async (key: string) => (await bot.skills.executionList((await bot.conversation("test", key, context)).id, context)).map((item) => item.name);
		await command.run("archive agent-flow", invocation);
		expect(await names("after-archive")).not.toContain("agent-flow");
		await command.run("archived", invocation);
		expect(output.at(-1)).toContain("agent-flow");
		await expect(command.run("archive debugging", invocation)).rejects.toThrow();
		await command.run("restore agent-flow", invocation);
		expect(await names("after-restore")).toContain("agent-flow");
		await command.run("pin agent-flow", invocation);
		expect((await bot.curation.status(context)).skills.find((item) => item.name === "agent-flow")?.pinned).toBe(true);
		await command.run("archived", invocation);
		expect(output.at(-1)).toBe("No archived skills.");
	} finally {
		await bot.close(context);
	}
});
