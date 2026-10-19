import { describe, expect, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, WatchEnd } from "@earendil-works/pi-durable";
import { CommittedWatch } from "../node_modules/@earendil-works/pi-durable/dist/session/observation.js";
import { awaitClaim } from "../src/extensions/sessions.ts";
import { acquire, ClaimsDoc, claimOnce, describeClaim, release, type ClaimsState, type ClaimToolResult } from "../src/core/claims.ts";

const request = { key: "repo:x/src", holder: "b", intent: "edit", ttlMs: 1000, waitMs: 100 };
const blocked = () => {
 const state: ClaimsState = { nextToken: 1, claims: [] };
 acquire(state, { ...request, key: "repo:x", holder: "a", ttlMs: 50 }, 0);
 return state;
};
type Receipt = { result?: ClaimToolResult; deadlineAt?: number };

// Virtual time and an explicit watch/commit scheduler: no wall-clock sleeps.
async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function fixture(realWatcher = false) {
 let now = 10;
 let id = 0;
 const timers = new Map<number, { at: number; run: () => void }>();
 const clock = spyOn(Date, "now").mockImplementation(() => now);
 const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, ms: number) => {
  timers.set(++id, { at: now + ms, run }); return id;
 }) as unknown as typeof setTimeout);
 const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((key: number) => { timers.delete(key); }) as typeof clearTimeout);
 const controller = new AbortController();
 const context = { ...BACKGROUND_CONTEXT, abortSignal: controller.signal };
 const add = spyOn(controller.signal, "addEventListener");
 const remove = spyOn(controller.signal, "removeEventListener");
 const state = blocked();
 const receipt: Receipt = {};
 let listener: ((state: ClaimsState) => Promise<void>) | undefined;
 let stopped = 0; let commits = 0; let watches = 0;
 let onStart: (() => void) | undefined;
 let onWatch: (() => void) | undefined;
 let afterCommit: (() => void | Promise<void>) | undefined;
 let failCommit = false;
 let watch: CommittedWatch<Readonly<ClaimsState> | null> | undefined;
 const api = {
  taskId: "claim-test",
  commit: async (change: (tx: unknown) => Promise<unknown>) => {
   commits++;
   if (failCommit) throw new Error("commit failed");
   const result = await change({ doc: async (token: unknown) => token === ClaimsDoc ? state : receipt });
   await afterCommit?.();
   return result;
  },
  watchDoc: async () => {
   watches++;
   const value = structuredClone(state);
   onWatch?.();
   if (realWatcher) {
    watch = new CommittedWatch<Readonly<ClaimsState> | null>(value, () => { stopped++; });
    watch.observeCancellation(controller.signal);
    return watch;
   }
   const closed = Promise.withResolvers<WatchEnd>();
   return { value, closed: closed.promise, start: (fn: typeof listener) => { listener = fn; onStart?.(); }, stop: async () => { stopped++; listener = undefined; closed.resolve({ reason: "stopped" }); return closed.promise; } };
  },
 } as unknown as ToolExecutionApi;
 return {
  state, receipt, api, context, controller, timers,
  get watch() { return watch; },
  get commits() { return commits; }, get watches() { return watches; },
  set onStart(fn: () => void) { onStart = fn; }, set onWatch(fn: () => void) { onWatch = fn; },
  set afterCommit(fn: () => void | Promise<void>) { afterCommit = fn; }, set failCommit(value: boolean) { failCommit = value; },
  async publish() {
   if (watch) watch.advance(structuredClone(state), [], context);
   else await listener?.(structuredClone(state));
   await flush();
  },
  async advance(at: number) {
   now = at;
   for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.run(); }
   await flush();
  },
  assertClean(expectedWatches = 1) {
   expect(stopped).toBe(expectedWatches); expect(timers.size).toBe(0);
   expect(remove.mock.calls.length).toBe(add.mock.calls.length);
  },
  restore() { clock.mockRestore(); schedule.mockRestore(); clear.mockRestore(); add.mockRestore(); remove.mockRestore(); },
 };
}

