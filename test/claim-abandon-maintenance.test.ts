import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase, openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { parseAbandonRequest, recoveryProcessBlockers } from "../src/cli/quarantine-recovery.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
test("maintenance request preserves exact tokens and rejects caller evidence", () => {
 expect(parseAbandonRequest({ tokens: [{ key: "host:legacy", holder: "conversation:89177", token: 384 }], evidence: "quiescent" }).tokens).toEqual([{ key: "host:legacy", holder: "conversation:89177", token: 384 }]);
 for (const token of [0, -1, 1.5, "384", null]) expect(() => parseAbandonRequest({ tokens: [{ key: "host:legacy", holder: "conversation:89177", token }] })).toThrow("invalid_token");
 expect(() => parseAbandonRequest({ tokens: [] })).toThrow("invalid_tokens");
});

test.skipIf(process.platform !== "win32" && process.platform !== "darwin")("offline command refuses an already-open real SQLite connection", async () => {
 const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "quarantine-lock-"));
 const path = join(dir, "host.sqlite"); const request = join(dir, "request.json");
 await writeFile(request, JSON.stringify({ tokens: [{ key: "host:legacy", holder: "conversation:1", token: 384 }] }));
 const storage = await openNodeSqliteStorage(path);
 try {
  const child = Bun.spawn([process.execPath, main, "quarantine-recovery", "--database", path, "--request", request, "--apply"], { stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exit).toBe(1);
  expect(out).toBe("");
  expect(err).toMatch(/locked|busy/i);
 } finally { await storage.close(context); Bun.gc(true); await Bun.sleep(200); await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

test.skipIf(process.platform !== "win32" && process.platform !== "darwin")("exclusive SQLite connection fences new readers for its whole lifetime", async () => {
 const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "quarantine-exclusive-")); const path = join(dir, "host.sqlite");
 const first = await openNodeSqliteDatabase(path, { busyTimeoutMs: 50 });
 try {
  await first.exec("PRAGMA locking_mode=EXCLUSIVE"); await first.exec("BEGIN EXCLUSIVE; COMMIT;");
  await first.exec("CREATE TABLE probe(id INTEGER)");
  await expect(openNodeSqliteDatabase(path, { busyTimeoutMs: 50 })).rejects.toThrow(/locked|busy/i);
  await first.exec("BEGIN; INSERT INTO probe VALUES(1); COMMIT;");
  await expect(openNodeSqliteDatabase(path, { busyTimeoutMs: 50 })).rejects.toThrow(/locked|busy/i);
 } finally { await first.close(); }
 const reopened = await openNodeSqliteDatabase(path); await reopened.close();
 await rm(dir, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32" || process.platform === "darwin")("unsupported platforms refuse maintenance inventory", async () => {
	await expect(recoveryProcessBlockers([1])).rejects.toThrow("unsupported_platform_maintenance_only");
});

test.skipIf(process.platform !== "win32")("live process inventory refuses a real lingering child, not PID absence as proof", async () => {
 const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30000)"], { stdout: "ignore", stderr: "ignore" });
 try { expect((await recoveryProcessBlockers([child.pid])).some(b => b.includes(String(child.pid)))).toBe(true); }
 finally { child.kill(); await child.exited; }
});
