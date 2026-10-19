import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { configure, createRegistry, Harness, InboxDoc, LiveDoc, MemoryStorage, type TaskId, type Conversation, type Storage, type Tx, type InputSubmissionDraft } from "@earendil-works/pi-durable";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { recoverQueuedTransfers, sendQueuedNow } from "../src/core/queue.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const open = (storage: Storage) => Harness.open(storage, { registry: createRegistry(), models: createModels() }, context);
async function seed(harness: Harness, conversation: Conversation) {
 return harness.commit(async tx => {
  const inbox = await tx.doc(InboxDoc, conversation.id);
  (await tx.doc(LiveDoc, conversation.id)).run = { taskId: 999 as TaskId, inputs: [] };
  const ids = [];
  for (const content of ["one", "two"]) {
   const record = await tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued" });
   ids.push(record.id);
   inbox.items.push({ id: record.id, mode: "followUp", content });
  }
  return ids;
 }, context);
}

// Real public Session transactions and SQLite; only abort/admission are fault-controlled.
// Existing API tests cover the real running-turn behavior and attribution/withdraw compatibility.
for (const fault of ["before-transfer", "between-withdrawals", "after-transfer", "before-abort", "after-abort", "before-submit", "after-submit", "before-clear", "after-clear"] as const) {
 test("restart/retry recovers at " + fault, async () => {
  const dir = await mkdtemp(join(tmpdir(), "queue-recovery-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const db = join(dir, "queue.sqlite");
  let harness = await open(await openNodeSqliteStorage(db));
  cleanup.push(() => harness.close(context));
  let conversation = await harness.root(context);
  const ids = await seed(harness, conversation);
  const commit = harness.commit.bind(harness);
  let commits = 0;
  let armed = true;
  const trip = (at: string) => { if (armed && at === fault) { armed = false; throw new Error(fault); } };
  harness.commit = (async (change: (tx: Tx) => unknown, ctx: typeof context) => {
   const n = ++commits;
   if (n === 1) trip("before-transfer");
   if (n === 3) trip("before-clear");
   const result = await commit(async tx => {
    let withdrawals = 0;
    return change(new Proxy(tx, { get(target, key) {
     if (key === "settleSubmission") return (...args: Parameters<Tx["settleSubmission"]>) => {
      target.settleSubmission(...args);
      if (++withdrawals === 1) trip("between-withdrawals");
     };
     const value = Reflect.get(target, key);
     return typeof value === "function" ? value.bind(target) : value;
    } }));
   }, ctx);
   if (n === 1) trip("after-transfer");
   if (n === 3) trip("after-clear");
   return result;
  }) as Harness["commit"];
  let aborts = 0;
  let admissions = 0;
  const mockRunner = () => {
   harness.abortTask = async () => { trip("before-abort"); aborts++; trip("after-abort"); return "marked"; };
   harness.waitForTask = (async () => ({})) as unknown as Harness["waitForTask"];
  };
  mockRunner();
  const handle = () => ({ id: conversation.id,
   abort: async () => { throw new Error("must not abort the whole conversation"); },
   submit: async (draft: InputSubmissionDraft) => {
    trip("before-submit");
    // Admission persists the request identity and payload, as Conversation.submit does.
    const record = await commit(async tx => {
     const existing = await tx.submissionByRequest(conversation.id, draft.requestId!);
     if (existing) return existing;
     const inbox = await tx.doc(InboxDoc, conversation.id);
     const record = await tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued", requestId: draft.requestId! });
     inbox.items.push({ id: record.id, mode: "followUp", content: draft.content });
     return record;
    }, context);
    admissions++;
    trip("after-submit");
    return { id: record.id };
   },
  }) as unknown as Conversation;
  await expect(sendQueuedNow(harness, handle(), context)).rejects.toThrow(fault);
  harness.commit = commit;
  if (fault === "before-transfer" || fault === "between-withdrawals") {
   expect((await harness.snapshot(InboxDoc, conversation.id, context))!.items.map(item => item.id)).toEqual(ids);
   for (const id of ids) expect((await (await harness.submission(id, context))!.status(context)).status).toBe("queued");
  }
  // Close/reopen loses every in-memory lock. The accepted receipt is the only retry source.
  await harness.close(context);
  harness = await open(await openNodeSqliteStorage(db));
  conversation = await harness.root(context);
  mockRunner();
  const reopenedCommit = harness.commit.bind(harness);
  const retryHandle = handle();
  retryHandle.submit = async draft => {
   admissions++;
   const record = await reopenedCommit(async tx => {
    const inbox = await tx.doc(InboxDoc, conversation.id);
    const record = await tx.createSubmission({ conversationId: conversation.id, type: "input", status: "queued", requestId: draft.requestId! });
    if (draft.type !== "input") throw new Error("expected input");
    inbox.items.push({ id: record.id, mode: "followUp", content: draft.content });
    return record;
   }, context);
   return (await harness.submission(record.id, context))!;
  };
  // After a successful clear, the replacement is itself queued in this fixture. Do not
  // send it again: a new send-now intentionally transfers currently queued input.
  if (fault !== "after-clear") {
   const abortsBeforeRetry = aborts;
   const result = await sendQueuedNow(harness, retryHandle, context);
   expect(result.sent).toBe(2);
   if (fault === "after-submit" || fault === "before-clear") expect(aborts).toBe(abortsBeforeRetry);
  }
  expect(admissions).toBe(1);
  const inbox = (await harness.snapshot(InboxDoc, conversation.id, context))!;
  expect(inbox.items).toHaveLength(1);
  expect(inbox.items[0]).toMatchObject({ content: ["one", "", "two"].join(String.fromCharCode(10)) });
  for (const id of ids) expect(await (await harness.submission(id, context))!.status(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
 });
}

test("concurrent sends serialize and empty retry keeps old result shape", async () => {
 const harness = await open(new MemoryStorage());
 cleanup.push(() => harness.close(context));
 const conversation = await harness.root(context);
 await seed(harness, conversation);
 let aborts = 0;
 let submissions = 0;
 harness.abortTask = async () => { aborts++; return "marked"; };
 harness.waitForTask = (async () => ({})) as unknown as Harness["waitForTask"];
 const handle = { id: conversation.id, abort: async () => { throw new Error("must not abort the whole conversation"); }, submit: async () => { submissions++; return { id: 100 }; } } as unknown as Conversation;
 const results = await Promise.all(Array.from({ length: 8 }, () => sendQueuedNow(harness, handle, context)));
 expect(results).toEqual([{ sent: 2, submissionId: 100 }, ...Array.from({ length: 7 }, () => ({ sent: 0 }))]);
 expect(aborts).toBe(1);
 expect(submissions).toBe(1);
});

for (const barrier of ["before-abort", "before-submit"] as const) {
 test("real Harness preserves admission at " + barrier, async () => {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models }, context);
  cleanup.push(() => harness.close(context));
  const conversation = await harness.root(context);
  await harness.commit(tx => configure(tx, conversation.id, { model: { provider: "faux", modelId: "test" } }), context);
  const started = Promise.withResolvers<void>();
  faux.setResponses([
   (_transcript, options) => { started.resolve(); return new Promise(resolve => options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true })); },
   () => fauxAssistantMessage("delivered"),
   () => fauxAssistantMessage("delivered"),
  ]);
  await conversation.submit({ type: "input", content: "running" }, context);
  await started.promise;
  await conversation.submit({ type: "input", content: "one" }, context);
  await conversation.submit({ type: "input", content: "two" }, context);
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const commit = harness.commit.bind(harness);
  const submit = conversation.submit.bind(conversation);
  let commits = 0;
  harness.commit = (async (change, ctx) => {
   const result = await commit(change, ctx);
   if (++commits === 1 && barrier === "before-abort") { reached.resolve(); await release.promise; }
   return result;
  }) as Harness["commit"];
  conversation.submit = async (draft, ctx) => {
   if (barrier === "before-submit") { reached.resolve(); await release.promise; }
   return submit(draft, ctx);
  };
  const sending = sendQueuedNow(harness, conversation, context);
  await reached.promise;
  const arrival = await submit({ type: "input", content: "concurrent", whenBusy: "followUp" }, context);
  release.resolve();
  const result = await sending;
  expect(result.sent).toBe(2);
  await harness.waitForIdle(context);
  expect(await arrival.status(context)).not.toMatchObject({ status: "unanswered", reason: "aborted" });
  expect((await (await harness.submission(result.submissionId as never, context))!.status(context)).status).toBe("done");
 });
}

