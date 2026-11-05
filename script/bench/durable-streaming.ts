/**
 * Real Harness + file SQLite, no network. Run each concurrency in a fresh process:
 * DEEPWORK_TYPECHECK_JOBS=2 bun script/bench/durable-streaming.ts 1
 * DEEPWORK_TYPECHECK_JOBS=2 bun script/bench/durable-streaming.ts 8
 * stdout: JSON; preflight then three isolated repetitions, each with warmup.
 * Fixed payload, provider cadence, tools and assertions on every version.
 * Any version-specific adaptation must stay in openHarness, not the workload.
 * Timed interval: submit through idle (excludes setup, readback and cleanup).
 * Sampled RSS is not the OS peak. maxRSS is process-lifetime KiB, includes
 * warmup. Each bounded, synchronously joined child measures one repetition.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { cpus, freemem, tmpdir, totalmem, release } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";
import { createRegistry, defineTool, Harness, type Conversation, type HarnessOptions, type Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";

const concurrency = Number(process.argv[2] ?? 1);
const workerRoot = process.argv[3];
const workerRepetition = Number(process.argv[4] ?? 0);
assert([1, 8].includes(concurrency), "concurrency must be 1 or 8");
const INPUT_BYTES = 128 * 1024;
const OUTPUT_BYTES = 128 * 1024;
const TOOL_COUNT = 4;
const TOOL_BYTES = 8 * 1024;
const CHUNK_BYTES = 1024;
const REPETITIONS = 3;
const input = "I".repeat(INPUT_BYTES);
const answer = "deterministic-stream-".repeat(Math.ceil(OUTPUT_BYTES / 20)).slice(0, OUTPUT_BYTES);
assert.equal(Buffer.byteLength(answer), OUTPUT_BYTES);
const toolText = (slot: number) => String(slot).repeat(TOOL_BYTES);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const textOf = (message: Message) => typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : "").join("");
const version = (name: string) => JSON.parse(readFileSync(new URL("../../node_modules/@earendil-works/" + name + "/package.json", import.meta.url), "utf8")).version as string;

// Public-API adapter; no runtime version fallback or changed workload.
const openHarness = (storage: Storage, options: HarnessOptions) => Harness.open(storage, options, context);

async function verifyTranscript(conversation: Conversation) {
  const messages = (await conversation.context(context)).messages;
  assert.deepEqual(messages.map(m => m.role), ["system", "user", "assistant", "toolResult", "toolResult", "toolResult", "toolResult", "assistant"]);
  assert.equal(textOf(messages[1]!), input);
  const calls = messages[2]!;
  assert.equal(calls.role, "assistant");
  if (calls.role !== "assistant") throw new Error("missing assistant tool calls");
  assert.deepEqual(calls.content, Array.from({length: TOOL_COUNT}, (_, slot) => fauxToolCall("bench_output", {slot}, {id: "call-" + slot})));
  for (let slot = 0; slot < TOOL_COUNT; slot++) {
    const result = messages[3 + slot]!;
    assert.equal(result.role, "toolResult");
    if (result.role !== "toolResult") throw new Error("missing tool result");
    assert.equal(result.toolCallId, "call-" + slot);
    assert.equal(result.isError, false);
    assert.equal(textOf(result), toolText(slot));
  }
  assert.equal(textOf(messages.at(-1)!), answer);
}

async function run(phase: "warmup-correctness" | "measured", repetition: number) {
  assert(workerRoot, "run must execute in an owned worker process");
  const directory = mkdtempSync(join(workerRoot, "trial-"));
  const databasePath = join(directory, "bench.sqlite");
  let harness: Harness | undefined;
  let storage: Storage | undefined;
  let sampler: ReturnType<typeof setInterval> | undefined;
  let metrics: Record<string, unknown> | undefined;
  const reports: unknown[] = [];
  try {
    let commits = 0;
    const faux = fauxProvider({provider: "bench-faux", api: "bench-faux", models: [{id: "bench", contextWindow: 1_000_000, maxTokens: 100_000}], tokenSize: {min: CHUNK_BYTES / 4, max: CHUNK_BYTES / 4}, tokensPerSecond: 256_000});
    const models = createModels();
    models.setProvider(faux.provider);
    const active = new Map<number, number>();
    const overlap = new Map<number, number>();
    let toolExecutions = 0;
    const tool = defineTool({
      name: "bench_output", description: "Return a deterministic bounded stream", parameters: Type.Object({slot: Type.Integer({minimum: 0, maximum: TOOL_COUNT - 1})}),
      replay: "safe", executionMode: "parallel", outputLimits: {maxBytes: TOOL_BYTES, maxLines: 10},
      async execute({slot}, api) {
        const id = Number(api.conversationId);
        active.set(id, (active.get(id) ?? 0) + 1);
        overlap.set(id, Math.max(overlap.get(id) ?? 0, active.get(id)!));
        toolExecutions++;
        try {
          for (let offset = 0; offset < TOOL_BYTES; offset += CHUNK_BYTES) {
            api.output(toolText(slot).slice(offset, offset + CHUNK_BYTES));
            await delay(2);
          }
          return {};
        } finally { active.set(id, active.get(id)! - 1); }
      },
    });
    const extension = {name: "bench", tools: [tool]};
    const registry = createRegistry();
    registry.install(extension);
    const options: HarnessOptions = {models, registry, settings: {compaction: {enabled: false}, retry: {enabled: false}, toolExecution: "parallel"}, onReport: error => reports.push(error)};
    storage = await openNodeSqliteStorage(databasePath);
    const originalCommit = storage.commit.bind(storage);
    storage.commit = async (...args) => { const seq = await originalCommit(...args); commits++; return seq; };
    harness = await openHarness(storage, options);
    const conversations: Conversation[] = [];
    for (let i = 0; i < concurrency; i++) conversations.push(await harness.createConversation({ownership: {kind: "ownerless"}, agent: {model: {provider: "bench-faux", modelId: "bench"}, extensions: [extension]}}, context));
    const respond = (request: {messages: readonly Message[]}) => {
      assert.equal(textOf(request.messages.find(m => m.role === "user")!), input);
      const results = request.messages.filter(m => m.role === "toolResult");
      if (results.length === 0) return fauxAssistantMessage(Array.from({length: TOOL_COUNT}, (_, slot) => fauxToolCall("bench_output", {slot}, {id: "call-" + slot})), {stopReason: "toolUse", timestamp: 1});
      assert.equal(results.length, TOOL_COUNT);
      for (let slot = 0; slot < TOOL_COUNT; slot++) assert.equal(textOf(results[slot]!), toolText(slot));
      return fauxAssistantMessage(answer, {timestamp: 1});
    };
    faux.setResponses(Array.from({length: 2 * concurrency}, () => respond));
    const rssStartBytes = process.memoryUsage().rss;
    let sampledRssPeakBytes = rssStartBytes;
    sampler = setInterval(() => {sampledRssPeakBytes = Math.max(sampledRssPeakBytes, process.memoryUsage().rss);}, 10);
    const commitStart = commits;
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    const settlements = await Promise.all(conversations.map(async c => (await c.submit({type: "input", content: input}, context)).wait(context)));
    await harness.waitForIdle(context);
    const wallMs = performance.now() - start;
    const cpu = process.cpuUsage(cpuStart);
    const rssEndBytes = process.memoryUsage().rss;
    sampledRssPeakBytes = Math.max(sampledRssPeakBytes, rssEndBytes);
    clearInterval(sampler); sampler = undefined;
    metrics = {phase, repetition, concurrency, wallMs, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, cpuTotalMs: (cpu.user + cpu.system) / 1000, rssStartBytes, rssEndBytes, sampledRssPeakBytes, processLifetimeMaxRssKiB: process.resourceUsage().maxRSS, storageCommits: commits - commitStart, toolExecutions, perConversationMaxToolOverlap: [...overlap.values()]};
    assert(settlements.every(s => s.status === "done"), JSON.stringify(settlements));
    assert.equal(faux.state.callCount, 2 * concurrency);
    assert.equal(faux.getPendingResponseCount(), 0);
    assert.equal(toolExecutions, TOOL_COUNT * concurrency);
    assert.equal(overlap.size, concurrency);
    assert([...overlap.values()].every(count => count >= 2), "parallel tool overlap not observed");
    assert([...active.values()].every(count => count === 0));
    assert.equal(reports.length, 0, String(reports));
    assert.equal((await harness.inspect(context)).tasks.length, 0);
    for (const c of conversations) await verifyTranscript(c);
    const ids = conversations.map(c => c.id);
    await harness.close(context); harness = undefined;
    await storage.close(context); storage = undefined;
    storage = await openNodeSqliteStorage(databasePath);
    harness = await openHarness(storage, options);
    for (const id of ids) {
      const reopened = await harness.conversation(id, context);
      assert(reopened);
      await verifyTranscript(reopened);
    }
    assert.equal((await harness.inspect(context)).tasks.length, 0);
  } finally {
    if (sampler) clearInterval(sampler);
    try { if (harness) await harness.close(context); }
    finally { if (storage) await storage.close(context); }
  }
  assert(metrics);
  return {...metrics, exactTranscriptVerified: true, persistedReadbackVerified: true, temporaryDirectory: directory};
}

const startedAt = new Date().toISOString();
const environment = {bun: Bun.version, nodeCompat: process.version, platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytesAtStart: freemem(), deepworkTypecheckJobs: process.env.DEEPWORK_TYPECHECK_JOBS ?? null, gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(), durableVersion: version("pi-durable"), aiVersion: version("pi-ai"), chordVersion: version("chord"), scriptSha256: sha256(readFileSync(import.meta.filename, "utf8"))};
// Bun on Windows can retain node:sqlite file mappings after close (EBUSY).
// Do not change storage behavior or hide that defect: join a bounded child, then
// remove its owned directory after OS process teardown. No retry or forced GC.
if (workerRoot) {
  const warmup = await run("warmup-correctness", 0);
  const measured = workerRepetition > 0 ? await run("measured", workerRepetition) : null;
  console.log(JSON.stringify({warmup, measured}));
} else {
function worker(repetition: number) {
  const directory = mkdtempSync(join(tmpdir(), "dinobot-durable-stream-"));
  let result: {warmup: Record<string, unknown>; measured: Record<string, unknown> | null};
  try {
    const output = execFileSync(process.execPath, [import.meta.filename, String(concurrency), directory, String(repetition)], {encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024, env: {...process.env, DEEPWORK_TYPECHECK_JOBS: "2"}});
    result = JSON.parse(output);
  } finally { rmSync(directory, {recursive: true, force: false}); }
  assert.equal(existsSync(directory), false);
  return {...result, cleanupVerified: true, temporaryDirectory: directory};
}
// Preflight proves content, durable reopen AND process-bound cleanup before
// admitting any measurement. Every measured process additionally warms up.
const preflight = worker(0);
const warmup = preflight.warmup;
const samples = [];
for (let repetition = 1; repetition <= REPETITIONS; repetition++) {
  const result = worker(repetition);
  samples.push({...result.measured, cleanupVerified: result.cleanupVerified, workerWarmup: result.warmup});
}
console.log(JSON.stringify({schema: "dinobot-durable-streaming-v1", startedAt, environment, workload: {concurrency, inputBytesPerConversation: INPUT_BYTES, assistantOutputBytesPerConversation: OUTPUT_BYTES, toolCountPerConversation: TOOL_COUNT, toolOutputBytesPerCall: TOOL_BYTES, providerChunkBytes: CHUNK_BYTES, providerTokensPerSecond: 256_000, toolChunkDelayMs: 2, measuredRepetitions: REPETITIONS, warmupRepetitions: 4, inputSha256: sha256(input), answerSha256: sha256(answer)}, metricNotes: {wallAndCpu: "submit through idle; excludes setup, readback and cleanup; CPU is current process, not whole host", sampledRss: "10ms sample + interval endpoints; can miss synchronous peaks", maxRss: "OS worker-process lifetime high-water in KiB; includes setup and one warmup, not other repetitions", commits: "successful Storage.commit calls during timed interval, not individual SQL statements", cadence: "fixed chunk size; timer scheduling and stream commit throttling depend on OS load", limitations: "synthetic keyless provider; no network, UI, compaction, cancellation or crash-resume workload; concurrent host work can add noise"}, preflightCleanupVerified: preflight.cleanupVerified, warmup, samples}, null, 2));
}
