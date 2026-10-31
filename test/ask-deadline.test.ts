import { expect, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { AsksDoc, LinkDoc, type AskRecord } from "../src/core/ask.ts";
import { askExtension } from "../src/extensions/ask.ts";

async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function fixture() {
 let now = 10000, sequence = 0;
 const timers = new Map<number, {at: number; run: () => void}>();
 const clock = spyOn(Date, "now").mockImplementation(() => now);
 const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, ms: number) => {
  timers.set(++sequence, {at: now + ms, run}); return sequence;
 }) as unknown as typeof setTimeout);
 const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {timers.delete(id);}) as typeof clearTimeout);
 const state = {asks: [] as AskRecord[]};
 const listeners = new Set<(value: typeof state) => Promise<void>>();
 const controller = new AbortController();
 const ctx = {...context, abortSignal: controller.signal};
 const api = (child: boolean) => ({
  conversationId: child ? 2 : 1, taskId: 3,
  snapshot: async (token: unknown) => token === LinkDoc ? (child ? {parent: 1} : {}) : token === AsksDoc ? structuredClone(state) : undefined,
  commit: async (fn: (tx: unknown) => Promise<unknown>) => {
   const result = await fn({doc: async () => state});
   for (const listener of listeners) await listener(structuredClone(state));
   return result;
  },
  watchDoc: async () => {
   let listener: ((value: typeof state) => Promise<void>) | undefined;
   return {value: structuredClone(state), start: (fn: typeof listener) => {listener = fn; listeners.add(fn!);}, stop: async () => {if (listener) listeners.delete(listener);}};
  },
 }) as unknown as ToolExecutionApi;
 const tools = askExtension({} as never, () => ({} as never)).tools!;
 const ask = tools.find(t => t.name === "ask")!;
 const answer = tools.find(t => t.name === "answer")!;
 return {state, timers,
  ask: (args: Record<string, unknown>, child = true) => ask.execute!({question: "Which?", kind: "clarification", default: "fallback", ...args} as never, api(child), ctx),
  answer: (id: string, value: string) => answer.execute!({ask_id: id, answer: value} as never, api(false), ctx),
  async advance(at: number) {now = at; for (const [id, timer] of [...timers]) if (timer.at <= now) {timers.delete(id); timer.run();} await flush();},
  async close() {controller.abort(new Error("cleanup")); await flush(); clock.mockRestore(); schedule.mockRestore(); clear.mockRestore();},
 };
}

test.each([
 [1000, 60000], [59999, 60000], [60000, 60000], [60001, 60001],
 [undefined, 900000], [86400000, 86400000], [86400001, 86400000],
])("subagent deadline %s clamps to %s with exact timer boundary", async (requested, expected) => {
 const f = fixture(); let result: unknown;
 const pending = f.ask(requested === undefined ? {} : {deadline_ms: requested}).then(r => {result = r;}, e => {result = e;});
 try {
  await flush(); const record = f.state.asks[0]!;
  expect(record.deadlineAt - record.createdAt).toBe(expected!);
  await f.advance(record.deadlineAt - 1); expect(record.state).toBe("open"); expect(result).toBeUndefined();
  await f.advance(record.deadlineAt); await pending;
  expect(record).toMatchObject({state: "defaulted", answer: "fallback", resolvedAt: record.deadlineAt});
  expect(result).toMatchObject({details: {ask: {state: "defaulted"}}}); expect(f.timers.size).toBe(0);
 } finally {await f.close(); await pending;}
});

test("answer within the floor wins; identical questions do not extend the deadline", async () => {
 const f = fixture(); const a = f.ask({deadline_ms: 1000}); const b = f.ask({deadline_ms: 86400000});
 try {
  await flush(); expect(f.state.asks).toHaveLength(1); const record = f.state.asks[0]!;
  expect(record.deadlineAt - record.createdAt).toBe(60000);
  await f.advance(record.createdAt + 4500);
  await f.answer(record.id, "yes with constraints");
  for (const result of await Promise.all([a, b])) expect(result).toMatchObject({details: {ask: {state: "answered", answer: "yes with constraints"}}});
  expect(await f.ask({deadline_ms: 1000})).toMatchObject({details: {ask: {state: "answered"}}});
  expect(f.state.asks).toHaveLength(1); expect(f.timers.size).toBe(0);
 } finally {await f.close(); await Promise.allSettled([a, b]);}
});

test("authority defaults to deny at the floor and late answers remain facts, not permission", async () => {
 const f = fixture(); const pending = f.ask({kind: "authority", default: "allow", deadline_ms: 1000});
 try {
  await flush(); const record = f.state.asks[0]!;
  expect(record.deadlineAt - record.createdAt).toBe(60000);
  await f.advance(record.deadlineAt); await pending;
  expect(record).toMatchObject({state: "defaulted", answer: "deny"});
  await f.advance(record.deadlineAt + 1);
  expect(await f.answer(record.id, "allow")).toMatchObject({isError: true});
  expect(record).toMatchObject({state: "defaulted", answer: "deny", late: {answer: "allow", at: record.deadlineAt + 1}});
 } finally {await f.close(); await pending;}
});

test.each([[1000, 1000], [59999, 59999], [undefined, 86400000], [604800001, 604800000]])("human deadline %s remains %s", async (requested, expected) => {
 const f = fixture();
 try {
  await f.ask({to: "human", ...(requested === undefined ? {} : {deadline_ms: requested})}, false);
  const record = f.state.asks[0]!; expect(record.to).toBe("human");
  expect(record.deadlineAt - record.createdAt).toBe(expected!); expect(f.timers.size).toBe(0);
 } finally {await f.close();}
});
