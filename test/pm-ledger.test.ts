import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEMODE_LIMITS } from "../src/core/codemode/protocol.ts";
import { type Event, type Ledger, progress, reduce, transitionErrors, turnFindings, addItemsErrors, CHECK_TIMEOUT_MAX_SEC, checkTimeoutSec } from "../src/plugins/pm/model.ts";
import { pmPlugin, RUN_CHECK_MAX_MS } from "../src/plugins/pm/index.ts";
import { loadPlugin, type LoadedPlugin, type PluginSubagent, type PluginToolCall } from "../src/plugins/types.ts";

/**
 * ADR 0105 pm ledger: every rule that decides whether an item may move is a pure function of the ledger and host facts
 * (subagents, git), so it is enforced mechanically instead of by the model's judgement.
 */
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
const temp = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };

const HOUR = 3_600_000;
function ledgerOf(items: { id: string; deps?: string[]; status?: Ledger["items"][number]["status"]; worker?: string; startedAt?: number; doneAt?: number }[], extra: Partial<Ledger> = {}): Ledger {
	return {
		id: "L", title: "t", owner: "1", status: "active", wipLimit: 2, checks: { tc: { command: "x", timeoutSec: 10 } }, defaultChecks: ["tc"], decisions: [], createdAt: 0,
		items: items.map((item) => ({ id: item.id, title: item.id, deps: item.deps ?? [], status: item.status ?? "todo", runs: [], createdAt: 0, ...(item.worker ? { worker: item.worker } : {}), ...(item.startedAt !== undefined ? { startedAt: item.startedAt } : {}), ...(item.doneAt !== undefined ? { doneAt: item.doneAt } : {}) })),
		...extra,
	};
}
const running = (taskId: string): PluginSubagent => ({ taskId, status: "running", description: "", background: true });
const finished = (taskId: string): PluginSubagent => ({ taskId, status: "completed", description: "", background: true });

