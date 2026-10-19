import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LSP_OPERATIONS, LspManager, type LspServerConfig } from "../src/core/lsp.ts";

const fixture = resolve(import.meta.dir, "fixtures/lsp-server.ts");
const managers: LspManager[] = [];
const directories: string[] = [];
type Snapshot = {
	sentinel: string; text: string; version: number; position: { line: number; character: number };
	documents: Record<string, { text: string; version: number }>;
	opens: number; changes: number; requests: number; active: number; maxActive: number; pid: number; events: string[];
};
type Status = { servers: { name: string; available: boolean; running: boolean; roots: unknown[] }[] };
type Diagnostic = { source: string; freshness: string; version: number; publishedVersion: number | null; diagnostics: unknown[] | null };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded<T>(promise: Promise<T>, ms = 4000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("test settlement deadline exceeded")), ms); })]);
	} finally { clearTimeout(timer); }
}
async function until(check: () => Promise<boolean>, ms = 3000) {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() >= deadline) throw new Error("fixture observation deadline exceeded");
		await pause(10);
	}
}
// The operation budget also covers spawning the fixture and initialize, which took over 2 s in a loaded full-suite run.
// Keep it above the test deadlines (bounded, bun's 5 s); timeout behavior is tested with an explicit short budget.
async function setup(mode = "normal", timeoutMs = 10_000) {
	const cwd = await mkdtemp(join(tmpdir(), "dinobot-lsp-test-"));
	directories.push(cwd);
	const path = join(cwd, "main.ts");
	const log = join(cwd, "wire.jsonl");
	await writeFile(path, "const sentinel = 1;\n");
	const config: LspServerConfig = { name: "fixture", command: [process.execPath, fixture, mode, log], extensions: [".ts"], languageId: "typescript", rootMarkers: [".fixture-root"] };
	const manager = new LspManager({ servers: [config], timeoutMs });
	managers.push(manager);
	return { cwd, path, log, manager };
}
async function snapshot(manager: LspManager, cwd: string, path: string, line = 1, character = 1): Promise<Snapshot> {
	const value = await bounded(manager.execute({ operation: "hover", path, line, character }, cwd));
	const envelope = value as { result: { contents: { value: string } } };
	const result = JSON.parse(envelope.result.contents.value) as Snapshot;
	expect(result.sentinel).toBe("fixture-hover");
	return result;
}
async function logs(path: string): Promise<{ event: string; pid: number }[]> {
	try { return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
async function expectDead(pid: number) {
	await until(async () => {
		try { process.kill(pid, 0); return false; }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
	});
}
afterEach(async () => {
	try { await Promise.all(managers.splice(0).map((manager) => bounded(manager.close()))); }
	finally { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); }
});

test("status reports installed executables without spawning and explicit servers replace defaults", async () => {
	const { manager, cwd, log } = await setup();
	const status = await manager.execute({ operation: "status" }, cwd) as Status;
	expect(status.servers.map((server) => server.name)).toEqual(["fixture"]);
	expect(status.servers[0]).toMatchObject({ available: true, running: false });
	expect(await logs(log)).toEqual([]);
	const empty = new LspManager({ servers: [] });
	managers.push(empty);
	expect((await empty.execute({ operation: "status" }, cwd) as Status).servers).toEqual([]);
	expect(LSP_OPERATIONS).toEqual(["status", "hover", "definition", "references", "document_symbols", "workspace_symbols", "diagnostics"]);
});

test("transport request-write failures reject once without an unhandled process rejection", async () => {
	const child = Bun.spawn([process.execPath, fixture, "write-failure"], { stdout: "pipe", stderr: "pipe" });
	try {
		const [exit, stdout, stderr] = await bounded(Promise.all([
			child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
		]));
		expect(exit).toBe(0);
		expect(stdout).toContain("request write rejection contained");
		expect(stderr).toBe("");
	} finally {
		if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
	}
});

test("missing executable is unavailable and semantic invocation fails instead of returning empty success", async () => {
	const { cwd, path } = await setup();
	const manager = new LspManager({ servers: [{ name: "missing", command: [join(cwd, "nonexistent-server")], extensions: [".ts"] }] });
	managers.push(manager);
	expect((await manager.execute({ operation: "status" }, cwd) as Status).servers[0]?.available).toBe(false);
	await expect(manager.execute({ operation: "hover", path, line: 1, character: 1 }, cwd)).rejects.toThrow(/unavailable|not (?:found|installed)|executable/i);
});

test("real stdio initializes before opening and round-trips every semantic operation", async () => {
	const { cwd, path, manager } = await setup();
	const first = await snapshot(manager, cwd, path);
	expect(first.text).toBe("const sentinel = 1;\n");
	expect(first.opens).toBe(1);
	expect(first.events.indexOf("initialize")).toBeLessThan(first.events.indexOf("initialized"));
	expect(first.events.indexOf("initialized")).toBeLessThan(first.events.indexOf("open"));
	expect(first.events.indexOf("open")).toBeLessThan(first.events.indexOf("hover"));
	for (const operation of ["definition", "references", "document_symbols", "workspace_symbols", "diagnostics"] as const) {
		const result = await manager.execute({ operation, path, line: 1, character: 1, query: "needle", server: "fixture" }, cwd);
		const text = JSON.stringify(result);
		expect(text).toContain(operation === "document_symbols" ? "fixture-document-symbol" : operation === "workspace_symbols" ? "fixture-workspace-symbol:needle" : operation === "diagnostics" ? "fixture-pull-diagnostic" : pathToFileURL(path).href);
	}
});

test.each(["normal", "incremental"])("%s sync increments version only when on-disk text changes", async (mode) => {
	const { cwd, path, manager } = await setup(mode);
	const first = await snapshot(manager, cwd, path);
	const same = await snapshot(manager, cwd, path);
	expect(same.version).toBe(first.version);
	expect(same.changes).toBe(0);
	await writeFile(path, "const emoji = '😀';\r\nconst other = 2;\r\n");
	const changed = await snapshot(manager, cwd, path);
	expect(changed.text).toBe(await readFile(path, "utf8"));
	expect(changed.version).toBe(first.version + 1);
	await writeFile(path, first.text);
	const reverted = await snapshot(manager, cwd, path);
	expect(reverted.text).toBe(first.text);
	expect(reverted.version).toBe(first.version + 2);
	expect(reverted.opens).toBe(1);
});

test("positions are one-based UTF-16 including CRLF and astral text", async () => {
	const { cwd, path, manager } = await setup();
	await writeFile(path, "😀x\r\nsecond\r\n");
	expect((await snapshot(manager, cwd, path, 1, 3)).position).toEqual({ line: 0, character: 2 });
	expect((await snapshot(manager, cwd, path, 2, 7)).position).toEqual({ line: 1, character: 6 });
	expect((await snapshot(manager, cwd, path, 3, 1)).position).toEqual({ line: 2, character: 0 });
	for (const [line, character] of [[0, 1], [1, 0], [-1, 1], [1, -1], [1.5, 1], [1, 1.5], [4, 1], [1, 5], [2, 8], [NaN, 1], [1, Infinity]] as const) {
		const error = await manager.execute({ operation: "hover", path, line, character }, cwd).then(() => null, (error: unknown) => error);
		expect(error).toBeInstanceOf(Error);
	}
});

test("every previously opened dependency is refreshed before the next request", async () => {
	const { cwd, path, manager } = await setup("incremental");
	const dependency = join(cwd, "dependency.ts");
	await writeFile(dependency, "export const value = 1;\n");
	const original = await snapshot(manager, cwd, dependency);
	await snapshot(manager, cwd, path);
	await writeFile(dependency, "export const value = 42;\n");
	const next = await snapshot(manager, cwd, path);
	expect(next.documents[pathToFileURL(dependency).href]).toEqual({ text: "export const value = 42;\n", version: original.version + 1 });
});

test("parallel requests serialize on one process", async () => {
	const { cwd, path, manager } = await setup("delayed");
	const results = await Promise.all(Array.from({ length: 5 }, () => snapshot(manager, cwd, path)));
	expect(new Set(results.map((result) => result.pid)).size).toBe(1);
	expect(results.map((result) => result.requests).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
	expect(results.every((result) => result.maxActive === 1 && result.opens === 1)).toBe(true);
});

test("cwd and discovered project roots isolate server processes", async () => {
	const { cwd, path, manager } = await setup();
	const base = await snapshot(manager, cwd, path);
	const roots: Snapshot[] = [];
	for (const name of ["left", "right"]) {
		const directory = join(cwd, name);
		await mkdir(directory);
		await writeFile(join(directory, ".fixture-root"), "");
		const child = join(directory, "child.ts");
		await writeFile(child, `const ${name} = 1;`);
		roots.push(await snapshot(manager, cwd, child));
	}
	expect(new Set([base.pid, ...roots.map((root) => root.pid)]).size).toBe(3);
	const other = await setup();
	const otherSnapshot = await snapshot(manager, other.cwd, other.path);
	expect(otherSnapshot.pid).not.toBe(base.pid);
});

test("already-aborted invocation never starts a server", async () => {
	const { cwd, path, manager, log } = await setup();
	const controller = new AbortController();
	controller.abort();
	await expect(manager.execute({ operation: "hover", path, line: 1, character: 1 }, cwd, controller.signal)).rejects.toThrow(/abort|cancel/i);
	expect(await logs(log)).toEqual([]);
});

test("in-flight cancellation settles, retires its process, and permits a new client", async () => {
	const { cwd, path, manager, log } = await setup("hang");
	const controller = new AbortController();
	const pending = manager.execute({ operation: "hover", path, line: 1, character: 1 }, cwd, controller.signal);
	const rejection = bounded(pending).then(() => null, (error: unknown) => error);
	await until(async () => (await logs(log)).some((entry) => entry.event === "hover"));
	const pid = (await logs(log))[0]!.pid;
	controller.abort();
	expect(String(await rejection)).toMatch(/abort|cancel/i);
	await expectDead(pid);
	await manager.execute({ operation: "document_symbols", path }, cwd);
	const pids = new Set((await logs(log)).filter((entry) => entry.event === "spawn").map((entry) => entry.pid));
	expect(pids.size).toBe(2);
});

test("request timeout settles and retires the hung process", async () => {
	const { cwd, path, manager, log } = await setup("hang", 500);
	const error = await bounded(manager.execute({ operation: "hover", path, line: 1, character: 1 }, cwd)).then(() => null, (error: unknown) => error);
	expect(String(error)).toMatch(/timed? ?out|timeout/i);
	const records = await logs(log);
	expect(records.some((entry) => entry.event === "hover")).toBe(true);
	await expectDead(records[0]!.pid);
	await manager.execute({ operation: "document_symbols", path }, cwd);
	expect(new Set((await logs(log)).map((entry) => entry.pid)).size).toBe(2);
});

test("cancelled queue waiters settle without cancelling the active request; close prevents queued starts", async () => {
	const { cwd, path, manager, log } = await setup("hang");
	const active = manager.execute({ operation: "hover", path, line: 1, character: 1 }, cwd)
		.then(() => null, (error: unknown) => error);
	await until(async () => (await logs(log)).some((entry) => entry.event === "hover"));
	const controller = new AbortController();
	const queued = manager.execute({ operation: "document_symbols", path }, cwd, controller.signal)
		.then(() => null, (error: unknown) => error);
	controller.abort();
	expect(String(await bounded(queued, 300))).toMatch(/abort/i);
	expect((await manager.execute({ operation: "status" }, cwd) as Status).servers[0]?.running).toBe(true);
	const secondQueued = manager.execute({ operation: "document_symbols", path }, cwd)
		.then(() => null, (error: unknown) => error);
	await manager.close();
	expect(String(await active)).toMatch(/closed|dispos/i);
	expect(String(await secondQueued)).toMatch(/closed/i);
	const records = await logs(log);
	expect(records.filter((entry) => entry.event === "spawn")).toHaveLength(1);
	await expectDead(records[0]!.pid);
});

test("server exit remains an observable failure rather than empty semantic success", async () => {
	const { cwd, path, manager } = await setup("crash");
	const error = await bounded(manager.execute({ operation: "hover", path, line: 1, character: 1 }, cwd)).then(() => null, (error: unknown) => error);
	expect(String(error)).toMatch(/exit|closed|died|23|dispos/i);
	expect(String(error)).toContain("fixture-crash-evidence");
});

test("unsupported capability fails clearly", async () => {
	const { cwd, path, manager } = await setup("unsupported");
	await expect(manager.execute({ operation: "hover", path, line: 1, character: 1 }, cwd)).rejects.toThrow(/support|capabilit/i);
});

test("close shuts down live processes, is idempotent, and permanently rejects reuse", async () => {
	const { cwd, path, manager } = await setup();
	const first = await snapshot(manager, cwd, path);
	await bounded(manager.close());
	await expectDead(first.pid);
	await bounded(manager.close());
	await expect(manager.execute({ operation: "hover", path, line: 1, character: 1 }, cwd)).rejects.toThrow(/closed/i);
	await expect(manager.execute({ operation: "status" }, cwd)).rejects.toThrow(/closed/i);
});

test.each(["push-versioned", "push-unversioned", "push-unpublished", "push-stale"])("%s diagnostics distinguish fresh, unknown, and stale evidence", async (mode) => {
	const { cwd, path, manager } = await setup(mode);
	// The hover response is a wire barrier after didOpen/publication, not a sleep-based race.
	const initial = await snapshot(manager, cwd, path);
	const diagnostics = async () => (await manager.execute({ operation: "diagnostics", path }, cwd) as { result: Diagnostic }).result;
	const first = await diagnostics();
	expect(first.source).toBe("push");
	expect(first.version).toBe(initial.version);
	if (mode === "push-unpublished") {
		expect(first.freshness).toBe("unknown");
		expect(first.diagnostics).toBeNull();
	} else {
		expect(first.freshness).toBe(mode === "push-unversioned" ? "unversioned" : "current");
		expect(JSON.stringify(first.diagnostics)).toContain("fixture-diagnostic");
	}
	await writeFile(path, "const replacement = 2;\n");
	const next = await snapshot(manager, cwd, path);
	const changed = await diagnostics();
	expect(changed.version).toBe(next.version);
	if (mode === "push-stale") {
		expect(changed.freshness).toBe("pending");
		expect(changed.publishedVersion).toBe(initial.version);
		expect(changed.publishedVersion).toBeLessThan(changed.version);
		expect(JSON.stringify(changed.diagnostics)).not.toContain("fixture-stale-publication");
	} else if (mode === "push-versioned") {
		expect(changed.freshness).toBe("current");
		expect(changed.publishedVersion).toBe(next.version);
	} else expect(changed.freshness).toBe(mode === "push-unversioned" ? "unversioned" : "unknown");
});

test.each(["normal", "incremental"])("%s wire model: finite edit sequences obey V(n+1)=V(n)+[text differs]", async (mode) => {
	const { cwd, path, manager } = await setup(mode);
	const alphabet = ["a\n", "😀\r\nb", ""];
	// Exhaust all 3^3 sequences: repeats, changes, reversions and empty/astral edits.
	for (let sequence = 0; sequence < 27; sequence++) {
		await writeFile(path, alphabet[0]!);
		let previous = await snapshot(manager, cwd, path);
		for (let step = 0; step < 3; step++) {
			const text = alphabet[Math.floor(sequence / 3 ** step) % 3]!;
			await writeFile(path, text);
			const actual = await snapshot(manager, cwd, path);
			expect(actual.text).toBe(text);
			expect(actual.version).toBe(previous.version + Number(previous.text !== text));
			expect(actual.changes).toBe(previous.changes + Number(previous.text !== text));
			expect(actual.pid).toBe(previous.pid);
			expect(actual.opens).toBe(1);
			previous = actual;
		}
	}
}, 15000);
