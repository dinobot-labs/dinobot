import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ReportService } from "../src/report/service.ts";

/** ADR 0103: the daemon and an offline `dinobot report` mutate one state.json; report/state.lock serialises them. */

let dir: string | undefined;
afterEach(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
	dir = undefined;
});

const users = async (dataDir: string) => Object.keys((JSON.parse(await readFile(join(dataDir, "report", "state.json"), "utf8")) as { users: Record<string, unknown> }).users);

test("two processes mutating the same state lose no update", async () => {
	dir = await mkdtemp(join(tmpdir(), "dinobot-report-lock-"));
	const worker = resolve("test/fixtures/report-lock-worker.ts");
	const count = 40;
	const children = ["a", "b"].map((tag) => Bun.spawn([process.execPath, worker, dir!, tag, String(count)], { stdout: "pipe", stderr: "pipe" }));
	const codes = await Promise.all(children.map(async (child) => [await child.exited, await new Response(child.stderr).text()] as const));
	expect(codes).toEqual([[0, ""], [0, ""]]);
	const keys = await users(dir);
	expect(keys.length).toBe(2 * count);
	expect(new Set(keys).size).toBe(2 * count);
	await expect(readFile(join(dir, "report", "state.lock"))).rejects.toThrow();
}, 60_000);

test("a live holder blocks until it releases; a dead holder's lock is broken", async () => {
	dir = await mkdtemp(join(tmpdir(), "dinobot-report-lock-"));
	await mkdir(join(dir, "report"), { recursive: true });
	const lock = join(dir, "report", "state.lock");
	const service = new ReportService({ dataDir: dir, version: "0.0.0" });

	await writeFile(lock, JSON.stringify({ pid: process.pid, at: Date.now(), nonce: "held-by-test" }));
	let done = false;
	const pending = service.recordConsent("lock:live", false).then(() => (done = true));
	await Bun.sleep(300);
	expect(done).toBe(false);
	await rm(lock);
	await pending;
	expect(await users(dir)).toContain("lock:live");

	// pid 2^22+7 is not running here; an old timestamp would also do.
	await writeFile(lock, JSON.stringify({ pid: 4194311, at: Date.now(), nonce: "dead" }));
	await service.recordConsent("lock:dead", false);
	expect(await users(dir)).toContain("lock:dead");
	await expect(readFile(lock)).rejects.toThrow();
});
