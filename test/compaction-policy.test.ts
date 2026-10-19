import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { AssistantEntry, UserEntry, createRegistry, Harness, MemoryStorage, type CompactionPolicy } from "@earendil-works/pi-durable";

// These are deterministic provider/summary plumbing fixtures, NOT evidence of real-model summary quality.
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const next = { role: "user" as const, content: "next", timestamp: 1 };
const facts = "File src/core/job.ts; commit abc1234; decision: no deployment; TODO verify cancellation.";
async function fixture(window: number, tokens: number, policy: Partial<CompactionPolicy> = {}, persistent = false) {
 const faux = fauxProvider({ models: [{ id: "large", contextWindow: window, maxTokens: 16384 }, { id: "small", contextWindow: 128000, maxTokens: 16384 }] });
 const models = createModels(); models.setProvider(faux.provider);
 const dir = persistent ? await mkdtemp(join(tmpdir(), "compaction-policy-")) : undefined;
 if (dir) closes.push(async () => { Bun.gc(true); await rm(dir, { recursive: true, force: true }); });
 const openStorage = () => dir ? openNodeSqliteStorage(join(dir, "test.sqlite")) : new MemoryStorage();
 const storage = await openStorage();
 const settings = { compaction: { enabled: false, ...policy }, retry: { enabled: false } };
 const options = { models, registry: createRegistry(), settings };
 let harness = await Harness.open(storage, options, context);
 closes.push(() => harness.close(context));
 let root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "large" }, instructions: "BASE" } });
 faux.setResponses([fauxAssistantMessage("ready")]);
 expect((await (await root.submit({ type: "input", content: "start" }, context)).wait(context)).status).toBe("done");
 await harness.commit(async tx => {
  await tx.appendEntry(UserEntry, root.id, { model: [{ role: "user", content: facts, timestamp: 1 }] });
  const message = fauxAssistantMessage("RECENT " + "x".repeat(Math.min(90000, Math.floor(window * 0.8))));
  message.usage = { ...message.usage, input: tokens - estimateMessageTokens(next), totalTokens: tokens - estimateMessageTokens(next) };
  await tx.appendEntry(AssistantEntry, root.id, { model: [message] });
 }, context);
 const requests: string[] = [];
 const summaryLimits: number[] = [];
 const respond = (ctx: { messages: readonly { content: unknown }[] }, options?: { maxTokens?: number }) => {
  const serialized = JSON.stringify(ctx.messages);
  const summary = serialized.includes("<conversation>"); requests.push(summary ? "summary" : "agent");
  if (summary) { expect(serialized).toContain(facts); summaryLimits.push(options?.maxTokens ?? 0); }
  return fauxAssistantMessage(summary ? facts : "answer");
 };
 faux.setResponses(Array.from({ length: 8 }, () => respond));
 settings.compaction = { ...policy, enabled: policy.enabled ?? true };
 return { requests, summaryLimits, faux, settings, get harness() { return harness; }, get root() { return root; }, async reopen() {
  const id = root.id; await harness.close(context);
  harness = await Harness.open(await openStorage(), options, context); harness.resume(); root = (await harness.conversation(id, context))!;
 }, async run() {
  const result = await (await root.submit({ type: "input", content: next.content }, context)).wait(context);
  expect(result.status).toBe("done");
  const tasks = await harness.commit(tx => tx.scanTasks({ conversationId: root.id, kind: "pi.compaction" }, 100), context);
  for (const task of tasks.items) await harness.waitForTask(task.id, context);
  return result;
 } };
}

test("1M default blocks at 300K, not near 1M, and summary retains fixture facts", async () => {
 const chat = await fixture(1000000, 300001); await chat.run();
 expect(chat.requests).toEqual(["summary", "agent"]);
 expect(chat.summaryLimits).toEqual([13107]);
 expect(JSON.stringify((await chat.root.context(context)).messages)).toContain(facts);
});
test("128K applies the 70 percent blocking threshold", async () => {
 const chat = await fixture(128000, 89601, { backgroundTokens: 0 }); await chat.run();
 expect(chat.requests).toEqual(["summary", "agent"]);
});
test("at the blocking boundary no blocking compaction occurs", async () => {
 const chat = await fixture(1000000, 300000, { backgroundTokens: 0 }); await chat.run();
 expect(chat.requests).toEqual(["agent"]);
});
test("disabled auto compaction stays disabled", async () => {
 const chat = await fixture(1000000, 400000, { enabled: false }); await chat.run();
 expect(chat.requests).toEqual(["agent"]);
});
test("tiny windows do not compact every eligible prefix from negative thresholds", async () => {
 const chat = await fixture(16000, 100, { keepRecentTokens: 1 }); await chat.run();
 expect(chat.requests).toEqual(["agent"]);
});

