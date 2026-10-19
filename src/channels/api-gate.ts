export type GatePolicy = {
	/** G1: minimum spacing of any two API request starts of the bot. */
	readonly botSpacingMs: number;
	/** G2: minimum spacing of two writes with one rate key (Telegram: one chat). */
	readonly chatSpacingMs: number;
	/** G3: rolling window length and the writes allowed in it per rate key. */
	readonly chatWindowMs: number;
	readonly chatWindowLimit: number;
	/** G5: longest server lower bound honoured by waiting; larger bounds fail closed. At most the engine retry budget. */
	readonly maxCooldownMs: number;
	/** Longest a best-effort progress call waits for a permit before it is skipped. */
	readonly progressWaitMs: number;
};

/** Production Telegram policy: 40 ms bot start spacing (≤ 25 starts/s), 1 s per chat, ≤ 20 writes per rolling 60 s. */
export const TELEGRAM_GATE_POLICY: GatePolicy = Object.freeze({
	botSpacingMs: 40,
	chatSpacingMs: 1_000,
	chatWindowMs: 60_000,
	chatWindowLimit: 20,
	maxCooldownMs: 60_000,
	progressWaitMs: 3_000,
});

const int = (value: unknown, min: number, max: number) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
/** Exact validation; the engine retry budget (60 s) bounds maxCooldownMs. */
export function validGatePolicy(policy: GatePolicy): boolean {
	return (
		int(policy.botSpacingMs, 1, 60_000) &&
		int(policy.chatWindowMs, 1, 3_600_000) &&
		int(policy.chatSpacingMs, 1, policy.chatWindowMs) &&
		int(policy.chatWindowLimit, 1, 1_000) &&
		int(policy.maxCooldownMs, 1, 60_000) &&
		int(policy.progressWaitMs, 0, 60_000)
	);
}


import { add, enclosure, GateUnavailable, integer, interval, systemClock, type GateClock } from "./api-clock.ts";
export { GateUnavailable, systemClock, type GateClock } from "./api-clock.ts";

export type Issued<T> = { started: true; value: T } | { started: false; at: number };
/** Audited synchronous launch: prepare, check allowed again, invoke and immediately adopt raw before returning. */
export type SyncStart<T> = (allowed: () => boolean) => Issued<T>;
export const notStarted = (at = 0): Issued<never> => ({ started: false, at });
export type GateRecord = { seq: number; kind: "final" | "poll" | "write" | "typing"; key: string | null; b: number; stamp: number | null };
export type Hold = { b: number; d: number };
export type ServerWait = (Hold & { blocked: boolean; unknown?: false }) | { unknown: true; reason: string };
export type GateSnapshot = { frame?: string; horizon?: number; records: GateRecord[]; lastSeq: number; hold?: Hold | undefined; server?: ServerWait | undefined; legacy?: boolean };
export interface GateStore {
 /** Recovery is atomic, including frame/hold/history replacement. */
 recover(snapshot: GateSnapshot): void;
 /** Previous stamp, prefix deletion, new NULL last and sequence setting commit together. */
 reserve(record: GateRecord, previous: GateRecord | undefined, pruneThrough: number): void;
 sweep(previous: GateRecord | undefined, pruneThrough: number): void;
 cooldown(server: ServerWait): void;
}
export interface ApiPermits {
 poll<T>(signal: AbortSignal, start: SyncStart<T>): Promise<Issued<T>>;
 progress<T>(key: string, write: boolean, signal: AbortSignal, start: SyncStart<T>, maxWaitMs?: number, topic?: string): Promise<Issued<T>>;
 registerTyping(key: string, topic: string): () => void;
 rateLimited(delayMs: number): boolean;
}
export const MAX_PROGRESS_WAITERS = 64;
type Waiter = {kind: "poll" | "write"; key: string | null; signal: AbortSignal; deadline: number; start: SyncStart<unknown>; settle(v: Issued<unknown>): void; abort(): void};
type Member = {topic: string; want?: number | undefined};