describe("transition guards", () => {
	test("doing needs a running subagent, finished dependencies and a free WIP slot", () => {
		const ledger = ledgerOf([{ id: "A" }, { id: "B", deps: ["A"] }, { id: "C" }, { id: "D", status: "doing", worker: "w1" }, { id: "E", status: "doing", worker: "w2" }]);
		expect(transitionErrors(ledger, { item: "A", to: "doing" }, {}).join()).toContain("needs worker");
		expect(transitionErrors(ledger, { item: "A", to: "doing", worker: "ghost" }, { subagents: [] }).join()).toContain("not a subagent");
		expect(transitionErrors(ledger, { item: "A", to: "doing", worker: "w9" }, { subagents: [finished("w9")] }).join()).toContain("completed, not running");
		expect(transitionErrors(ledger, { item: "B", to: "doing", worker: "w3" }, { subagents: [running("w3")] }).join()).toContain("dependencies not done: A");
		expect(transitionErrors(ledger, { item: "A", to: "doing", worker: "w3" }, { subagents: [running("w3")] }).join()).toContain("WIP limit 2");
		expect(transitionErrors(ledger, { item: "A", to: "doing", worker: "w1" }, { subagents: [running("w1")] }).join()).toContain("already holds D");
		const roomy = { ...ledger, wipLimit: 5 };
		expect(transitionErrors(roomy, { item: "A", to: "doing", worker: "w3" }, { subagents: [running("w3")] })).toEqual([]);
	});

	test("done needs an existing reachable commit, a settled worker and a passing run of every required check on that commit", () => {
		const base = ledgerOf([{ id: "A", status: "doing", worker: "w1" }], { repo: "/r", integrationRef: "origin/main" });
		expect(transitionErrors(base, { item: "A", to: "done" }, {}).join()).toContain("needs the commit");
		expect(transitionErrors(base, { item: "A", to: "done", commit: "abc1234" }, { commit: { exists: false } }).join()).toContain("does not exist");
		expect(transitionErrors(base, { item: "A", to: "done", commit: "abc1234" }, { commit: { exists: true, reachable: false } }).join()).toContain("not reachable from origin/main");
		expect(transitionErrors(base, { item: "A", to: "done", commit: "abc1234" }, { subagents: [running("w1")], commit: { exists: true, reachable: true } }).join()).toContain("still running");
		const facts = { subagents: [finished("w1")], commit: { exists: true, reachable: true } };
		expect(transitionErrors(base, { item: "A", to: "done", commit: "abc1234" }, facts).join()).toContain("required check tc has no run on abc1234");
		const run = (commit: string, passed: boolean) => ({ check: "tc", commit, exitCode: passed ? 0 : 1, passed, at: 1, durationMs: 1, outputSha256: "", outputTail: "" });
		const withRuns = (runs: ReturnType<typeof run>[]) => ({ ...base, items: base.items.map((item) => ({ ...item, runs })) });
		expect(transitionErrors(withRuns([run("fff0000", true)]), { item: "A", to: "done", commit: "abc1234" }, facts).join()).toContain("has no run on abc1234");
		expect(transitionErrors(withRuns([run("abc1234ffff", true), run("abc1234ffff", false)]), { item: "A", to: "done", commit: "abc1234" }, facts).join()).toContain("did not pass");
		expect(transitionErrors(withRuns([run("abc1234ffff", false), run("abc1234ffff", true)]), { item: "A", to: "done", commit: "abc1234" }, facts)).toEqual([]);
	});

	test("final states stay final, unknown edges are rejected and requeue/block need reasons", () => {
		const ledger = ledgerOf([{ id: "A", status: "done" }, { id: "B" }, { id: "C", status: "doing", worker: "w" }]);
		expect(transitionErrors(ledger, { item: "A", to: "doing", worker: "w" }, {}).join()).toContain("none, final");
		expect(transitionErrors(ledger, { item: "B", to: "done", commit: "abc1234" }, {}).join()).toContain("todo -> done is not an allowed transition");
		expect(transitionErrors(ledger, { item: "C", to: "todo" }, {}).join()).toContain("needs a reason");
		expect(transitionErrors(ledger, { item: "C", to: "blocked", reason: "server down" }, {})).toEqual([]);
		expect(transitionErrors({ ...ledger, status: "paused" }, { item: "C", to: "blocked", reason: "x" }, {}).join()).toContain("is paused");
	});

	test("items are unique, dependencies exist and stay acyclic", () => {
		const ledger = ledgerOf([{ id: "A" }]);
		expect(addItemsErrors(ledger, [{ id: "A" }]).join()).toContain("duplicate item A");
		expect(addItemsErrors(ledger, [{ id: "B", deps: ["Z"] }]).join()).toContain("unknown dependency Z");
		expect(addItemsErrors(ledger, [{ id: "B", deps: ["C"] }, { id: "C", deps: ["B"] }]).join()).toContain("dependency cycle");
		expect(addItemsErrors(ledger, [{ id: "B", checks: ["lint"] }]).join()).toContain("unknown check lint");
		expect(addItemsErrors(ledger, [{ id: "B", deps: ["A"] }, { id: "C", deps: ["B"] }])).toEqual([]);
	});
});

