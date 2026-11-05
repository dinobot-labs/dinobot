import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { NodeExecutionEnv, isNativeProcessEvent } from "@earendil-works/pi-durable/env/node";
import type { NativeProcessEvent } from "@earendil-works/pi-durable/env";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { openAIResponsesApi } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.lazy.js";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry, MemoryStorage, defineExtension, hook, GenerationTask, LiveDoc, type ConversationId, type StorageWrite } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { compactionPolicy } from "../node_modules/@earendil-works/pi-durable/dist/harness/compaction.js";
import { resolveSettings } from "../node_modules/@earendil-works/pi-durable/dist/harness/agent.js";

const dirs: string[] = [];
const closes: (() => Promise<unknown>)[] = [];
afterEach(async () => {
 for (const close of closes.splice(0).reverse()) await close();
 Bun.gc(true);
 for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});
async function temporary() { const dir = await mkdtemp(join(tmpdir(), "durable15-safety-")); dirs.push(dir); return dir; }
const bounded = () => withAbortSignal(AbortSignal.timeout(5000), context);
async function exists(path: string) { try { await access(path); return true; } catch { return false; } }

for (const form of ["shell", "argv", ...(process.platform === "win32" ? ["powershell"] : [])]) {
 test("native " + form + " commits identity before user effect and preserves output", async () => {
  const dir = await temporary(); const marker = join(dir, "effect");
  const env = new NodeExecutionEnv({ cwd: dir });
  await writeFile(join(dir, "effect.js"), 'require("node:fs").writeFileSync(process.argv[2],"done");console.log("hello-native");');
  const command = form === "argv" ? [process.execPath, join(dir, "effect.js"), marker] : form === "powershell" ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", '[IO.File]::WriteAllText("effect","done"); Write-Output hello-native'] : "printf done > effect; printf hello-native";
  const events: NativeProcessEvent[] = []; let output = "";
  const result = await env.exec(command, { timeout: 5, onOutput(text) { output += text; }, async onProcess(event) {
   events.push(event); expect(isNativeProcessEvent(event)).toBe(true);
   expect(isNativeProcessEvent(JSON.parse(JSON.stringify(event)))).toBe(false);
   if (event.phase === "started") { expect(event.startTime).toBeTruthy(); expect(await exists(marker)).toBe(false); await Bun.sleep(25); expect(await exists(marker)).toBe(false); }
  } }, context);
  expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } });
  expect(await readFile(marker, "utf8")).toBe("done"); expect(output).toContain("hello-native");
  expect(events.map(x => x.phase)).toEqual(["admitted", "started", "settled"]);
  expect(events.at(-1)?.canonical).toBe(true);
 }, 15000);
 test("native " + form + " rejects identity callback without running user code", async () => {
  const dir = await temporary(); const env = new NodeExecutionEnv({ cwd: dir });
  const script = join(dir, "effect.js"); await writeFile(script, 'require("node:fs").writeFileSync("effect","bad");');
  const command = form === "argv" ? [process.execPath, script] : form === "powershell" ? ["powershell.exe", "-NoProfile", "-Command", '[IO.File]::WriteAllText("effect","bad")'] : "printf bad > effect";
  const result = await env.exec(command, { timeout: 5, onProcess(event) { if (event.phase === "started") throw new Error("reject identity"); } }, context);
  expect(result).toMatchObject({ ok: false, error: { code: "callback_error" } });
  expect(await exists(join(dir, "effect"))).toBe(false);
 }, 15000);
}

test("argv missing executable preserves spawn_error for PowerShell fallback", async () => {
 const env = new NodeExecutionEnv({ cwd: await temporary() });
 expect(await env.exec(["dinobot-no-such-program-15"], { timeout: 5 }, context)).toMatchObject({ ok: false, error: { code: "spawn_error" } });
}, 15000);

test("controlled capability is single-use and produces authenticated settlement", async () => {
 const env = new NodeExecutionEnv({ cwd: await temporary() }); const ticket = env.controlledProcess(10); const events: NativeProcessEvent[] = [];
 expect(await env.exec("@native-controlled-wait", { controlledProcess: ticket, timeout: 5, onProcess(e) { events.push(e); } }, context)).toMatchObject({ ok: true, value: { exitCode: 0 } });
 expect(events.at(-1)).toMatchObject({ phase: "settled", controlled: true, canonical: true });
 expect(await env.exec("@native-controlled-wait", { controlledProcess: ticket }, context)).toMatchObject({ ok: false });
}, 15000);

