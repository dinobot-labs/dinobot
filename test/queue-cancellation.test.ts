import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot } from "../src/core/bot.ts";
import { startClientApi } from "../src/api/server.ts";
import type { Commands } from "../src/commands/index.ts";
import { recoverQueuedTransfers } from "../src/core/queue.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
 const dir = await mkdtemp(join(tmpdir(), "queue-cancel-"));
 cleanup.push(() => rm(dir, { recursive: true, force: true }));
 const models = createModels();
 const faux = fauxProvider({ provider: "faux", models: [{ id: "test" }] });
 models.setProvider(faux.provider);
 const open = async () => openBot({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "test" }, toolMode: "direct", plugins: [] }, context);
 let bot = await open();
 cleanup.push(() => bot.close(context));
 // Bun test mode otherwise resets sockets for uncaught route failures. Keep the
 // actual routes/network; normalize its default failure response explicitly.
 const serve = Bun.serve.bind(Bun);
 const serving = spyOn(Bun, "serve").mockImplementation(options => serve({ ...options, error: () => new Response("injected failure", { status: 500 }) } as Parameters<typeof Bun.serve>[0]));
 let api: ReturnType<typeof startClientApi>;
 try { api = startClientApi(bot, 0, context, {} as Commands); } finally { serving.mockRestore(); }
 cleanup.push(() => api.stop());
 const post = (path: string) => fetch(new URL("/v1/threads/tui/cancel/" + path, api.url), { method: "POST" });
 const conversation = await bot.conversation("tui", "cancel", context);
 let calls = 0;
 const started = Promise.withResolvers<void>();
 faux.setResponses([(_transcript, options) => {
  calls++; started.resolve();
  return new Promise(resolve => options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true }));
 }, () => { calls++; return fauxAssistantMessage("must not resurrect"); }]);
 await conversation.submit({ type: "input", content: "running" }, context);
 await started.promise;
 const queued = await conversation.submit({ type: "input", content: "cancel me" }, context);
 return { bot, conversation, post, calls: () => calls, queued, reopen: async () => { await api.stop(); await bot.close(context); bot = await open(); return bot; } };
}

for (const restart of [false, true]) test("failed send-now then HTTP abort prevents recovery" + (restart ? " after restart" : ""), async () => {
 const f = await fixture();
 const abortTask = f.bot.harness.abortTask.bind(f.bot.harness);
 f.bot.harness.abortTask = async () => { throw new Error("injected before abort"); };
 expect((await f.post("queue/send")).status).toBe(500);
 f.bot.harness.abortTask = abortTask;
 expect((await f.post("abort")).status).toBe(204);
 const bot = restart ? await f.reopen() : f.bot;
 await recoverQueuedTransfers(bot.harness, context);
 await bot.harness.waitForIdle(context);
 expect(f.calls()).toBe(1);
 expect(await bot.harness.commit(tx => tx.submissionByRequest(f.conversation.id, "queue-send:" + f.queued.id), context)).toBeUndefined();
});

test("HTTP abort waits for in-flight send-now admission", async () => {
 const f = await fixture();
 const reached = Promise.withResolvers<void>();
 const release = Promise.withResolvers<void>();
 f.bot.harness.abortTask = async () => { reached.resolve(); await release.promise; throw new Error("injected before abort"); };
 const sending = f.post("queue/send");
 await reached.promise;
 let finished = false;
 const aborting = f.post("abort").then(response => { finished = true; return response; });
 await new Promise(resolve => setTimeout(resolve, 40));
 const overtook = finished;
 release.resolve();
 expect((await sending).status).toBe(500);
 expect((await aborting).status).toBe(204);
 expect(overtook).toBe(false);
 await recoverQueuedTransfers(f.bot.harness, context);
 await f.bot.harness.waitForIdle(context);
 expect(f.calls()).toBe(1);
});

test("failed durable abort returns HTTP 500, not false success", async () => {
 const f = await fixture();
 f.bot.conversation = async () => f.conversation;
 const commit = f.bot.harness.commit.bind(f.bot.harness);
 f.bot.harness.commit = async () => { throw new Error("injected cancellation persistence failure"); };
 let response: Response;
 try { response = await f.post("abort"); } finally { f.bot.harness.commit = commit; }
 expect(response!.status).toBe(500);
 expect((await f.post("abort")).status).toBe(204);
});

for (const afterAbort of [false, true]) test("interrupted abort keeps receipt revoked across reopen: " + (afterAbort ? "after abort" : "before abort"), async () => {
 const f = await fixture();
 const abortTask = f.bot.harness.abortTask.bind(f.bot.harness);
 f.bot.harness.abortTask = async () => { throw new Error("injected send failure"); };
 expect((await f.post("queue/send")).status).toBe(500);
 f.bot.harness.abortTask = abortTask;
 f.bot.conversation = async () => f.conversation;
 const abort = f.conversation.abort.bind(f.conversation);
 f.conversation.abort = async ctx => {
  if (afterAbort) await abort(ctx);
  throw new Error("injected interrupted abort");
 };
 expect((await f.post("abort")).status).toBe(500);
 f.conversation.abort = abort;
 const bot = await f.reopen();
 await recoverQueuedTransfers(bot.harness, context);
 await bot.harness.waitForIdle(context);
 // A failed abort did not stop the original runner; normal shutdown recovery
 // may resume it. It must never recreate the cancelled transfer submission.
 expect(f.calls()).toBe(afterAbort ? 1 : 2);
 expect(await bot.harness.commit(tx => tx.submissionByRequest(f.conversation.id, "queue-send:" + f.queued.id), context)).toBeUndefined();
});