describe("turn-end findings and progress", () => {
	test("a finished worker, a vanished worker, idle capacity and an all-final ledger are each found", () => {
		const ledger = ledgerOf([{ id: "A", status: "doing", worker: "w1" }, { id: "B", status: "doing", worker: "gone" }, { id: "C" }]);
		const rules = turnFindings(ledger, [finished("w1")]).map((finding) => finding.rule);
		expect(rules).toEqual(["unrecorded_worker", "orphan_doing"]);
		const idle = ledgerOf([{ id: "A", status: "doing", worker: "w1" }, { id: "C" }, { id: "D", deps: ["C"] }]);
		const found = turnFindings(idle, [running("w1")]);
		expect(found.map((finding) => finding.rule)).toEqual(["idle_capacity"]);
		expect(found[0]!.text).toContain("1/2 workers running and 1 items are ready (C)");
		expect(turnFindings(ledgerOf([{ id: "A", status: "doing", worker: "w1" }, { id: "B", status: "doing", worker: "w2" }, { id: "C" }]), [running("w1"), running("w2")])).toEqual([]);
		expect(turnFindings(ledgerOf([{ id: "A", status: "done" }]), []).map((finding) => finding.rule)).toEqual(["all_final"]);
		expect(turnFindings({ ...idle, status: "paused" }, [])).toEqual([]);
	});

	test("ETA is remaining over recent throughput, floored by critical path times median duration", () => {
		const now = 100 * HOUR;
		const done = [0, 1, 2, 3].map((n) => ({ id: `D${n}`, status: "done" as const, startedAt: now - (n + 2) * HOUR, doneAt: now - (n + 1) * HOUR }));
		const ledger = ledgerOf([...done, { id: "A" }, { id: "B", deps: ["A"] }, { id: "C", deps: ["B"] }, { id: "E" }]);
		const p = progress(ledger, now, 6);
		expect(p.percentDone).toBe(50);
		expect(p.criticalPath).toBe(3);
		expect(p.eta!.throughputPerHour).toBeCloseTo(4 / 6, 2);
		// 4 remaining / (4/6 per hour) = 6h beats 3 x 1h median.
		expect(p.eta!.hours).toBe(6);
		// Six 2h items finished in the window: 1 per hour, median 2h. A 4-item chain needs 8h although 4 / 1 = 4h.
		const quick = Array.from({ length: 6 }, (_, n) => ({ id: `Q${n}`, status: "done" as const, startedAt: now - 3 * HOUR, doneAt: now - HOUR }));
		const chain = ledgerOf([...quick, ...Array.from({ length: 4 }, (_, n) => ({ id: `C${n}`, ...(n ? { deps: [`C${n - 1}`] } : {}) }))]);
		const eta = progress(chain, now, 6).eta!;
		expect(eta.basis).toContain("critical path 4");
		expect(eta.hours).toBe(8);
	});
});

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}
function repoFixture() {
	const repo = temp("pm-repo-");
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@example.com");
	git(repo, "config", "user.name", "t");
	writeFileSync(join(repo, "a.txt"), "1\n");
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "one");
	const first = git(repo, "rev-parse", "HEAD");
	git(repo, "checkout", "-q", "-b", "side");
	writeFileSync(join(repo, "a.txt"), "2\n");
	git(repo, "commit", "-q", "-am", "two");
	const side = git(repo, "rev-parse", "HEAD");
	git(repo, "checkout", "-q", "main");
	return { repo, first, side };
}

async function loaded(root: string): Promise<LoadedPlugin> {
	const plugin = await loadPlugin(pmPlugin, { root });
	if (Array.isArray(plugin)) throw new Error(plugin.join("; "));
	return plugin;
}
function caller(plugin: LoadedPlugin, base: PluginToolCall) {
	return async (name: string, args: unknown, override: Partial<PluginToolCall> = {}) => {
		const tool = plugin.tools.find((candidate) => candidate.name === `pm_${name}`);
		if (!tool) throw new Error(`no tool pm_${name}`);
		return await tool.execute(args, { ...base, ...override }) as Record<string, unknown>;
	};
}