test("model override beats explicit global reserve, ratio and cap; default scales to current model", () => {
 const settings = resolveSettings({ compaction: { reserveTokens: 4000, maxContextTokens: 9000, maxContextRatio: 0.5, modelOverrides: { "faux/one": { reserveTokens: 1000, maxContextTokens: 0, maxContextRatio: 0.8, keepRecentTokens: 300 } } } });
 expect(compactionPolicy(settings, { provider: "faux", modelId: "one" }, 16000)).toMatchObject({ reserveTokens: 1000, blockingTokens: 12800, keepRecentTokens: 300 });
 expect(compactionPolicy(settings, { provider: "faux", modelId: "other" }, 16000)).toMatchObject({ reserveTokens: 4000, blockingTokens: 8000 });
 expect(compactionPolicy(resolveSettings(undefined), { provider: "faux", modelId: "one" }, 16000)).toMatchObject({ reserveTokens: 4000, blockingTokens: 11200, keepRecentTokens: 2800 });
});

function conversationWrite(id: number): StorageWrite { return { type: "conversation", value: { id: id as ConversationId } }; }
test("group commits expose only durable prefix, refuse stale writer and do not advance on SQL rollback", async () => {
 const path = join(await temporary(), "group.sqlite"); const first = await openNodeSqliteStorage(path); closes.push(() => first.close(context));
 const stale = await openNodeSqliteStorage(path); closes.push(() => stale.close(context));
 const receipts: [number, number][] = [];
 const result = await first.commit([[conversationWrite(10)], [conversationWrite(10)], [conversationWrite(11)]], (index, seq) => receipts.push([index, seq]), context);
 expect(result.stored).toBe(1); expect(result.refused).toBeDefined(); expect(receipts).toHaveLength(1); expect(receipts[0]?.[0]).toBe(0);
 expect(await first.conversation(11 as ConversationId, context)).toBeUndefined();
 const refused = await stale.commit([[conversationWrite(12)]], () => { throw new Error("stale receipt"); }, context);
 expect(refused.stored).toBe(0); expect(String(refused.refused)).toContain("writer is stale");
 const db = new Database(path); db.exec("CREATE TRIGGER fail_group BEFORE INSERT ON conversations WHEN NEW.id = 14 BEGIN SELECT RAISE(ABORT, 'injected write failure'); END"); db.close();
 await expect(first.commit([[conversationWrite(13)], [conversationWrite(14)]], () => { throw new Error("rolled-back receipt"); }, context)).rejects.toThrow("injected write failure");
 expect(await first.conversation(13 as ConversationId, context)).toBeUndefined();
 const db2 = new Database(path); db2.exec("DROP TRIGGER fail_group"); db2.close();
 const after: number[] = []; expect((await first.commit([[conversationWrite(13)], [conversationWrite(14)]], (_index, seq) => after.push(seq), context)).stored).toBe(2);
 expect(after).toEqual([receipts[0]![1] + 1, receipts[0]![1] + 2]);
});


test("payload hook revocation is swallowed but fresh host guard blocks actual HTTP dispatch", async () => {
 let network = 0; let hookCalls = 0; let checks = 0; let revoked = false;
 const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { network++; return new Response("should not dispatch", { status: 500 }); } });
 closes.push(async () => { await server.stop(true); });
 const model = { ...fauxProvider({ models: [{ id: "one" }] }).getModel(), provider: "boundary", api: "openai-responses" as const, baseUrl: server.url.href };
 const models = createModels(); models.setProvider(createProvider({ id: "boundary", models: [model], baseUrl: server.url.href,
  auth: { apiKey: { name: "mock", resolve: async () => ({ auth: { apiKey: "mock-not-a-secret" } }) } }, api: openAIResponsesApi() }));
 const registry = createRegistry();
 registry.install(defineExtension({ name: "revoke-payload", hooks: [hook(GenerationTask, { beforeProviderRequest() { hookCalls++; revoked = true; throw new Error("extension revokes then fails"); } })] }));
 const reports: unknown[] = [];
 const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { retry: { enabled: false }, compaction: { enabled: false } },
  beforeModelRequest() { checks++; if (revoked) throw new Error("host denied revoked payload"); }, onReport(report) { reports.push(report.error); } }, context);
 closes.push(() => harness.close(context));
 const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "boundary", modelId: "one" } } }, context);
 const result = await (await conversation.submit({ type: "input", content: "deny" }, context)).wait(bounded());
 expect(result.status).toBe("unanswered"); expect(hookCalls).toBe(1); expect(checks).toBe(2); expect(network).toBe(0);
 expect(reports.some(error => error instanceof Error && error.message === "extension revokes then fails")).toBe(true);
});

