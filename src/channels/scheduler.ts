/**
 * Bounded keyed scheduler (ADR 0048 §3): in-memory cache of committed lane heads.
 *
 * State per lane ℓ: the committed head (minimum live seq of ℓ and its due time) and exactly one place:
 *   ready   — in the round-robin FIFO R (doubly linked, O(1) push/pop/remove)
 *   delayed — in the indexed min-heap Q keyed by (due, stamp), at most one entry per lane (O(log L))
 *   active  — owns one of the `capacity` slots (|A| ≤ C)
 * A lane is never in two places, so it can never run twice; the owner commits durable state first and only then
 * calls setHead, so this cache never runs ahead of the database. Lanes without a head are deleted (memory O(L)).
 */
export type LaneHead = { readonly seq: number; readonly due: number; readonly created: number };
type Place = "ready" | "delayed" | "active";
type Lane = { readonly key: string; head: LaneHead | undefined; place: Place; prev: Lane | undefined; next: Lane | undefined; heapIndex: number; stamp: number };

export class KeyedScheduler {
 readonly capacity: number;
 #lanes = new Map<string, Lane>();
 #first: Lane | undefined; #last: Lane | undefined; #ready = 0;
 #heap: Lane[] = [];
 #active = 0;
 #stamp = 0;

 constructor(capacity: number) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("scheduler capacity must be a positive integer");
  this.capacity = capacity;
 }
 get lanes(): number { return this.#lanes.size; }
 get active(): number { return this.#active; }
 get ready(): number { return this.#ready; }
 get delayed(): number { return this.#heap.length; }
 head(key: string): LaneHead | undefined { return this.#lanes.get(key)?.head; }
 isActive(key: string): boolean { return this.#lanes.get(key)?.place === "active"; }
 /** Earliest due among delayed lanes, for the single wake timer. */
 nextDue(): number | undefined { return this.#heap[0]?.head!.due; }
 /** Oldest head admission time, O(L); health only. */
 oldestCreated(): number | undefined {
  let oldest: number | undefined;
  for (const lane of this.#lanes.values()) if (lane.head && (oldest === undefined || lane.head.created < oldest)) oldest = lane.head.created;
  return oldest;
 }
 /** Ready lane keys in rotation order (tests/diagnostics only, O(L)). */
 readyOrder(): string[] { const keys: string[] = []; for (let lane = this.#first; lane; lane = lane.next) keys.push(lane.key); return keys; }

 /** The single head mutation point: record the committed head of `key` (undefined = no live job left). */
 setHead(key: string, head: LaneHead | undefined, now: number): void {
  const lane = this.#lanes.get(key);
  if (!lane) {
   if (!head) return;
   const created: Lane = { key, head, place: "ready", prev: undefined, next: undefined, heapIndex: -1, stamp: 0 };
   this.#lanes.set(key, created);
   this.#place(created, now);
   return;
  }
  lane.head = head;
  if (lane.place === "active") return; // re-placed on release
  if (!head) { this.#detach(lane); this.#lanes.delete(key); return; }
  if (head.due <= now) {
   if (lane.place === "delayed") { this.#heapRemove(lane); this.#push(lane); }
  } else if (lane.place === "ready") { this.#unlink(lane); this.#heapPush(lane); }
  else this.#heapFix(lane);
 }

 /** Move every lane whose due has passed to the ready tail, in (due, stamp) order. */
 promote(now: number): void {
  while (this.#heap.length && this.#heap[0]!.head!.due <= now) { const lane = this.#heap[0]!; this.#heapRemove(lane); this.#push(lane); }
 }

 /** Reserve a slot for the next ready lane in rotation order; undefined when no slot or no ready lane. */
 acquire(now: number): string | undefined {
  this.promote(now);
  if (this.#active >= this.capacity || !this.#first) return undefined;
  const lane = this.#first;
  this.#unlink(lane);
  lane.place = "active"; this.#active++;
  return lane.key;
 }

 /** Return a slot once its quantum has settled; the lane re-enters at the ready tail or the due heap. */
 release(key: string, now: number): void {
  const lane = this.#lanes.get(key);
  if (!lane || lane.place !== "active") throw new Error("release of a lane that holds no slot");
  this.#active--;
  if (!lane.head) { this.#lanes.delete(key); return; }
  this.#place(lane, now);
 }

 #place(lane: Lane, now: number) { if (lane.head!.due <= now) this.#push(lane); else this.#heapPush(lane); }
 #detach(lane: Lane) { if (lane.place === "ready") this.#unlink(lane); else if (lane.place === "delayed") this.#heapRemove(lane); }
 #push(lane: Lane) {
  lane.place = "ready"; lane.prev = this.#last; lane.next = undefined;
  if (this.#last) this.#last.next = lane; else this.#first = lane;
  this.#last = lane; this.#ready++;
 }
 #unlink(lane: Lane) {
  if (lane.prev) lane.prev.next = lane.next; else this.#first = lane.next;
  if (lane.next) lane.next.prev = lane.prev; else this.#last = lane.prev;
  lane.prev = lane.next = undefined; this.#ready--;
 }
 #less(a: Lane, b: Lane) { return a.head!.due < b.head!.due || (a.head!.due === b.head!.due && a.stamp < b.stamp); }
 #heapPush(lane: Lane) {
  lane.place = "delayed"; lane.stamp = ++this.#stamp; lane.heapIndex = this.#heap.length; this.#heap.push(lane); this.#up(lane.heapIndex);
 }
 #heapRemove(lane: Lane) {
  const index = lane.heapIndex, last = this.#heap.pop()!;
  lane.heapIndex = -1;
  if (last !== lane) { this.#heap[index] = last; last.heapIndex = index; this.#up(index); this.#down(last.heapIndex); }
 }
 #heapFix(lane: Lane) { this.#up(lane.heapIndex); this.#down(lane.heapIndex); }
 #swap(i: number, j: number) { const a = this.#heap[i]!, b = this.#heap[j]!; this.#heap[i] = b; this.#heap[j] = a; a.heapIndex = j; b.heapIndex = i; }
 #up(i: number) { while (i > 0) { const parent = (i - 1) >> 1; if (!this.#less(this.#heap[i]!, this.#heap[parent]!)) break; this.#swap(i, parent); i = parent; } }
 #down(i: number) {
  for (;;) {
   const l = 2 * i + 1, r = l + 1; let m = i;
   if (l < this.#heap.length && this.#less(this.#heap[l]!, this.#heap[m]!)) m = l;
   if (r < this.#heap.length && this.#less(this.#heap[r]!, this.#heap[m]!)) m = r;
   if (m === i) return;
   this.#swap(i, m); i = m;
  }
 }
}