describe("real claim watcher faults", () => {
 for (const phase of ["initial", "callback"] as const) test(phase + " signature failure propagates and disposes real watcher resources", async () => {
  const f = fixture(true);
  const failure = new Error(phase + " signature failed");
  const stringify = JSON.stringify;
  let inject = phase === "initial";
  const serialization = spyOn(JSON, "stringify").mockImplementation(((value: unknown, ...args: unknown[]) => {
   if (inject && Array.isArray(value) && value.some(claim => claim?.holder === "a")) throw failure;
   return (stringify as (...args: unknown[]) => string)(value, ...args);
  }) as typeof JSON.stringify);
  let observed: unknown;
  const done = awaitClaim(f.api, request, f.context).then(result => { observed = result; }, error => { observed = error; });
  try {
   await flush();
   if (phase === "callback") {
    expect(f.timers.size).toBe(1);
    inject = true;
    await f.publish();
    expect(await f.watch!.closed).toEqual({ reason: "listener_error", error: failure });
   }
   await flush();
   expect(observed).toBe(failure);
   f.assertClean();
   expect(f.receipt).toEqual({ deadlineAt: 110 });
   expect(f.state.claims.map(claim => claim.holder)).toEqual(["a"]);
   // A failed invocation must not reset or terminalize the durable budget.
   inject = false;
   await f.advance(110);
   expect(await awaitClaim(f.api, { ...request, waitMs: 45000 }, BACKGROUND_CONTEXT)).toMatchObject({ status: "timeout", deadlineAt: 110 });
  } finally {
   inject = false;
   serialization.mockRestore();
   f.controller.abort(new Error("test cleanup"));
   await done;
   await f.watch?.stop();
   f.restore();
  }
 });
 for (const reason of ["stopped", "cancelled", "session_closed"] as const) test("real watcher " + reason + " ends waiting without a deadline wake", async () => {
  const f = fixture(true);
  let observed: unknown;
  const done = awaitClaim(f.api, request, f.context).then(result => { observed = result; }, error => { observed = error; });
  try {
   await flush();
   const commits = f.commits;
   if (reason === "stopped") await f.watch!.stop();
   else if (reason === "cancelled") f.watch!.cancel();
   else f.watch!.closeSession();
   await flush();
   expect(observed).toBeInstanceOf(Error);
   expect((observed as Error).message).toContain(reason);
   expect(f.commits).toBe(commits);
   expect(f.receipt).toEqual({ deadlineAt: 110 });
   f.assertClean();
  } finally {
   f.controller.abort(new Error("test cleanup"));
   await done;
   await f.watch?.stop();
   f.restore();
  }
 });
});