test("malformed stored revision quarantines only corrupt cleanup; timers and healthy answer continue", async () => {
 const path = join(await temporary(), "corrupt.sqlite");
 const faux = fauxProvider({ models: [{ id: "one" }] }); faux.setResponses([fauxAssistantMessage("healthy answer")]);
 const models = createModels(); models.setProvider(faux.provider);
 const registry = createRegistry();
 let harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry }, context);
 const broken = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
 await broken.submit({ type: "input", content: "pending" }, context); await harness.close(context);
 const db = new Database(path);
 const row = db.query("SELECT id FROM documents WHERE owner_id = ? AND json_extract(record, '$.kind') = 'pi.live'").get(broken.id) as { id: number };
 const meta = db.query("SELECT next_seq FROM durable_metadata").get() as { next_seq: number };
 const base = db.query("SELECT version FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1").get(row.id) as { version: number };
 db.query("INSERT INTO document_revisions VALUES (?, ?, 'delta', ?, ?)").run(row.id, meta.next_seq, base.version, JSON.stringify([["s", ["generation", "message", "missing"], "invalid"]]));
 db.exec("UPDATE durable_metadata SET next_seq = next_seq + 1"); db.close();
 const reports: unknown[] = []; const quarantined = Promise.withResolvers<void>();
 harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry, onReport(report) { reports.push(report.error); if (report.error instanceof Error && report.error.name === "DocumentReplayError") quarantined.resolve(); } }, context);
 closes.push(() => harness.close(context)); harness.resume();
 await Promise.race([quarantined.promise, Bun.sleep(2000).then(() => { throw new Error("quarantine not reported"); })]);
 const first = reports.length; await Bun.sleep(30); expect(reports).toHaveLength(first);
 const inspection = await harness.inspect(context);
 expect(inspection.tasks.some(task => task.state.kind === "blocked" && task.state.reason === "settlement_failed")).toBe(true);
 expect(harness.wake().active).toBe(false);
 const healthy = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "one" } } }, context);
 const answer = await (await healthy.submit({ type: "input", content: "healthy" }, context)).wait(bounded());
 expect(answer.status).toBe("done"); expect(JSON.stringify((await healthy.context(context)).messages)).toContain("healthy answer");
 await healthy.waitForIdle(bounded()); await Bun.sleep(30); expect(reports).toHaveLength(first); expect(harness.wake().active).toBe(false);
 expect(faux.state.callCount).toBe(1);
});

for (const mode of ["read", "commit"] as const) {
 test("actual storage " + mode + " failure still fails the whole session", async () => {
  class FailingStorage extends MemoryStorage {
   fail = false;
   override async conversation(...args: Parameters<MemoryStorage["conversation"]>) { if (this.fail && mode === "read") throw new Error("injected storage read"); return super.conversation(...args); }
   override async commit(...args: Parameters<MemoryStorage["commit"]>) { if (this.fail && mode === "commit") throw new Error("injected storage commit"); return super.commit(...args); }
  }
  const storage = new FailingStorage(); const reports: string[] = [];
  const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry(), onReport(report) { reports.push(report.kind); } }, context);
  closes.push(() => harness.close(context)); storage.fail = true;
  if (mode === "read") await expect(harness.conversation(999 as ConversationId, context)).rejects.toThrow();
  else await expect(harness.createConversation({ ownership: { kind: "ownerless" } }, context)).rejects.toThrow();
  expect(reports).toContain("storage_failed");
  await expect(harness.createConversation({ ownership: { kind: "ownerless" } }, context)).rejects.toThrow("Session failed");
 });
}


for (const form of ["argv", ...(process.platform === "win32" ? ["powershell"] : [])]) {
 for (const stop of ["abort", "timeout"] as const) {
  test("native " + form + " " + stop + " cannot claim canonical settlement", async () => {
   const dir = await temporary(); const env = new NodeExecutionEnv({ cwd: dir }); const controller = new AbortController();
   await writeFile(join(dir, "wait.js"), 'console.log("ready");setTimeout(()=>{require("node:fs").writeFileSync("effect","bad");},3000);');
   const command = form === "argv" ? [process.execPath, join(dir, "wait.js")] : ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", 'Write-Output ready; Start-Sleep -Seconds 3; [IO.File]::WriteAllText("effect","bad")'];
   const events: NativeProcessEvent[] = [];
   const result = await env.exec(command, { timeout: stop === "timeout" ? 0.15 : 5, onOutput(text) { if (stop === "abort" && text.includes("ready")) controller.abort(); }, onProcess(e) { events.push(e); } }, withAbortSignal(controller.signal, context));
   expect(result).toMatchObject({ ok: false, error: { code: stop === "abort" ? "aborted" : "timeout" } });
   expect(events.some(e => e.phase === "started" && e.startTime)).toBe(true);
   expect(events.some(e => e.phase === "settled" && e.canonical)).toBe(false);
   expect(await exists(join(dir, "effect"))).toBe(false);
  }, 15000);
 }
}