describe("plugin tools against a real git repository", () => {
	test("the full item lifecycle is checked against git, the worker, the owner and real check runs", async () => {
		const { repo, first, side } = repoFixture();
		const plugin = await loaded(temp("pm-root-"));
		let agents: PluginSubagent[] = [running("w1")];
		const call = caller(plugin, { conversationId: "7", cwd: repo, subagents: async () => agents });
		await call("create_ledger", { id: "port", title: "Port", repo, integrationRef: "main", wipLimit: 2, checks: { ok: { command: "git --version", timeoutSec: 60 }, bad: { command: "git no-such-command", timeoutSec: 60 } }, defaultChecks: ["ok"] });
		await call("add_items", { ledger: "port", items: [{ id: "A", title: "first" }, { id: "B", title: "second", deps: ["A"], checks: ["ok", "bad"] }] });
		await expect(call("transition", { ledger: "port", item: "A", to: "doing", worker: "w1" }, { conversationId: "8" })).rejects.toThrow("only its PM conversation");
		await call("transition", { ledger: "port", item: "A", to: "doing", worker: "w1" });
		await expect(call("transition", { ledger: "port", item: "A", to: "review", commit: first })).rejects.toThrow("still running");
		agents = [finished("w1")];
		await expect(call("transition", { ledger: "port", item: "A", to: "done", commit: "deadbeef" })).rejects.toThrow("does not exist");
		await expect(call("transition", { ledger: "port", item: "A", to: "done", commit: side })).rejects.toThrow("not reachable from main");
		await expect(call("transition", { ledger: "port", item: "A", to: "done", commit: first })).rejects.toThrow("required check ok has no run");
		writeFileSync(join(repo, "a.txt"), "dirty\n");
		await expect(call("run_check", { ledger: "port", item: "A", check: "ok", commit: first, cwd: "." })).rejects.toThrow("uncommitted tracked changes");
		git(repo, "checkout", "-q", "--", "a.txt");
		await expect(call("run_check", { ledger: "port", item: "A", check: "ok", commit: side, cwd: "." })).rejects.toThrow("not " + side);
		const run = await call("run_check", { ledger: "port", item: "A", check: "ok", commit: first, cwd: "." });
		expect(run.passed).toBe(true);
		expect(run.commit).toBe(first);
		const done = await call("transition", { ledger: "port", item: "A", to: "done", commit: first.slice(0, 10) });
		expect((done.item as { commit: string }).commit).toBe(first);

		agents = [running("w2")];
		await call("transition", { ledger: "port", item: "B", to: "doing", worker: "w2" });
		agents = [finished("w2")];
		const failed = await call("run_check", { ledger: "port", item: "B", check: "bad", commit: first, cwd: "." });
		expect(failed.passed).toBe(false);
		await call("run_check", { ledger: "port", item: "B", check: "ok", commit: first, cwd: "." });
		await expect(call("transition", { ledger: "port", item: "B", to: "done", commit: first })).rejects.toThrow("latest run of required check bad");
		await call("record_decision", { ledger: "port", text: "B ships without the bad check", items: ["B"] });
		await expect(call("set_status", { ledger: "port", status: "closed" })).rejects.toThrow("open items: B");

		const status = await call("status", { ledger: "port" });
		expect(status.percentDone).toBe(50);
		expect((status.findings as { rule: string }[]).map((finding) => finding.rule)).toEqual(["unrecorded_worker"]);
		const verified = await call("verify", { ledger: "port" });
		expect(verified.problems).toEqual([]);
		const md = await call("export_markdown", { ledger: "port", path: "LEDGER.md" });
		expect(readFileSync(md.path as string, "utf8")).toContain("| A | first |  |  | done |");
	}, 60_000);

	test("an edit outside the tools breaks the hash chain and is reported to the owner at turn end", async () => {
		const root = temp("pm-root-");
		const plugin = await loaded(root);
		const call = caller(plugin, { conversationId: "7", subagents: async () => [] });
		await call("create_ledger", { id: "x", title: "X" });
		await call("add_items", { ledger: "x", items: [{ id: "A", title: "a" }] });
		const turn = { conversationId: "7", subagents: [], openHumanAsks: 0, runningDagRuns: 0 };
		expect(await plugin.onTurnEnd!(turn)).toContain("[idle_capacity]");
		expect(await plugin.onTurnEnd!({ ...turn, conversationId: "8" })).toBeUndefined();
		const path = join(root, "x.json");
		const file = JSON.parse(readFileSync(path, "utf8")) as { events: Event[] };
		(file.events[1] as unknown as { items: { title: string }[] }).items[0]!.title = "forged";
		writeFileSync(path, JSON.stringify(file));
		await expect(call("status", { ledger: "x" })).rejects.toThrow("hash mismatch");
		expect(await plugin.onTurnEnd!(turn)).toContain("integrity: event 2: hash mismatch");
	});

	test("replay is the only state: reducing the recorded events gives the tool's view", async () => {
		const root = temp("pm-root-");
		const plugin = await loaded(root);
		const call = caller(plugin, { conversationId: "7", subagents: async () => [running("w")] });
		await call("create_ledger", { id: "y", title: "Y", wipLimit: 1 });
		await call("add_items", { ledger: "y", items: [{ id: "A", title: "a" }, { id: "B", title: "b" }] });
		await call("transition", { ledger: "y", item: "A", to: "doing", worker: "w" });
		await expect(call("transition", { ledger: "y", item: "B", to: "doing", worker: "w" })).rejects.toThrow();
		const events = (JSON.parse(readFileSync(join(root, "y.json"), "utf8")) as { events: Event[] }).events;
		expect(events.map((event) => event.op)).toEqual(["create", "add_items", "transition"]);
		const state = events.reduce<Ledger | undefined>((current, event) => reduce(current, event), undefined)!;
		expect(state.items.map((item) => `${item.id}:${item.status}`)).toEqual(["A:doing", "B:todo"]);
	});
});