describe("claim watcher lifecycle", () => {
 test("release wakes once; unrelated changes do not cause busy rechecks", async () => {
  const f = fixture();
  try {
   const done = awaitClaim(f.api, request, f.context); await flush();
   expect(f.receipt.deadlineAt).toBe(110); expect(f.commits).toBe(2);
   expect([...f.timers.values()].map(t => t.at)).toEqual([50]);
   acquire(f.state, { ...request, key: "repo:other", holder: "z" }, 11);
   await f.publish(); expect(f.commits).toBe(2);
   release(f.state, "a", undefined, 20); await f.publish();
   expect(await done).toMatchObject({ status: "granted", claims: [{ holder: "b", token: 3 }] });
   f.assertClean();
  } finally { f.restore(); }
 });
 test("timer wakes at expiry; renewal reschedules to deadline without eviction", async () => {
  const f = fixture();
  try {
   const done = awaitClaim(f.api, request, f.context); await flush();
   acquire(f.state, { ...request, key: "repo:x", holder: "a", ttlMs: 200 }, 20);
   await f.publish(); expect([...f.timers.values()].map(t => t.at)).toEqual([110]);
   const before = f.commits; await f.advance(50); expect(f.commits).toBe(before);
   await f.advance(110);
   expect(await done).toMatchObject({ status: "timeout", deadlineAt: 110, claims: [{ holder: "a", expiresAt: 220 }] });
   expect(f.state.claims[0]?.holder).toBe("a"); f.assertClean();
  } finally { f.restore(); }
 });
 test("expiry without a publication grants and cleans the timer", async () => {
  const f = fixture();
  try {
   const done = awaitClaim(f.api, request, f.context); await flush(); await f.advance(50);
   expect(await done).toMatchObject({ status: "granted", claims: [{ token: 2 }] }); f.assertClean();
  } finally { f.restore(); }
 });
 for (const gap of ["onWatch", "onStart", "afterCommit"] as const) test("release in " + gap + " gap is not lost", async () => {
  const f = fixture();
  try {
   f[gap] = () => { release(f.state, "a", undefined, 20); };
   const done = awaitClaim(f.api, request, f.context); await flush();
   expect(await done).toMatchObject({ status: "granted" }); f.assertClean();
  } finally { f.restore(); }
 });
 test("release after recheck but before await is not lost", async () => {
  const f = fixture();
  try {
   f.afterCommit = async () => {
    if (f.commits === 2) { release(f.state, "a", undefined, 20); await f.publish(); }
   };
   const done = awaitClaim(f.api, request, f.context); await flush();
   expect(await done).toMatchObject({ status: "granted" }); f.assertClean();
  } finally { f.restore(); }
 });
 test("abort while waiting cleans up; replay resumes with the same deadline", async () => {
  const f = fixture();
  try {
   const done = awaitClaim(f.api, request, f.context).catch(error => error);
   await flush(); f.controller.abort(new Error("cancelled")); expect((await done).message).toBe("cancelled");
   f.assertClean(); expect(f.receipt.result).toBeUndefined(); expect(f.receipt.deadlineAt).toBe(110);
   const resumed = awaitClaim(f.api, { ...request, waitMs: 45000 }, BACKGROUND_CONTEXT); await flush();
   await f.advance(110); expect(await resumed).toMatchObject({ status: "timeout", deadlineAt: 110 }); f.assertClean(2);
  } finally { f.restore(); }
 });
 test("abort during watch acquisition and commit failure both dispose resources", async () => {
  const f = fixture();
  try {
   f.onWatch = () => { f.controller.abort(new Error("cancelled")); };
   await expect(awaitClaim(f.api, request, f.context)).rejects.toThrow("cancelled"); f.assertClean();
  } finally { f.restore(); }
  const g = fixture();
  try {
   const done = awaitClaim(g.api, request, g.context).catch(error => error);
   await flush(); g.failCommit = true; await g.advance(50); expect((await done).message).toBe("commit failed"); g.assertClean();
  } finally { g.restore(); }
 });
 test("pre-aborted and immediate calls never allocate a watcher", async () => {
  const f = fixture();
  try {
   f.controller.abort(new Error("cancelled"));
   await expect(awaitClaim(f.api, request, f.context)).rejects.toThrow("cancelled"); expect(f.commits).toBe(0);
   expect(await awaitClaim(f.api, { ...request, waitMs: 0 }, BACKGROUND_CONTEXT)).toMatchObject({ status: "conflict" });
   expect(f.watches).toBe(0); f.assertClean(0);
  } finally { f.restore(); }
 });
});

