import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { EntryDraft } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot } from "../src/core/bot.ts";
import { startClientApi } from "../src/api/server.ts";
import type { ClientEvent } from "../src/core/ui-contract.ts";

const limit = 8 * 1024 * 1024;
const encode = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
// Distinct blocks expose same-length duplication/reordering as well as truncation.
function payload(size: number): string {
 const block = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
 return Array.from({length: Math.ceil(size / 4096)}, (_, i) =>
  i.toString(16).padStart(8, "0") + block.repeat(64).slice(8),
 ).join("").slice(0, size);
}
function toolResult(frameBytes: number): EntryDraft {
 const message = {
  role: "toolResult" as const, toolCallId: "synthetic-call", toolName: "codemode",
  isError: false, timestamp: 1,
  content: [
   {type: "text" as const, text: "synthetic images 한😀"},
   ...[0, 1, 2].map(() => ({type: "image" as const, mimeType: "image/png", data: ""})),
  ],
 };
 const remaining = frameBytes - Buffer.byteLength(encode({type: "message_start", message}));
 for (let i = 1; i <= 3; i++) {
  const block = message.content[i]!;
  if (block.type === "image") block.data = payload(Math.floor(remaining / 3) + (i === 3 ? remaining % 3 : 0));
 }
 expect(Buffer.byteLength(encode({type: "message_start", message}))).toBe(frameBytes);
 return {kind: "pi.tool-result", model: [message]};
}

const cases: {name: string; drafts: () => EntryDraft[]; frames: number; paired?: boolean}[] = [
 ...([
  ["normal", [1024, 1]],
  ["oversized then delta", [limit + 1, 1]],
  ["burst", [3 * 1024 * 1024, 3 * 1024 * 1024, 3 * 1024 * 1024, 3 * 1024 * 1024]],
 ] as const).map(([name, sizes]) => ({name, drafts: () => sizes.map((size, i) => ({kind: "test.batch", data: payload(size) + `:${i}:한😀`})), frames: sizes.length})),
 // Each frame fits individually, but the real adapter publishes two copies in one batch.
 // The standalone pair is a control: the socket can consume its first frame immediately.
 {name: "single tool result below pair limit", drafts: () => [toolResult(1024)], frames: 2, paired: true},
 {name: "single tool result above pair limit", drafts: () => [toolResult(4234224)], frames: 2, paired: true},
 // A preceding delta consumes that immediate socket write; the following pair must yield.
 {name: "single tool result above pair limit after delta", drafts: () => [{kind: "test.delta", data: "preceding"}, toolResult(4234224)], frames: 3, paired: true},
];

for (const scenario of cases) test("live batch " + scenario.name + " preserves exact frames on a reading HTTP client", async () => {
 const dir = await mkdtemp(join(tmpdir(), "sse-batch-"));
 const bot = await openBot({storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models: createModels(), defaultModel: {provider: "unused", modelId: "unused"}, toolMode: "direct", plugins: []}, context);
 const api = startClientApi(bot, 0, context, {list: () => [], find: () => undefined, answer: () => false, run() {throw Error("unused");}});
 const abort = new AbortController();
 const timer = setTimeout(() => abort.abort(), 8000);
 try {
  const conversation = await bot.conversation("tui", "batch", context);
  const response = await fetch(new URL(`/v1/conversations/${conversation.id}/events`, api.url), {signal: abort.signal});
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let initial = false;
  const seen: string[] = [];
  const expected: string[] = [];
  let commit: Promise<unknown> | undefined;
  try {
   while (seen.length < scenario.frames) {
    const next = await reader.read();
    if (next.done) break;
    buffer += decoder.decode(next.value, {stream: true});
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
     const frame = buffer.slice(0, end + 2);
     buffer = buffer.slice(end + 2);
     if (!frame.startsWith("data:")) continue;
     const event = JSON.parse(frame.slice(5)) as ClientEvent;
     if (event.type === "snapshot" && !initial) {
      initial = true;
      commit = bot.harness.commit(async tx => {
       for (const draft of scenario.drafts()) {
        const entry = await tx.appendEntry(conversation.id, draft);
        const message = entry.model?.[0];
        if (message) expected.push(encode({type: "message_start", message}), encode({type: "message_end", entry}));
        else expected.push(encode({type: "entry_appended", entry}));
       }
      }, context);
     }
     if (["entry_appended", "message_start", "message_end"].includes(event.type)) seen.push(frame);
    }
   }
   await commit;
   expect(initial).toBe(true);
   expect(seen.length).toBe(scenario.frames);
   // Full serialized equality proves payload, metadata, UTF-8 decoding and event order.
   expect(seen).toEqual(expected);
   if (scenario.paired) {
    const sizes = expected.slice(-2).map(frame => Buffer.byteLength(frame));
    expect(sizes.every(size => size < limit)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0) > limit).toBe(scenario.name.includes("above"));
   }
  } finally {await reader.cancel().catch(() => {}); await commit;}
 } finally {clearTimeout(timer); abort.abort(); await api.stop(); await bot.close(context); await rm(dir, {recursive: true, force: true});}
}, 12000);