for (const [window, hard, background] of [[16000,11200,9600], [32000,22400,19200], [128000,89600,76800], [200000,140000,120000], [1000000,300000,267232]]) {
 test("window " + window + " hard boundary and scaled recent retention", async () => {
  const at = await fixture(window!, hard!, { backgroundTokens: 0 }); await at.run();
  expect(at.requests).toEqual(["agent"]);
  const over = await fixture(window!, hard! + 1, { backgroundTokens: 0 }); await over.run();
  expect(over.requests).toEqual(["summary", "agent"]);
 });
 test("window " + window + " background boundary", async () => {
  const at = await fixture(window!, background!); await at.run();
  expect(at.requests).toEqual(["agent"]);
  const over = await fixture(window!, background! + 1); await over.run();
  expect(over.requests.filter(x => x === "summary")).toHaveLength(1);
  expect(over.requests.filter(x => x === "agent")).toHaveLength(1);
  const tasks = await over.harness.commit(tx => tx.scanTasks({ conversationId: over.root.id, kind: "pi.compaction" }, 100), context);
  expect(tasks.items).toHaveLength(1);
  expect(tasks.items[0]!.owner).toBeUndefined();
  expect(tasks.items[0]!.background).toBe(true);
 });
}

test("model switches recalculate against the selected window", async () => {
 const chat = await fixture(1000000, 90000, { backgroundTokens: 0 });
 await chat.root.configure({ model: { provider: "faux", modelId: "small" } }, context);
 await chat.run(); expect(chat.requests).toEqual(["summary", "agent"]);
});
test("reopened conversation uses current defaults, not creation-time thresholds", async () => {
 const chat = await fixture(1000000, 300001, {}, true); await chat.reopen();
 await chat.run(); expect(chat.requests).toEqual(["summary", "agent"]);
});
test("explicit cap and ratio replace defaults and can select legacy reserve-only behavior", async () => {
 const cap = await fixture(1000000, 200001, { maxContextTokens: 200000, backgroundTokens: 0 });
 await cap.run(); expect(cap.requests).toEqual(["summary", "agent"]);
 const ratio = await fixture(200000, 100001, { maxContextRatio: 0.5, backgroundTokens: 0 });
 await ratio.run(); expect(ratio.requests).toEqual(["summary", "agent"]);
 const legacy = await fixture(1000000, 400000, { maxContextTokens: 0, maxContextRatio: 1, backgroundTokens: 0 });
 await legacy.run(); expect(legacy.requests).toEqual(["agent"]);
});
test("explicit reserve wins when it requires earlier compaction", async () => {
 const chat = await fixture(128000, 64001, { reserveTokens: 64000, backgroundTokens: 0 });
 await chat.run(); expect(chat.requests).toEqual(["summary", "agent"]);
});
test("explicit recent retention prevents a cut when nothing is eligible", async () => {
 const chat = await fixture(1000000, 400000, { keepRecentTokens: 500000 });
 await chat.run(); expect(chat.requests).toEqual(["agent"]);
});
test("overflow retry still reaches compaction and the next real harness request", async () => {
 const chat = await fixture(128000, 1000);
 chat.faux.setResponses([
  fauxAssistantMessage("", { stopReason: "error", errorMessage: "maximum context length exceeded" }),
  fauxAssistantMessage(facts), fauxAssistantMessage("recovered"),
 ]);
 await chat.run();
 const entries = await chat.root.entries({}, 100, undefined, context);
 expect(entries.items.some(entry => entry.kind === "pi.compaction")).toBe(true);
 expect(JSON.stringify((await chat.root.context(context)).messages)).toContain("recovered");
});