describe("durable bounded claim transition", () => {
 test("conflict waits without terminal receipt, then release grants exactly once", () => {
  const state = blocked(); const receipt: Receipt = {};
  expect(claimOnce(receipt, state, request, 10)).toMatchObject({ status: "waiting", deadlineAt: 110, retryAt: 50 });
  expect(receipt.result).toBeUndefined();
  release(state, "a", undefined, 20);
  expect(claimOnce(receipt, state, request, 20)).toMatchObject({ status: "granted", claims: [{ token: 2, expiresAt: 1020 }] });
  expect(claimOnce(receipt, state, request, 30)).toMatchObject({ claims: [{ token: 2, expiresAt: 1020 }] });
  expect(state.nextToken).toBe(3);
 });
 test("expiry grants, renewal moves retry time but never the persisted deadline", () => {
  const state = blocked(); const receipt: Receipt = {};
  claimOnce(receipt, state, request, 10);
  acquire(state, { ...request, key: "repo:x", holder: "a", ttlMs: 70 }, 20);
  expect(claimOnce(receipt, state, request, 50)).toMatchObject({ status: "waiting", deadlineAt: 110, retryAt: 90 });
  expect(claimOnce(receipt, state, request, 90)).toMatchObject({ status: "granted", claims: [{ holder: "b" }] });
 });
 test("restart preserves deadline; deadline wins release race and failed receipts stay failed", () => {
  let state = blocked(); let receipt: Receipt = {};
  claimOnce(receipt, state, request, 10);
  state = JSON.parse(JSON.stringify(state)); receipt = JSON.parse(JSON.stringify(receipt));
  release(state, "a", undefined, 109);
  expect(claimOnce(receipt, state, { ...request, waitMs: 45000 }, 110)).toMatchObject({ status: "timeout", isError: true, deadlineAt: 110 });
  expect(claimOnce(receipt, state, request, 111)).toMatchObject({ status: "timeout", isError: true });
  expect(state.nextToken).toBe(2);
 });
 test("legacy failed receipts never become waits or acquisitions", () => {
  const state = blocked(); const receipt: Receipt = {};
  const prior = claimOnce(receipt, state, { ...request, waitMs: 0 }, 10);
  release(state, "a", undefined, 20);
  expect(claimOnce(receipt, state, request, 20)).toEqual(prior);
  expect(state.nextToken).toBe(2);
 });
 test("replay after a granted lease lapses never reacquires", () => {
  const state = blocked(); const receipt: Receipt = {};
  claimOnce(receipt, state, request, 10);
  claimOnce(receipt, state, request, 50);
  expect(claimOnce(receipt, state, request, 1050)).toMatchObject({ status: "lapsed", isError: true });
  expect(state.nextToken).toBe(3);
 });
 test("a parent wait rechecks every blocker and cannot grant after only one expires", () => {
  const state: ClaimsState = { nextToken: 1, claims: [] }; const receipt: Receipt = {};
  acquire(state, { ...request, key: "repo:x/one", holder: "a", ttlMs: 40 }, 0);
  acquire(state, { ...request, key: "repo:x/two", holder: "c", ttlMs: 80 }, 0);
  const parent = { ...request, key: "repo:x" };
  expect(claimOnce(receipt, state, parent, 10)).toMatchObject({ status: "waiting", retryAt: 40 });
  expect(claimOnce(receipt, state, parent, 40)).toMatchObject({ status: "waiting", retryAt: 80, claims: [{ holder: "c" }] });
  expect(claimOnce(receipt, state, parent, 80)).toMatchObject({ status: "granted", claims: [{ holder: "b", token: 3 }] });
 });
 test("an expired quarantined blocker never schedules a retry in the past or shows a countdown", () => {
  const state: ClaimsState = { nextToken: 1, claims: [] }; const receipt: Receipt = {};
  acquire(state, { ...request, key: "repo:x", holder: "a", ttlMs: 40 }, 0);
  state.claims[0]!.quarantined = "UNKNOWN native process provenance";
  // Past its TTL the quarantined claim still blocks; only the deadline (or a claim change) can wake the wait.
  expect(claimOnce(receipt, state, request, 60)).toMatchObject({ status: "waiting", deadlineAt: 160, retryAt: 160 });
  acquire(state, { ...request, key: "repo:x/live", holder: "c", ttlMs: 100 }, 60);
  expect(claimOnce(receipt, state, request, 70)).toMatchObject({ status: "waiting", retryAt: 160 });
  const immediate = claimOnce({}, state, { key: "repo:x/other", holder: "b", intent: "edit", ttlMs: 1000 }, 70);
  expect(immediate).toMatchObject({ status: "conflict" });
  expect("retryAt" in immediate).toBe(false);
  expect(immediate.text).toContain("quarantined: UNKNOWN native process provenance; TTL does not release it");
  expect(immediate.text).not.toContain("0m left");
  expect(immediate.text).toContain("GET /v1/claims/quarantine");
  expect(describeClaim(state.claims[0]!, 70)).not.toMatch(/m left/);
 });
 test("a live blocker beside a quarantined one still drives the retry time", () => {
  const state: ClaimsState = { nextToken: 1, claims: [] }; const receipt: Receipt = {};
  acquire(state, { ...request, key: "repo:x/one", holder: "a", ttlMs: 40 }, 0);
  acquire(state, { ...request, key: "repo:x/two", holder: "c", ttlMs: 80 }, 0);
  state.claims[0]!.quarantined = "UNKNOWN native process provenance";
  expect(claimOnce(receipt, state, { ...request, key: "repo:x" }, 50)).toMatchObject({ status: "waiting", retryAt: 80 });
 });
 test("two contenders cannot overlap after release", () => {
  const state = blocked(); const one: Receipt = {}; const two: Receipt = {};
  claimOnce(one, state, request, 10);
  claimOnce(two, state, { ...request, holder: "c" }, 10);
  release(state, "a", undefined, 20);
  expect(claimOnce(one, state, request, 20)).toMatchObject({ status: "granted" });
  expect(claimOnce(two, state, { ...request, holder: "c" }, 20)).toMatchObject({ status: "waiting" });
  expect(state.claims.map(c => c.holder)).toEqual(["b"]);
 });
});
