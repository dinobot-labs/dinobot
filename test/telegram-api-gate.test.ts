import { describe, expect, test } from "bun:test";
import { ApiGate, GateUnavailable, MAX_PROGRESS_WAITERS, TELEGRAM_GATE_POLICY, validGatePolicy, type GateClock, type GatePolicy, type GateRecord, type GateSnapshot } from "../src/channels/api-gate.ts";
import { FakeClock, memoryStore, rawGate, flush } from "./fixtures/issuance.ts";
import { rateLimitDelay } from "../src/channels/messaging.ts";

// ADR 0048 §5 gate in isolation: the PRODUCTION policy under a fixed, manually advanced clock, so the exact inequalities
// (40 ms bot spacing, 1 s chat spacing, <= 20 writes per rolling 60 s, shared cooldown) are checked over long simulated
// time in milliseconds of real time. Every random choice comes from a fixed seed; failures print the seed.
const SEED = 0x48c0ffee;
const P = TELEGRAM_GATE_POLICY;
function rng(seed: number) { let s = seed >>> 0; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }

// Test-only compatibility view. Every successful observation is made INSIDE a gate-owned start callback.
function gateWith(clock: FakeClock, mem=memoryStore(), policy:GatePolicy=P, onFailClosed=()=>{}) {
 const gate=rawGate(clock,mem,policy,onFailClosed); let topic=0;
 return {
  raw:gate,
  final(key:string,call:()=>void=()=>{}) {const r=gate.final(key,()=>{call();return {started:true,value:undefined};});return r.started?{ok:true as const}:{ok:false as const,at:r.at};},
  poll(signal:AbortSignal,call:()=>void=()=>{}) {return gate.poll(signal,()=>{call();return {started:true,value:undefined};}).then(r=>r.started);},
  progress(key:string,write:boolean,signal:AbortSignal,maxWait?:number) {const id=String(++topic);const off=write?()=>{}:gate.registerTyping(key,id);return gate.progress(key,write,signal,()=>({started:true,value:undefined}),maxWait,id).then(r=>{off();return r.started?0:Math.max(1,r.at-clock.t);});},
  rateLimited:(d:number)=>gate.rateLimited(d),health:()=>gate.health(),close:()=>gate.close(),
 };
}

/** G1–G3 over every reservation actually committed. */
function checkInvariants(reserved: readonly {at:number;key:string|null}[], policy: GatePolicy, seed: number, windows = 2000) {
	const at = reserved.map(r => r.at);
	for (let i = 1; i < at.length; i++) if (at[i]! - at[i - 1]! < policy.botSpacingMs) throw new Error(`seed ${seed}: bot spacing ${at[i]! - at[i - 1]!} ms at #${i}`);
	const byKey = new Map<string, number[]>();
	for (const r of reserved) if (r.key !== null) (byKey.get(r.key) ?? byKey.set(r.key, []).get(r.key)!).push(r.at);
	for (const [key, starts] of byKey) {
		for (let i = 1; i < starts.length; i++) if (starts[i]! - starts[i - 1]! < policy.chatSpacingMs) throw new Error(`seed ${seed}: ${key} spacing ${starts[i]! - starts[i - 1]!}`);
		// Exact form: the (n+limit)-th start is a full window after the n-th, so no half-open window holds limit+1.
		for (let i = 0; i + policy.chatWindowLimit < starts.length; i++) if (starts[i + policy.chatWindowLimit]! - starts[i]! < policy.chatWindowMs) throw new Error(`seed ${seed}: ${key} window at #${i}`);
		// Arbitrary window placements, including ones aligned exactly to a start (the boundary case).
		const next = rng(seed ^ starts.length);
		const first = starts[0]!, last = starts[starts.length - 1]!;
		for (let w = 0; w < windows; w++) {
			const a = w % 3 === 0 ? starts[Math.floor(next() * starts.length)]! : first - policy.chatWindowMs + next() * (last - first + policy.chatWindowMs);
			const count = starts.filter(s => s >= a && s < a + policy.chatWindowMs).length;
			if (count > policy.chatWindowLimit) throw new Error(`seed ${seed}: ${key} window [${a}, +${policy.chatWindowMs}) holds ${count}`);
		}
	}
	return byKey;
}