/** Protocol rev3 owner. Quota observations enclose actual raw invocation, never a permit continuation. */
export class ApiGate implements ApiPermits {
 readonly policy: GatePolicy;
 readonly #clock: GateClock;
 readonly #store: GateStore;
 readonly #onFail: () => void;
 readonly #canRunFinal: () => boolean;
 readonly #B: number; readonly #J: number; readonly #H: number; readonly #Q: number; readonly #ttl: number;
 readonly #horizon: number;
 #frameId: string;
 #ns = -1n; #lo = 0; #hi = 0;
 #busy = false; #closed = false; #failed = false; #notified = false;
 #records: GateRecord[] = [];
 #lastSeq = 0; #previous: GateRecord | undefined;
 #pruneThrough = 0;
 #hold: Hold | undefined; #server: ServerWait | undefined;
 #lastClass?: GateRecord["kind"];
 readonly #writes = new Map<string, number[]>();
 readonly #typing = new Map<string, number>();
 readonly #members = new Map<string, Member[]>();
 /** Demand belongs to a live scheduler lane, not every denied chat ever seen. */
 readonly #demand = new Map<string, {key: string; at: number}>();
 #poll: Waiter | undefined; #progress: Waiter[] = [];
 #retryHorizon = 0;
 #cancelTimer: (() => void) | undefined;
 #timerAt = Infinity;
 #pendingService = false;
 constructor(policy: GatePolicy, store: GateStore, snapshot: GateSnapshot, options: {clock?: GateClock | undefined; onFailClosed?: () => void; canRunFinal?: () => boolean} = {}) {
  if (!validGatePolicy(policy)) throw new RangeError("Invalid API gate policy");
  this.policy=policy; this.#clock=options.clock ?? systemClock(); this.#store=store; this.#onFail=options.onFailClosed ?? (()=>{}); this.#canRunFinal=options.canRunFinal??(()=>true);
  this.#B=this.#T(policy.botSpacingMs); this.#J=this.#T(policy.chatSpacingMs); this.#Q=this.#T(4000); this.#ttl=this.#T(8000);
  this.#horizon=Math.max(policy.chatWindowMs,policy.botSpacingMs,policy.chatSpacingMs,4000);
  this.#H=this.#T(this.#horizon);
  this.#frameId=JSON.stringify([this.#clock.frame, this.#clock.rate.map(String), !!this.#clock.exact, policy]);
  this.#busy=true;
  try {
   this.#observe(); this.#recover(snapshot);
   if (this.#server?.unknown || (this.#server?.blocked && this.#deadline(this.#server)>this.#lo)) throw new GateUnavailable("Outbound API blocked by persisted server bound");
   this.#arm();
  } finally { this.#busy=false; }
 }
 #T(d: number) { return interval(d,this.#clock.rate); }
 #deadline(h: Hold) { return add(h.b,this.#T(h.d)); }
 #observe() {
  const n=this.#clock.observeNs();
  if (n<this.#ns) throw new GateUnavailable("API clock decreased");
  const {lo,hi}=enclosure(n,this.#clock.exact); this.#ns=n; this.#lo=lo; this.#hi=hi;
  // Ensure every mandatory local deadline is representable before granting anything.
  add(hi,this.#H);
 }
 #recover(s: GateSnapshot) {
  integer(s.lastSeq); add(s.lastSeq,1);
  if (s.horizon!==undefined) integer(s.horizon);
  const validateHold=(h: Hold) => { integer(h.b); integer(h.d); this.#deadline(h); };
  if (s.hold) validateHold(s.hold);
  if (s.server && !s.server.unknown) { validateHold(s.server); if (typeof s.server.blocked!=="boolean") throw new GateUnavailable("Corrupt server tag"); }
  if (s.server?.unknown && typeof s.server.reason!=="string") throw new GateUnavailable("Corrupt unknown server tag");
  if(s.frame!==undefined) {
   try { const frame=JSON.parse(s.frame); if(!Array.isArray(frame) || frame.length!==4 || typeof frame[0]!=="string" || !Array.isArray(frame[1]) || frame[1].length!==2 || typeof frame[2]!=="boolean")throw new Error(); const policy=frame[3] as GatePolicy; if(!validGatePolicy(policy) || s.horizon!==Math.max(policy.chatWindowMs,policy.botSpacingMs,policy.chatSpacingMs,4000))throw new Error(); } catch {throw new GateUnavailable("Unrecognized API clock policy");}
  }
  let previous: GateRecord | undefined, future=!!(s.hold && s.hold.b>this.#hi) || !!(s.server && !s.server.unknown && s.server.b>this.#hi);
  for (const r of s.records) {
   integer(r.seq); integer(r.b); if (r.stamp!==null) integer(r.stamp);
   if (r.seq<=0 || r.seq>s.lastSeq || (previous && (previous.seq>=r.seq || previous.stamp===null)) || !["final","poll","write","typing"].includes(r.kind) || (r.kind!=="poll" && typeof r.key!=="string")) throw new GateUnavailable("Corrupt API record order");
   if (r.stamp!==null && r.stamp<r.b) throw new GateUnavailable("Corrupt API stamp");
   if (s.frame===this.#frameId && previous && r.b<add(previous.stamp!,this.#B)) throw new GateUnavailable("Corrupt API spacing");
   if (r.b>this.#lo || (r.stamp!==null && r.stamp>this.#hi)) future=true;
   previous=r;
  }
  const foreign=s.legacy || (s.frame!==undefined && (s.frame!==this.#frameId || future));
  if (!s.frame && !s.legacy && (s.records.length || s.hold || s.server)) throw new GateUnavailable("Missing API frame");
  this.#lastSeq=s.lastSeq; this.#hold=s.hold; this.#server=s.server;
  if (foreign) {
   if (s.frame && s.horizon===undefined) throw new GateUnavailable("Unknown API policy horizon");
   this.#hold={b:this.#hi,d:Math.max(this.#horizon,s.horizon??60000,s.hold?.d??0)};
   if (this.#server && !this.#server.unknown) this.#server={...this.#server,b:this.#hi};
   this.#records=[];
  } else {
   if (s.records.length>Math.ceil(this.#H/this.#B)+1) throw new GateUnavailable("Oversized API history");
   this.#records=s.records.map(r=>({...r,stamp:r.stamp??this.#hi}));
  }
  for(const r of this.#records)this.#index(r);
  this.#expire();
  if(this.#hold)this.#deadline(this.#hold);
  if(this.#server && !this.#server.unknown)this.#deadline(this.#server);
  if(this.#server && !this.#server.unknown && this.#deadline(this.#server)<=this.#lo)this.#server=undefined;
  this.#store.recover({frame:this.#frameId,horizon:this.#horizon,records:this.#records.map(r=>({...r})),lastSeq:this.#lastSeq,hold:this.#hold,server:this.#server});
  this.#previous=undefined;
 }
 #run<T>(denied: T, operation: () => T): T {
  if (this.#busy) return denied;
  this.#busy=true;
  try { return operation(); }
  catch (e) { this.#fail(); throw e; }
  finally {
   try { if (this.#closed) this.#cleanup(); else this.#arm(); } catch { this.#fail(); this.#cleanup(); }
   this.#busy=false;
   if (this.#failed && !this.#notified) { this.#notified=true; try { this.#onFail(); } catch {} }
   if (this.#pendingService) { this.#pendingService=false; if (!this.#closed) queueMicrotask(()=>this.#service()); }
  }
 }
 #fail() { this.#closed=true; this.#failed=true; }
 #expire() {
  const edge=this.#lo-this.#H;
  let count=0;
  while (count<this.#records.length && this.#records[count]!.stamp!==null && this.#records[count]!.stamp!<=edge) {
   const r=this.#records[count++]!; this.#pruneThrough=r.seq;
   if(r.kind==="typing") {if(this.#typing.get(r.key!)===r.stamp)this.#typing.delete(r.key!);}
   else if(r.key!==null){const a=this.#writes.get(r.key)!;a.shift();if(!a.length)this.#writes.delete(r.key);}
  }
  if (count) this.#records.splice(0,count);
 }
 #index(r: GateRecord) {
  if(r.stamp===null)return;
  if(r.kind==="typing")this.#typing.set(r.key!,r.stamp);
  else if(r.key!==null){const a=this.#writes.get(r.key)??[];a.push(r.stamp);this.#writes.set(r.key,a);}
 }
 #botAt() { return Math.max(this.#records.length ? add(this.#records.at(-1)!.stamp!,this.#B):0,this.#hold?this.#deadline(this.#hold):0,this.#server ? this.#server.unknown ? Infinity:this.#deadline(this.#server):0); }
 #keyAt(key: string) {
  const a=this.#writes.get(key); if (!a?.length) return 0;
  return Math.max(add(a.at(-1)!,this.#J),a.length>=this.policy.chatWindowLimit ? add(a[a.length-this.policy.chatWindowLimit]!,this.#T(this.policy.chatWindowMs)):0);
 }
 #denied(at = this.#botAt()): Issued<never> { return notStarted(Math.max(this.#lo+1,at)); }
 /** Retry times are native frame hints, translated only for scheduler wakeups by delay(). */
 delay(at: number) { return Number.isFinite(at) ? Math.max(1,at-this.#lo):60000; }
 releaseDemand(lane: string) { this.#run(undefined,()=>{ this.#demand.delete(lane); }); }
 final<T>(key: string, start: SyncStart<T>, lane = key): Issued<T> {
  return this.#run(notStarted(),()=>{
   if (this.#closed) return notStarted(Infinity);
   this.#observe(); this.#expire();
   let at=Math.max(this.#botAt(),this.#keyAt(key));
   if (at<=this.#lo && this.#poll && this.#lastClass==="final") { this.#grant(this.#poll); at=Math.max(this.#botAt(),this.#keyAt(key)); }
   if (at>this.#lo) {
    if(this.#botAt()>=this.#keyAt(key)){at=Math.max(at,this.#retryHorizon);this.#retryHorizon=add(at,this.#B);}
    this.#demand.set(lane,{key,at}); return this.#denied(at);
   }
   this.#demand.delete(lane);
   return this.#issue("final",key,start);
  });
 }
 #issue<T>(kind: GateRecord["kind"],key: string|null,start: SyncStart<T>,signal?: AbortSignal): Issued<T> {
  const r: GateRecord={seq:add(this.#lastSeq,1),kind,key,b:this.#lo,stamp:null};
  // Exhaustion must fail before reserving, not wrap next time.
  add(r.seq,1);
  this.#store.reserve(r,this.#previous,this.#pruneThrough);
  this.#lastSeq=r.seq; this.#records.push(r); this.#previous=r;
  const allowed=()=>!this.#closed && !signal?.aborted;
  let result: Issued<T> = notStarted();
  try { if (allowed()) result=start(allowed); }
  catch (e) { this.#fail(); throw e; }
  // No fallible store work after raw invocation. Raw is already adopted by its installed execution/poll owner.
  try {
   this.#observe(); r.stamp=this.#hi; this.#lastClass=kind; this.#index(r); this.#expire();
  } catch { this.#fail(); }
  return result;
 }
 poll<T>(signal: AbortSignal,start: SyncStart<T>): Promise<Issued<T>> { return this.#wait("poll",null,signal,start,Infinity); }
 progress<T>(key: string,write: boolean,signal: AbortSignal,start: SyncStart<T>,maxWaitMs=this.policy.progressWaitMs,topic="0"): Promise<Issued<T>> {
  if (this.#busy || this.#closed || signal.aborted) return Promise.resolve(notStarted());
  if (write) return this.#wait("write",key,signal,start,Math.min(3000,Math.max(0,maxWaitMs)));
  try { return Promise.resolve(this.#run(notStarted(),()=>{
   this.#observe(); this.#expire();
   const list=this.#members.get(key); const member=list?.find(m=>m.topic===topic);
   if (!member) return this.#denied();
   member.want=this.#lo;
   const first=list!.find(m=>m.want!==undefined && this.#lo<=add(m.want,this.#ttl));
   const last=this.#typing.get(key);
   const at=Math.max(this.#botAt(),last===undefined?0:add(last,this.#Q));
   if (first!==member || at>this.#lo || this.#poll || this.#demanded()) return this.#denied(at);
   const issued=this.#issue("typing",key,start,signal);
   if (issued.started) { member.want=undefined; list!.splice(list!.indexOf(member),1); list!.push(member); }
   return issued;
  })); } catch { return Promise.resolve(notStarted()); }
 }
 registerTyping(key: string,topic: string): () => void {
  if (this.#busy || this.#closed) return ()=>{};
  const member: Member={topic};
  this.#run(undefined,()=>{ const a=this.#members.get(key)??[]; if(a.some(m=>m.topic===topic)) throw new GateUnavailable("Duplicate typing producer"); a.push(member); this.#members.set(key,a); });
  let removed=false;
  return ()=> { if(removed) return; removed=true; const remove=()=> { const a=this.#members.get(key); if(!a)return; const i=a.indexOf(member); if(i>=0)a.splice(i,1); if(!a.length)this.#members.delete(key); }; if(this.#busy) { this.#fail(); return; } this.#run(undefined,remove); };
 }
 #demanded(key?: string) { if(!this.#canRunFinal())return false; for(const d of this.#demand.values()) if(d.at<=this.#lo+this.#B || (key!==undefined && d.key===key)) return true; return false; }
 #eligible(w: Waiter) {
  let at=this.#botAt();
  if(w.kind==="poll") { if(this.#lastClass==="poll" && this.#demanded()) at=Math.max(at,add(this.#lo,this.#B)); }
  else { at=Math.max(at,this.#keyAt(w.key!)); if(this.#poll || this.#demanded(w.key!)) at=Math.max(at,add(this.#lo,this.#B)); }
  return at;
 }
 #wait<T>(kind: Waiter["kind"],key: string|null,signal: AbortSignal,start: SyncStart<T>,max: number): Promise<Issued<T>> {
  if(this.#busy || this.#closed || signal.aborted || (kind==="poll"?!!this.#poll:this.#progress.length>=MAX_PROGRESS_WAITERS)) return Promise.resolve(notStarted());
  return new Promise(resolve=>{
   try { this.#run(undefined,()=>{
    this.#observe(); this.#expire();
    const w: Waiter={kind,key,signal,start,deadline:Number.isFinite(max)?add(this.#lo,this.#T(Math.ceil(max))):Infinity,settle:resolve as Waiter["settle"],abort:()=>{ if(this.#busy){this.#pendingService=true;return;} this.#run(undefined,()=>this.#drop(w)); }};
    signal.addEventListener("abort",w.abort,{once:true});
    if(kind==="poll")this.#poll=w; else this.#progress.push(w);
    this.#serviceOwned();
   }); } catch { resolve(notStarted()); }
  });
 }
 #remove(w: Waiter) {
  w.signal.removeEventListener("abort",w.abort);
  if(this.#poll===w){this.#poll=undefined;return true;}
  const i=this.#progress.indexOf(w); if(i<0)return false; this.#progress.splice(i,1); return true;
 }
 #drop(w: Waiter,at=0) { if(this.#remove(w))w.settle(notStarted(at)); }
 #grant(w: Waiter) {
  if(!this.#remove(w))return;
  try { w.settle(this.#issue(w.kind,w.key,w.start,w.signal)); }
  catch { w.settle(notStarted()); throw new GateUnavailable("API launch failed"); }
 }
 #serviceOwned() {
  // Reobserve for each candidate: no stale pre-commit time is reused.
  for(const w of [...(this.#poll?[this.#poll]:[]),...this.#progress]) {
   if(this.#closed || w.signal.aborted){this.#drop(w);continue;}
   this.#observe(); this.#expire(); const at=this.#eligible(w);
   if(at<=this.#lo)this.#grant(w); else if(w.deadline<=this.#lo)this.#drop(w,at);
  }
 }
 #service() {
  if(this.#busy){this.#pendingService=true;return;}
  if(this.#closed)return;
  try { this.#run(undefined,()=>{this.#observe();this.#expire();this.#store.sweep(this.#previous,this.#pruneThrough);this.#previous=undefined;this.#serviceOwned();}); } catch {}
 }
 rateLimited(delayMs: number): boolean {
  if(this.#busy){this.#fail();throw new GateUnavailable("Reentrant server learning");}
  return this.#run(false,()=>{
   // Learning after stop is allowed while the owner DB remains open; closure is monotone.
   this.#observe();
   let server: ServerWait;
   try {
    const d=Math.ceil(delayMs); integer(d);
    const old=this.#server;
    server=old?.unknown?old:{b:Math.max(this.#hi,old && this.#deadline(old)>this.#lo ? old.b:0),d:Math.max(d,old && this.#deadline(old)>this.#lo ? old.d:0),blocked: d>this.policy.maxCooldownMs || !!(old && this.#deadline(old)>this.#lo && old.blocked)};
    if(!server.unknown)this.#deadline(server);
   } catch { server={unknown:true,reason:"unrepresentable server bound"}; }
   this.#store.cooldown(server); this.#server=server;
   if(server.unknown || server.blocked){this.#fail();return false;}
   return true;
  });
 }
 close() { this.#closed=true; if(!this.#busy)this.#run(undefined,()=>{}); }
 #cleanup() {
  this.#cancelTimer?.(); this.#cancelTimer=undefined;this.#timerAt=Infinity;
  if(this.#poll)this.#drop(this.#poll); for(const w of [...this.#progress])this.#drop(w);
  this.#members.clear();this.#demand.clear();
 }
 #arm() {
  let at=Infinity;
  if(this.#poll)at=Math.min(at,this.#eligible(this.#poll));
  for(const w of this.#progress)at=Math.min(at,w.deadline,this.#eligible(w));
  if(this.#records.length && this.#records[0]!.stamp!==null)at=Math.min(at,add(this.#records[0]!.stamp!,this.#H));
  at=Math.max(this.#lo+1,at);
  if(at===this.#timerAt)return;
  this.#cancelTimer?.();this.#cancelTimer=undefined;this.#timerAt=at;
  if(!Number.isFinite(at))return;
  let installing=true;
  this.#cancelTimer=this.#clock.timer(()=>{this.#cancelTimer=undefined;this.#timerAt=Infinity;if(installing){this.#fail();return;}this.#service();},Math.max(1,Math.min(2147483647,at-this.#lo)));
  installing=false;
  if(this.#closed)this.#cleanup();
 }
 /** Remaining bound at the latest gate observation; use immediately after rateLimited for retry scheduling. */
 cooldownRemainingMs(): number {
  return this.#server ? this.#server.unknown ? Number.MAX_SAFE_INTEGER : Math.max(0,this.#deadline(this.#server)-this.#lo) : 0;
 }
 health(): Record<string,number> {
  // Cached only: health cannot reenter clock/store while issuance is partially published.
  return {api_cooldown_ms:this.cooldownRemainingMs(),api_blocked:this.#server?.unknown || this.#server?.blocked ? 1:0,api_closed:this.#closed?1:0,api_waiters:(this.#poll?1:0)+this.#progress.length,api_rate_keys:this.#writes.size,api_window_writes:[...this.#writes.values()].reduce((n,a)=>n+a.length,0),api_history:this.#records.length,api_typing_members:[...this.#members.values()].reduce((n,a)=>n+a.length,0),api_demands:this.#demand.size};
 }
}