test("the public catalog loads PM only when configured and its tools own a real ledger", async () => {
	const { parseManifest } = await import("../src/manifest.ts");
	const { pluginCatalog } = await import("../src/plugins/index.ts");
	const dataDir = temp("pm-manifest-");
	const raw = { bot: { enabled: false, dataDir, model: { provider: "faux", modelId: "faux-1" }, toolMode: "direct" }, channels: {}, plugins: { image_gen: false, web: false } };
	const catalogs = { channels: {}, plugins: pluginCatalog };
	expect((await parseManifest(raw, catalogs)).plugins.some((plugin) => plugin.id === "pm")).toBe(false);
	const parsed = await parseManifest({ ...raw, plugins: { ...raw.plugins, pm: {} } }, catalogs);
	const pm = parsed.plugins.find((plugin) => plugin.id === "pm")!;
	const call = caller(pm, { conversationId: "catalog-owner", subagents: async () => [] });
	await call("create_ledger", { id: "configured", title: "Configured PM" });
	expect((await call("status", { ledger: "configured" })).owner).toBe("catalog-owner");
	expect(pm.storagePaths).toEqual([join(dataDir, "pm")]);
});

describe("check run time fits a codemode cell", () => {
	test("pm_run_check declares a run time above the check ceiling and inside the codemode cell ceiling", async () => {
		const plugin = await loaded(temp("pm-root-"));
		const tool = plugin.tools.find((candidate) => candidate.name === "pm_run_check");
		expect(tool?.maxDurationMs).toBe(RUN_CHECK_MAX_MS);
		expect(RUN_CHECK_MAX_MS).toBeGreaterThan(CHECK_TIMEOUT_MAX_SEC * 1000);
		expect(RUN_CHECK_MAX_MS).toBeLessThanOrEqual(CODEMODE_LIMITS.maxTimeoutMs);
	});
	test("create_ledger rejects a check timeout the cell could not wait for, and older ledgers are capped", async () => {
		const plugin = await loaded(temp("pm-root-"));
		const call = caller(plugin, { conversationId: "1" } as PluginToolCall);
		await expect(call("create_ledger", { id: "slow", title: "t", checks: { tc: { command: "x", timeoutSec: CHECK_TIMEOUT_MAX_SEC + 1 } } })).rejects.toThrow("invalid arguments");
		const created = await call("create_ledger", { id: "fast", title: "t", checks: { tc: { command: "x" } } });
		expect(created).toBeDefined();
		expect(checkTimeoutSec({ command: "x", timeoutSec: 7200 })).toBe(CHECK_TIMEOUT_MAX_SEC);
		expect(checkTimeoutSec({ command: "x", timeoutSec: 60 })).toBe(60);
	});
});