describe("shared API gate (production policy, fixed clock)", () => {
	test("policy is exact and validated", () => {
		expect(P).toEqual({ botSpacingMs: 40, chatSpacingMs: 1000, chatWindowMs: 60000, chatWindowLimit: 20, maxCooldownMs: 60000, progressWaitMs: 3000 });
		expect(validGatePolicy(P)).toBe(true);
		for (const bad of [{ botSpacingMs: 0 }, { chatSpacingMs: 60001 }, { chatWindowLimit: 0 }, { maxCooldownMs: 60001 }, { botSpacingMs: 1.5 }, { progressWaitMs: -1 }, { chatWindowMs: Number.NaN }])
			expect(validGatePolicy({ ...P, ...bad })).toBe(false);
		expect(() => gateWith(new FakeClock(), memoryStore(), { ...P, botSpacingMs: 0 })).toThrow(RangeError);
	});

	test(`seed 0x${SEED.toString(16)}: 30 simulated minutes of finals, polling, progress writes and typing keep G1–G3 in every rolling window`, async () => {
		const clock = new FakeClock(), mem = memoryStore(), gate = gateWith(clock, mem);
		const next = rng(SEED), keys = ["chat:-1", "chat:-2", "chat:-3", "chat:7"];
		const finals = new Map<string, { key: string; retryAt: number; since: number }>();
		let laneId = 0, pollGrants = 0, polling = false, progressGrants = 0, progressSkips = 0, maxFinalWait = 0;
		const control = new AbortController();
		const end = clock.t + 30 * 60_000;
		while (clock.t < end) {
			// Arrivals: bursts of final chunks (hot chat -1), progress writes/typing, a poller that re-polls at once.
			if (next() < 0.35) { const key = next() < 0.5 ? "chat:-1" : keys[Math.floor(next() * keys.length)]!; finals.set("l" + ++laneId, { key, retryAt: clock.t, since: clock.t }); }
			if (!polling) { polling = true; void gate.poll(control.signal).then(ok => { polling = false; if (ok) pollGrants++; }); }
			if (next() < 0.2) void gate.progress(keys[Math.floor(next() * keys.length)]!, next() < 0.6, control.signal).then(wait => { if (wait === 0) progressGrants++; else progressSkips++; });
			for (const [lane, final] of [...finals]) {
				if (final.retryAt > clock.t) continue;
				const permit = gate.final(final.key);
				if (permit.ok) { maxFinalWait = Math.max(maxFinalWait, clock.t - final.since); finals.delete(lane); }
				else { expect(permit.at).toBeGreaterThan(clock.t); final.retryAt = permit.at; }
			}
			await clock.advance(1 + Math.floor(next() * 120));
		}
		control.abort();
		await flush();
		const byKey = checkInvariants(mem.reserved, P, SEED);
		// The hot chat really was saturated: some 60 s window holds exactly the limit.
		const hot = byKey.get("chat:-1")!;
		expect(hot.some((s, i) => i + P.chatWindowLimit - 1 < hot.length && hot[i + P.chatWindowLimit - 1]! - s < P.chatWindowMs)).toBe(true);
		expect(pollGrants).toBeGreaterThan(1000);
		expect(progressGrants).toBeGreaterThan(0);
		expect(progressSkips).toBeGreaterThan(0);
		// Every reservation was committed before its grant became visible (the store saw it first, in order).
		expect(mem.reserved.map(r => r.order)).toEqual(mem.reserved.map((_, i) => i + 1));
		expect(gate.health().api_waiters).toBe(0);
		gate.close();
		expect(clock.pending).toBe(0);
		// Finals are bounded by the hot chat's own budget, not starved by polling or progress.
		expect(maxFinalWait).toBeLessThan(30 * 60_000);
	}, 60_000);

	test("429 lower bound: the larger of header and body wins, is never shortened, and blocks every key and class", async () => {
		expect(rateLimitDelay("1", "3")).toBe(3000);
		expect(rateLimitDelay("5", "2")).toBe(5000);
		expect(rateLimitDelay(null, "0.5")).toBe(500);
		expect(rateLimitDelay("2", null)).toBe(2000);
		expect(rateLimitDelay(null, null)).toBe(1000);
		const now = Date.parse("2030-01-01T00:00:00Z");
		expect(rateLimitDelay(new Date(now + 7000).toUTCString(), "1", now)).toBe(7000);
		const clock = new FakeClock(), mem = memoryStore(), gate = gateWith(clock, mem);
		expect(gate.final("chat:-1").ok).toBe(true);
		const started = clock.t;
		expect(gate.rateLimited(rateLimitDelay("1", "3"))).toBe(true);
		// A shorter later bound never shortens the committed one.
		expect(gate.rateLimited(100)).toBe(true);
		expect((mem.snapshot().server as {b:number;d:number}).b + (mem.snapshot().server as {b:number;d:number}).d).toBe(started + 3000);
		// Cross-topic and cross-chat: same chat (other topic) and another chat both wait for the shared bound.
		for (const key of ["chat:-1", "chat:-2"]) {
			const denied = gate.final(key);
			expect(denied.ok).toBe(false);
			if (!denied.ok) expect(denied.at).toBeGreaterThanOrEqual(started + 3000);
		}
		const control = new AbortController();
		let polled = -1;
		void gate.poll(control.signal).then(() => { polled = clock.t; });
		const typing = gate.progress("chat:-3", false, control.signal, 500);
		await clock.advance(600);
		expect(await typing).toBeGreaterThanOrEqual(2400); // skipped with the remaining bound as its hint
		await clock.advance(2399);
		expect(polled).toBe(-1);
		await clock.advance(2);
		expect(polled).toBeGreaterThanOrEqual(started + 3000);
		expect(mem.reserved.filter(r => r.at > started).every(r => r.at >= started + 3000)).toBe(true);
		expect(mem.snapshot().server).toEqual({b:started,d:3000,blocked:false});
		gate.close();
	});

	test("a lower bound above 60 s fails closed, is persisted, and refuses a restart until it elapses (no clamp)", async () => {
		const clock = new FakeClock(), mem = memoryStore();
		let failed = 0;
		const gate = gateWith(clock, mem, P, () => failed++);
		expect(gate.rateLimited(60_000)).toBe(true); // exactly the budget is honoured by waiting
		expect(failed).toBe(0);
		const t0 = clock.t;
		expect(gate.rateLimited(61_000)).toBe(false);
		expect(failed).toBe(1);
		expect(gate.health()).toMatchObject({ api_blocked: 1 });
		expect(mem.snapshot().server).toEqual({b:t0,d:61000,blocked:true});
		const denied = gate.final("chat:-1");
		expect(denied.ok).toBe(false);
		gate.close();
		for (const elapsed of [0, 30_000, 60_999]) {
			const restart = new FakeClock(t0 + elapsed);
			expect(() => gateWith(restart, mem)).toThrow(GateUnavailable);
		}
		const after = gateWith(new FakeClock(t0 + 61_000), mem);
		expect(after.final("chat:-1").ok).toBe(true);
		after.close();
		// An unbounded lower bound (an absurd header) blocks rather than wrapping or clamping.
		const huge = gateWith(new FakeClock(), memoryStore(), P, () => failed++);
		expect(huge.rateLimited(Number.POSITIVE_INFINITY)).toBe(false);
		expect(huge.final("chat:-1").ok).toBe(false);
		huge.close();
	});

	test("restart restores spacing, the rolling window and the cooldown; a stepped-back clock only waits longer", () => {
		const clock = new FakeClock(), mem = memoryStore(), gate = gateWith(clock, mem);
		const first = clock.t;
		for (let i = 0; i < 20; i++) {
			expect(gate.final("chat:-1").ok).toBe(true);
			clock.t += 1000;
		}
		expect(gate.final("chat:-2").ok).toBe(true);
		expect(gate.rateLimited(5_000)).toBe(true);
		const last = clock.t;
		gate.close();
		// Crash and restart 10 ms later: nothing reserved before is granted again early.
		const restart = new FakeClock(last + 10);
		const reopened = gateWith(restart, mem);
		expect(reopened.final("chat:-3")).toEqual({ ok: false, at: last + 5_000 }); // cooldown survived
		restart.t = last + 5_000;
		expect(reopened.final("chat:-1")).toEqual({ ok: false, at: first + 60_000 }); // 21st write waits for the window
		expect(reopened.final("chat:-2").ok).toBe(true);
		restart.t = first + 60_000;
		expect(reopened.final("chat:-1").ok).toBe(true);
		reopened.close();
  // A regressed comparable provider is not compared permissively: the whole old history folds into a hold.
  const back = new FakeClock(first + 60_000 - 5_000);
  const regressed = gateWith(back, mem);
  expect(regressed.final("chat:-1").ok).toBe(false);
  expect(mem.snapshot().hold).toEqual({b:back.t,d:60000});
  expect(mem.live).toHaveLength(0);
  regressed.close();
  expect(()=>gateWith(new FakeClock(),memoryStore({lastSeq:NaN}))).toThrow(GateUnavailable);
	});

	test("interrupted reservation: a store failure grants nothing; a reserved-then-crashed permit is never re-granted", async () => {
		const clock = new FakeClock(), mem = memoryStore();
		let failed = 0;
		const gate = gateWith(clock, mem, P, () => failed++);
		mem.failReserve();
		expect(() => gate.final("chat:-1")).toThrow("disk full");
		expect(mem.reserved).toHaveLength(0);
  expect(gate.final("chat:-1").ok).toBe(false); // store failure closes owner, no retry starts here
  const control=new AbortController();
  expect(await gate.poll(control.signal)).toBe(false);
  expect(failed).toBe(1);
		// Crash right after a committed reservation (request maybe never sent): the restart counts it.
		const crash = memoryStore(), before = gateWith(clock, crash);
		expect(before.final("chat:-9").ok).toBe(true);
		const reservedAt = clock.t;
		const restarted = gateWith(new FakeClock(reservedAt + 5), crash);
		expect(restarted.final("chat:-9")).toEqual({ ok: false, at: reservedAt + 5 + 1000 });
	});

	test("polling alternates with saturating finals; finals are not starved by an always-waiting poller", async () => {
		const clock = new FakeClock(), mem = memoryStore(), gate = gateWith(clock, mem);
		const control = new AbortController();
		const classes: string[] = [];
		let pollWaitingSince = -1, maxPollWait = 0, pending = false;
		const repoll = () => {
			pending = true; pollWaitingSince = clock.t;
			void gate.poll(control.signal).then(ok => { if (!ok) return; classes.push("poll"); maxPollWait = Math.max(maxPollWait, clock.t - pollWaitingSince); pending = false; repoll(); });
		};
		repoll();
		await flush();
		// 200 chats, each with a final ready at every opportunity: finals alone could take every bot permit.
		const retry = new Map(Array.from({ length: 200 }, (_, i) => ["chat:-" + i, clock.t]));
		for (let step = 0; step < 4000; step++) {
			for (const [key, at] of retry) {
				if (at > clock.t) continue;
				const permit = gate.final(key);
				if (permit.ok) { classes.push("final"); retry.set(key, clock.t + 1000); }
				else retry.set(key, permit.at);
			}
			await clock.advance(5);
		}
		control.abort();
		await flush();
		expect(pending).toBe(true);
		checkInvariants(mem.reserved, P, SEED, 50);
		// Strict alternation while both contend: never two polls in a row, and every poll waits at most two bot slots.
		for (let i = 1; i < classes.length; i++) expect(classes[i] === "poll" && classes[i - 1] === "poll").toBe(false);
		expect(maxPollWait).toBeLessThanOrEqual(2 * P.botSpacingMs + 5);
		const polls = classes.filter(c => c === "poll").length, finals = classes.length - polls;
		expect(polls).toBeGreaterThan(100);
		expect(finals).toBeGreaterThanOrEqual(polls - 1);
	});

	test("alternation at the exact contention instant, from either side", async () => {
		const clock = new FakeClock(), mem = memoryStore(), gate = gateWith(clock, mem);
		const control = new AbortController();
		// Final side: last grant was a final, a poller waits, and a final asks at the instant the permit frees.
		expect(gate.final("chat:-1").ok).toBe(true);
		const t = clock.t;
		let polledAt = -1;
		void gate.poll(control.signal).then(ok => { if (ok) polledAt = clock.t; });
		clock.t = t + P.botSpacingMs; // the timer has not fired yet: the final reaches the gate first
		expect(gate.final("chat:-2")).toEqual({ ok: false, at: t + 2 * P.botSpacingMs });
		await flush();
		expect(polledAt).toBe(t + P.botSpacingMs);
		clock.t = t + 2 * P.botSpacingMs;
		expect(gate.final("chat:-2").ok).toBe(true);
		// Poll side: the last grant was a poll; a final became due on the bot permit, so the next poll yields once.
		clock.t += P.botSpacingMs;
		expect(await gate.poll(control.signal)).toBe(true);
		const p = clock.t;
		expect(gate.final("chat:-3")).toEqual({ ok: false, at: p + P.botSpacingMs });
		let second = -1;
		void gate.poll(control.signal).then(ok => { if (ok) second = clock.t; });
		await clock.advance(P.botSpacingMs);
		expect(second).toBe(-1); // yielded to the due final
		expect(gate.final("chat:-3").ok).toBe(true);
		await clock.advance(P.botSpacingMs);
		expect(second).toBe(p + 2 * P.botSpacingMs);
		checkInvariants(mem.reserved, P, SEED, 10);
		gate.close();
	});

	test("progress is lowest priority: it never takes a chat a final waits on, nor a bot permit a due final could use", async () => {
		const clock = new FakeClock(), mem = memoryStore(), gate = gateWith(clock, mem);
		const control = new AbortController();
		expect(gate.final("chat:-1").ok).toBe(true);
		clock.t += 100;
		const denied = gate.final("chat:-1"); // second chunk waits for chat spacing
		expect(denied.ok).toBe(false);
		const dueAt = denied.ok ? 0 : denied.at;
		// A progress edit in the same chat would push the waiting final later: it must wait behind it.
		let editAt = -1;
		void gate.progress("chat:-1", true, control.signal, 5_000).then(wait => { if (wait === 0) editAt = clock.t; });
		// Typing in another chat is bot-only and the bot permit is free now: allowed at once.
		expect(await gate.progress("chat:-2", false, control.signal)).toBe(0);
		await clock.advance(dueAt - clock.t);
		expect(editAt).toBe(-1);
		expect(gate.final("chat:-1").ok).toBe(true); // the final gets its permit at its time
		await clock.advance(3_000);
		expect(editAt).toBeGreaterThanOrEqual(dueAt + P.chatSpacingMs);
		// Bounded waiting: beyond MAX_PROGRESS_WAITERS a call is skipped at once; abort and close free every timer.
		clock.t += 60_000;
		expect(gate.rateLimited(10_000)).toBe(true);
		const waiting = Array.from({ length: MAX_PROGRESS_WAITERS }, () => gate.progress("chat:-5", true, control.signal, 50_000));
		await flush();
		expect(gate.health().api_waiters).toBe(MAX_PROGRESS_WAITERS);
		expect(await gate.progress("chat:-5", true, control.signal)).toBeGreaterThan(0);
		control.abort();
		expect((await Promise.all(waiting)).every(wait => wait > 0)).toBe(true);
		expect(gate.health().api_waiters).toBe(0);
		gate.close();
		expect(clock.pending).toBe(0);
	});

	test("finite rate state: 100,000 distinct chats leave no per-chat state or durable permits after one window", () => {
		const clock = new FakeClock(), mem = memoryStore(), gate = gateWith(clock, mem);
		let peakKeys = 0;
		for (let i = 0; i < 100_000; i++) {
			const permit = gate.final("chat:" + i);
			if (!permit.ok) { clock.t = permit.at; expect(gate.final("chat:" + i).ok).toBe(true); }
			peakKeys = Math.max(peakKeys, gate.health().api_rate_keys!);
		}
		// Only chats written within the last 60 s are remembered: 60 000 / 40 ms = 1 500 (+1 boundary).
		expect(peakKeys).toBeLessThanOrEqual(P.chatWindowMs / P.botSpacingMs + 1);
		expect(mem.live.length).toBeLessThanOrEqual(P.chatWindowMs / P.botSpacingMs + 1);
		clock.t += P.chatWindowMs;
		expect(gate.final("chat:last").ok).toBe(true);
		expect(gate.health()).toMatchObject({ api_rate_keys: 1, api_window_writes: 1, api_waiters: 0 });
		expect(mem.live.length).toBe(1);
		gate.close();
		// The assertions are about bounded state, not speed: ~2 s alone, so allow full-suite load headroom.
	}, 30_000);
});

