import { expect, test } from "bun:test";
import { KeyedScheduler, type LaneHead } from "../src/channels/scheduler.ts";

// ADR 0048 §8: fixed seed, 200 finite traces × ≤500 transitions, N ≤ 64 jobs, L ≤ 16 lanes, C ∈ {1,2,4,16}.
const SEED = 0x48c0ffee;
function rng(seed: number) { return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; }; }

/** Naive reference model with the same specification: arrays, linear scans, explicit sort. */
class Reference {
 lanes = new Map<string, { head: LaneHead | undefined; place: "ready" | "delayed" | "active"; stamp: number }>();
 ready: string[] = []; active = new Set<string>(); stamp = 0;
 constructor(readonly capacity: number) {}
 private place(key: string, now: number) {
  const lane = this.lanes.get(key)!;
  if (lane.head!.due <= now) { lane.place = "ready"; this.ready.push(key); } else { lane.place = "delayed"; lane.stamp = ++this.stamp; }
 }
 setHead(key: string, head: LaneHead | undefined, now: number) {
  const lane = this.lanes.get(key);
  if (!lane) { if (head) { this.lanes.set(key, { head, place: "ready", stamp: 0 }); this.place(key, now); } return; }
  lane.head = head;
  if (lane.place === "active") return;
  if (!head) { if (lane.place === "ready") this.ready.splice(this.ready.indexOf(key), 1); this.lanes.delete(key); return; }
  if (head.due <= now) { if (lane.place === "delayed") { lane.place = "ready"; this.ready.push(key); } }
  else if (lane.place === "ready") { this.ready.splice(this.ready.indexOf(key), 1); lane.place = "delayed"; lane.stamp = ++this.stamp; }
 }
 delayed() { return [...this.lanes].filter(([, l]) => l.place === "delayed").sort(([, a], [, b]) => a.head!.due - b.head!.due || a.stamp - b.stamp).map(([k]) => k); }
 promote(now: number) { for (const key of this.delayed()) { const lane = this.lanes.get(key)!; if (lane.head!.due > now) break; lane.place = "ready"; this.ready.push(key); } }
 acquire(now: number) {
  this.promote(now);
  if (this.active.size >= this.capacity || !this.ready.length) return undefined;
  const key = this.ready.shift()!; this.lanes.get(key)!.place = "active"; this.active.add(key); return key;
 }
 release(key: string, now: number) {
  this.active.delete(key); const lane = this.lanes.get(key)!;
  if (!lane.head) { this.lanes.delete(key); return; }
  this.place(key, now);
 }
 nextDue() { const first = this.delayed()[0]; return first === undefined ? undefined : this.lanes.get(first)!.head!.due; }
}

type Job = { seq: number; quanta: number };
/** Durable-side model: per-lane FIFO job lists; the scheduler only ever sees committed heads. */
function trace(index: number, random: () => number) {
 const capacity = [1, 2, 4, 16][index % 4]!;
 const laneCount = 1 + Math.floor(random() * 16);
 const impl = new KeyedScheduler(capacity), ref = new Reference(capacity);
 const jobs = new Map<string, Job[]>(); const due = new Map<number, number>();
 let seq = 0, now = 1000, admitted = 0;
 const log: string[] = [];
 const headOf = (lane: string): LaneHead | undefined => { const first = jobs.get(lane)?.[0]; return first ? { seq: first.seq, due: due.get(first.seq) ?? 0, created: first.seq } : undefined; };
 const commit = (lane: string) => { const head = headOf(lane); impl.setHead(lane, head, now); ref.setHead(lane, head, now); };
 const started = new Map<string, number>(); // lane -> seq dispatched
 const transitions = 1 + Math.floor(random() * 500);
 for (let step = 0; step < transitions; step++) {
  const action = random();
  if (action < 0.3 && admitted < 64) {
   const lane = "L" + Math.floor(random() * laneCount); const job = { seq: ++seq, quanta: 1 + Math.floor(random() * 4) };
   const list = jobs.get(lane) ?? []; list.push(job); jobs.set(lane, list); admitted++;
   if (list.length === 1) commit(lane); // behind an existing head nothing changes
   log.push("admit " + lane + " " + job.seq);
  } else if (action < 0.6) {
   const a = impl.acquire(now), b = ref.acquire(now);
   expect(a).toBe(b);
   if (a !== undefined) {
    const head = headOf(a)!;
    // Head exclusivity and lane FIFO: the dispatched job is the minimum live seq of its lane and is due.
    expect(head.seq).toBe(Math.min(...jobs.get(a)!.map(j => j.seq)));
    expect(head.due).toBeLessThanOrEqual(now);
    expect(started.has(a)).toBe(false);
    started.set(a, head.seq);
    log.push("dispatch " + a + " " + head.seq);
   } else {
    // Work conservation: no dispatch only when every slot is busy or no lane is eligible now.
    expect(impl.active === capacity || impl.ready === 0).toBe(true);
   }
  } else if (action < 0.9 && started.size) {
   const keys = [...started.keys()]; const lane = keys[Math.floor(random() * keys.length)]!;
   const job = jobs.get(lane)![0]!; expect(job.seq).toBe(started.get(lane)!);
   const outcome = random();
   if (outcome < 0.2) due.set(job.seq, now + 1 + Math.floor(random() * 50)); // retry: head stays, slot is returned
   else if (--job.quanta <= 0) { jobs.get(lane)!.shift(); if (!jobs.get(lane)!.length) jobs.delete(lane); }
   commit(lane);
   started.delete(lane); impl.release(lane, now); ref.release(lane, now);
   log.push("settle " + lane + " " + job.seq);
  } else now += Math.floor(random() * 30);
  expect(impl.active).toBeLessThanOrEqual(capacity);
  expect(impl.active).toBe(started.size);
  expect(impl.readyOrder()).toEqual(ref.ready);
  expect(impl.delayed).toBe(ref.delayed().length);
  expect(impl.nextDue()).toBe(ref.nextDue());
  expect(impl.lanes).toBe(jobs.size);
 }
 return log.length;
}