for (const fault of ["before-abort", "before-submit", "after-submit"] as const) {
 test("real SQLite startup recovers transfer and concurrent input at " + fault, async () => {
  const dir = await mkdtemp(join(tmpdir(), "queue-real-recovery-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const db = join(dir, "queue.sqlite");
  const faux = fauxProvider({ provider: "faux", models: [{ id: "test" }] });
  const models = createModels();
  models.setProvider(faux.provider);
  let harness = await Harness.open(await openNodeSqliteStorage(db), { registry: createRegistry(), models }, context);
  cleanup.push(() => harness.close(context));
  let conversation = await harness.root(context);
  await harness.commit(tx => configure(tx, conversation.id, { model: { provider: "faux", modelId: "test" } }), context);
  const started = Promise.withResolvers<void>();
  faux.setResponses([(_transcript, options) => {
   started.resolve();
   return new Promise(resolve => options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true }));
  }, () => fauxAssistantMessage("delivered"), () => fauxAssistantMessage("delivered")]);
  await conversation.submit({ type: "input", content: "running" }, context);
  await started.promise;
  const one = await conversation.submit({ type: "input", content: "one" }, context);
  const two = await conversation.submit({ type: "input", content: "two" }, context);
  const submit = conversation.submit.bind(conversation);
  const abortTask = harness.abortTask.bind(harness);
  let arrivalId: number | undefined;
  const arrive = async () => { arrivalId = Number((await submit({ type: "input", content: "concurrent" }, context)).id); };
  harness.abortTask = async (id, ctx) => {
   if (fault === "before-abort") { await arrive(); throw new Error(fault); }
   return abortTask(id, ctx);
  };
  conversation.submit = async (draft, ctx) => {
   await arrive();
   if (fault === "before-submit") throw new Error(fault);
   await submit(draft, ctx);
   throw new Error(fault);
  };
  await expect(sendQueuedNow(harness, conversation, context)).rejects.toThrow(fault);
  await harness.close(context);
  harness = await Harness.open(await openNodeSqliteStorage(db), { registry: createRegistry(), models }, context);
  conversation = await harness.root(context);
  // This is the startup hook used by openBot, not another user send-now request.
  await recoverQueuedTransfers(harness, context);
  await harness.waitForIdle(context);
  const requestId = "queue-send:" + [one.id, two.id].join(",");
  const replacement = await harness.commit(tx => tx.submissionByRequest(conversation.id, requestId), context);
  expect(replacement?.status).toBe("done");
  expect(await (await harness.submission(arrivalId as never, context))!.status(context)).toMatchObject({ status: "done" });
  await recoverQueuedTransfers(harness, context);
  expect(await harness.commit(tx => tx.submissionByRequest(conversation.id, requestId), context)).toEqual(replacement);
  expect((await harness.snapshot(InboxDoc, conversation.id, context))?.items).toEqual([]);
 });
}