// Original five boundary guards, adapted to actual gate-owned invocation callbacks (protocol §9).
describe("actual-start boundary counterexamples",()=>{
 for(const key of ["chat:one","chat:other"])test("slow commit cannot backdate the next actual start: "+key,()=>{
  const c=new FakeClock(),m=memoryStore();const reserve=m.store.reserve;let first=true;
  m.store.reserve=(...args)=>{reserve(...args);if(first){first=false;c.t+=2000;}};
  const g=gateWith(c,m),starts:number[]=[];const start=()=>{starts.push(c.t);};
  try{expect(g.final("chat:one",start).ok).toBe(true);const t=c.t;const second=g.final(key,start);expect(c.t).toBe(t);expect(second.ok).toBe(false);expect(starts).toEqual([t]);if(!second.ok)c.t=second.at;expect(g.final(key,start).ok).toBe(true);expect(starts[1]!-starts[0]!).toBeGreaterThanOrEqual(key==="chat:one"?1000:40);}finally{g.close();}
 });
 test("restart after a slow commit preserves spacing from the actual start, not the old reservation timestamp",()=>{
  const c=new FakeClock(),m=memoryStore();const reserve=m.store.reserve;let first=true;const starts:number[]=[];
  m.store.reserve=(...args)=>{reserve(...args);if(first){first=false;c.t+=2000;}};
  const g=gateWith(c,m);expect(g.final("chat:one",()=>{starts.push(c.t);}).ok).toBe(true);g.close();expect(m.live.at(-1)!.stamp).toBeNull();
  const h=gateWith(c,m);try{const r=h.final("chat:one",()=>{starts.push(c.t);});expect(r.ok).toBe(false);if(!r.ok)c.t=r.at;expect(h.final("chat:one",()=>{starts.push(c.t);}).ok).toBe(true);expect(starts[1]!-starts[0]!).toBeGreaterThanOrEqual(1000);}finally{h.close();}
 });
 test("a fulfilled polling permit must not overlap another start before its continuation can issue the request",async()=>{
  for(const delay of [0,1,39,40,2000]){
   const c=new FakeClock(),g=gateWith(c),control=new AbortController(),starts:number[]=[];
   try{const polling=g.poll(control.signal,()=>{starts.push(c.t);});expect(starts).toHaveLength(1);c.t+=delay;const r=g.final("chat:one",()=>{starts.push(c.t);});expect(await polling).toBe(true);if(!r.ok){c.t=r.at;expect(g.final("chat:one",()=>{starts.push(c.t);}).ok).toBe(true);}expect(starts).toHaveLength(2);expect(starts[1]!-starts[0]!).toBeGreaterThanOrEqual(40);}finally{control.abort();g.close();}
  }
 });
 test("a forward wall-clock correction cannot shorten a running server cooldown",()=>{
  const c=new FakeClock(),g=gateWith(c),wall=Date.now,starts:number[]=[];
  try{expect(g.final("chat:one",()=>{starts.push(c.t);}).ok).toBe(true);expect(g.rateLimited(60000)).toBe(true);Date.now=()=>wall()+120000;expect(g.final("chat:one",()=>{starts.push(c.t);}).ok).toBe(false);expect(starts).toHaveLength(1);c.t+=60000;expect(g.final("chat:one",()=>{starts.push(c.t);}).ok).toBe(true);expect(starts[1]!-starts[0]!).toBeGreaterThanOrEqual(60000);}finally{Date.now=wall;g.close();}
 });
});