test("seed 0x48c0ffee: 200 finite traces match the reference scheduler and keep every invariant", () => {
 const random = rng(SEED); let transitions = 0;
 for (let i = 0; i < 200; i++) {
  try { transitions += trace(i, random); }
  catch (error) { throw new Error("seed 0x48c0ffee trace " + i + " failed: " + (error as Error).message); }
 }
 expect(transitions).toBeGreaterThan(200);
});

test("capacity C: C+1-th lane waits for a settled slot, and only lane heads run", () => {
 for (const capacity of [1, 2, 4, 16]) {
  const s = new KeyedScheduler(capacity);
  for (let i = 0; i < capacity + 2; i++) s.setHead("lane" + i, { seq: i + 1, due: 0, created: 0 }, 0);
  const running: string[] = [];
  for (let lane = s.acquire(0); lane !== undefined; lane = s.acquire(0)) running.push(lane);
  expect(running).toEqual(Array.from({ length: capacity }, (_, i) => "lane" + i));
  expect(s.acquire(0)).toBeUndefined();
  s.setHead("lane0", undefined, 0); s.release("lane0", 0);
  expect(s.acquire(0)).toBe("lane" + capacity);
 }
});

test("retry due releases the slot, keeps the head, and the lane rejoins the rotation tail when due", () => {
 const s = new KeyedScheduler(1);
 s.setHead("A", { seq: 1, due: 0, created: 0 }, 0); s.setHead("B", { seq: 2, due: 0, created: 0 }, 0);
 expect(s.acquire(0)).toBe("A");
 s.setHead("A", { seq: 1, due: 100, created: 0 }, 0); s.release("A", 0);
 expect(s.delayed).toBe(1); expect(s.nextDue()).toBe(100);
 expect(s.acquire(0)).toBe("B"); // the waiting lane holds no slot
 s.setHead("B", { seq: 3, due: 0, created: 0 }, 0); s.release("B", 0);
 expect(s.acquire(99)).toBe("B");
 s.release("B", 99);
 expect(s.acquire(100)).toBe("B"); // B was already ahead in the rotation; A joins the tail when due
 s.release("B", 100);
 expect(s.readyOrder()).toEqual(["A", "B"]);
 expect(s.head("A")!.seq).toBe(1);
});

test("hot/cold fairness: a cold lane is served within one rotation of a busy hot lane", () => {
 for (const capacity of [1, 2]) {
  const s = new KeyedScheduler(capacity);
  const hot: number[] = Array.from({ length: 50 }, (_, i) => i + 1);
  s.setHead("hot", { seq: hot[0]!, due: 0, created: 0 }, 0);
  for (let i = 0; i < 3; i++) s.setHead("warm" + i, { seq: 100 + i, due: 0, created: 0 }, 0);
  const order: string[] = [];
  for (let step = 0; step < 10; step++) { const lane = s.acquire(0)!; order.push(lane); s.release(lane, 0); }
  s.setHead("cold", { seq: 1000, due: 0, created: 0 }, 0);
  const ahead = s.readyOrder().length - 1;
  const after: string[] = [];
  for (let step = 0; step <= ahead; step++) { const lane = s.acquire(0)!; after.push(lane); if (lane === "hot") { hot.shift(); s.setHead("hot", { seq: hot[0]!, due: 0, created: 0 }, 0); } s.release(lane, 0); }
  expect(after).toContain("cold");
  expect(after.filter(l => l === "hot").length).toBeLessThanOrEqual(1);
 }
});

test("setHead re-keys delayed lanes in place and removes empty lanes from every structure", () => {
 const s = new KeyedScheduler(2);
 for (let i = 0; i < 8; i++) s.setHead("d" + i, { seq: i + 1, due: 100 - i, created: i }, 0);
 expect(s.nextDue()).toBe(93);
 s.setHead("d7", { seq: 8, due: 200, created: 7 }, 0);
 expect(s.nextDue()).toBe(94);
 s.setHead("d6", undefined, 0);
 expect(s.lanes).toBe(7); expect(s.delayed).toBe(7);
 s.setHead("d5", { seq: 6, due: 0, created: 5 }, 0);
 expect(s.readyOrder()).toEqual(["d5"]); expect(s.delayed).toBe(6);
 s.promote(100);
 expect(s.readyOrder()).toEqual(["d5", "d4", "d3", "d2", "d1", "d0"]);
 expect(s.oldestCreated()).toBe(0);
 expect(() => s.release("d0", 100)).toThrow();
});
