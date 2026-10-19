import { expect, test } from "bun:test";
import {
	adopt, claim, commitWindow, type CuratorState, emptyWindow, failAttempt, MAX_RECEIPTS, readRange, shouldTrigger, startExtracting,
} from "../src/core/memory/window.ts";

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

class InvariantError extends Error {}
function invariant(condition: boolean, message: string): asserts condition {
	if (!condition) throw new InvariantError(message);
}

type State = Pick<CuratorState, "window" | "receipts">;
type Holder = { token: number; window: number };

/** Random interleavings of turns, claims, starts, commits, failures, crashes (lost holders) and clock jumps. */
function runSequence(seed: number) {
	const rand = mulberry32(seed);
	const int = (n: number) => Math.floor(rand() * n);
	const pick = <T>(values: readonly T[]): T => values[int(values.length)]!;
	const everyTurns = 2 + int(5);
	const maxRetries = int(4);
	const leaseMs = 100;
	let turns = 0;
	let now = 0;
	let state: State = { window: emptyWindow(), receipts: [] };
	let holders: Holder[] = [];
	const issued = new Map<number, number>();
	const effects = new Map<number, number>();

	const check = (before: State, label: string) => {
		const after = state;
		invariant(after.window.cursorTurn >= before.window.cursorTurn, `I2 ${label}: cursor decreased`);
		const grew = after.receipts.length > before.receipts.length || (before.receipts.length === MAX_RECEIPTS && after.receipts.at(-1) !== before.receipts.at(-1));
		invariant(after.window.cursorTurn === before.window.cursorTurn || grew, `I2 ${label}: cursor moved without a receipt`);
		invariant(after.window.token >= before.window.token, `${label}: token decreased`);
		const perWindow = new Map<number, number>();
		for (const receipt of after.receipts) perWindow.set(receipt.window, (perWindow.get(receipt.window) ?? 0) + 1);
		for (const [index, count] of perWindow) invariant(count <= 1, `I1 ${label}: ${count} receipts for window ${index}`);
		invariant(after.receipts.length <= MAX_RECEIPTS, `${label}: receipts unbounded`);
	};
	const tryClaim = (label: string): Holder | undefined => {
		const result = claim(state.window, { userTurn: turns, everyTurns, now, leaseMs });
		if (!result.ok) return undefined;
		invariant(result.token > (issued.get(result.record.window) ?? 0), `${label}: token not increasing`);
		invariant(result.range.fromExclusive === Math.max(0, result.record.floorTurn ?? 0, result.record.windowEnd - everyTurns - 1), `${label}: read range lacks k=1 overlap or crosses the adoption floor`);
		issued.set(result.record.window, result.token);
		state = { ...state, window: result.record };
		const holder = { token: result.token, window: result.record.window };
		holders.push(holder);
		return holder;
	};
	const tryCommit = (holder: Holder, label: string): boolean => {
		const result = commitWindow(state, { token: holder.token, now, keys: [`k${holder.token}`] });
		if (!result.ok) return false;
		if (result.status === "duplicate") {
			invariant(result.record === state.window && result.receipts === state.receipts, `I1 ${label}: duplicate changed state`);
			return true;
		}
		const count = (effects.get(holder.window) ?? 0) + 1;
		effects.set(holder.window, count);
		invariant(count <= 1, `I1 ${label}: ${count} effect commits for window ${holder.window}`);
		invariant(holder.token === issued.get(holder.window), `I1 ${label}: stale token committed`);
		state = { window: result.record, receipts: result.receipts };
		return true;
	};
	const step = (label: string, action: () => void) => {
		const before = state;
		action();
		check(before, label);
	};

	const steps = 40 + int(160);
	for (let i = 0; i < steps; i++) {
		const label = `seed=${seed} step=${i}`;
		const event = int(100);
		step(label, () => {
			if (event < 30) turns += 1 + (int(10) === 0 ? int(everyTurns * 2) : 0);
			else if (event < 45) tryClaim(label);
			else if (event < 55 && holders.length > 0) {
				const result = startExtracting(state.window, { token: pick(holders).token, now });
				if (result.ok) state = { ...state, window: result.record };
			} else if (event < 70 && holders.length > 0) {
				const holder = pick(holders);
				if (tryCommit(holder, label) && int(2) === 0) holders = holders.filter((h) => h !== holder);
			} else if (event < 80 && holders.length > 0) {
				const holder = pick(holders);
				const result = failAttempt(state, { token: holder.token, now, maxRetries, reason: "provider_error" });
				if (result.ok) state = { window: result.record, receipts: result.receipts };
				holders = holders.filter((h) => h !== holder);
			} else if (event < 86) holders = [];
			else if (event < 90) {
				// Adoption with holders still alive: their tokens must be fenced off.
				const adopted = adopt(state, { userTurn: turns, now });
				if (adopted) state = { window: adopted.record, receipts: adopted.receipts };
			} else now += int(2 * leaseMs + 1);
		});
	}

	// I4: with every holder lost and the lease expired, every due window is claimed and settled again.
	holders = [];
	now += leaseMs + 1;
	let guard = 0;
	while (shouldTrigger(turns, state.window.cursorTurn, everyTurns)) {
		invariant(guard++ < 1000, `I4 seed=${seed}: drain did not terminate`);
		const label = `seed=${seed} drain#${guard}`;
		step(label, () => {
			const holder = tryClaim(label);
			invariant(holder !== undefined, `I4 ${label}: a due window could not be claimed after lease expiry`);
			if (int(10) < 3) {
				const result = failAttempt(state, { token: holder.token, now, maxRetries, reason: "provider_error" });
				invariant(result.ok, `${label}: current holder failAttempt rejected`);
				state = { window: result.record, receipts: result.receipts };
			} else invariant(tryCommit(holder, label), `${label}: current holder commit rejected`);
		});
	}
	invariant(turns - state.window.cursorTurn < everyTurns, `I4 seed=${seed}: turns left uncovered`);
	invariant((state.window.cursorTurn - (state.window.floorTurn ?? 0)) % everyTurns === 0, `I4 seed=${seed}: windows are not N-aligned after the adoption floor`);
}

test("I1, I2 and I4 hold over 1000 random event sequences, adoption included", () => {
	for (let seed = 1; seed <= 1000; seed++) runSequence(seed);
});

test("the trigger fires on jumps and the read range overlaps by one turn", () => {
	expect(shouldTrigger(4, 0, 5)).toBe(false);
	expect(shouldTrigger(7, 0, 5)).toBe(true);
	expect(readRange(5, 10)).toEqual({ fromExclusive: 4, toInclusive: 10 });
	expect(readRange(0, 5)).toEqual({ fromExclusive: 0, toInclusive: 5 });
});

test("a live lease blocks a second claim; an expired one is re-claimed for the same window under a new token", () => {
	const first = claim(emptyWindow(), { userTurn: 5, everyTurns: 5, now: 0, leaseMs: 100 });
	if (!first.ok) throw new Error("claim");
	expect(claim(first.record, { userTurn: 5, everyTurns: 5, now: 100, leaseMs: 100 })).toEqual({ ok: false, reason: "lease_held" });
	const again = claim(first.record, { userTurn: 5, everyTurns: 5, now: 101, leaseMs: 100 });
	if (!again.ok) throw new Error("reclaim");
	expect(again.record.window).toBe(first.record.window);
	expect(again.token).toBe(first.token + 1);
	const state = { window: again.record, receipts: [] };
	expect(commitWindow(state, { token: first.token, now: 101, keys: [] })).toEqual({ ok: false, reason: "stale_token" });
});

test("failures retry R times, then skip with a receipt that moves the cursor", () => {
	let state: State = { window: emptyWindow(), receipts: [] };
	for (let attempt = 0; attempt <= 2; attempt++) {
		const claimed = claim(state.window, { userTurn: 5, everyTurns: 5, now: 0, leaseMs: 100 });
		if (!claimed.ok) throw new Error("claim");
		const failed = failAttempt({ ...state, window: claimed.record }, { token: claimed.token, now: 0, maxRetries: 2, reason: "timeout" });
		if (!failed.ok) throw new Error("fail");
		expect(failed.status).toBe(attempt < 2 ? "retry" : "skipped");
		state = { window: failed.record, receipts: failed.receipts };
	}
	expect(state.window.cursorTurn).toBe(5);
	expect(state.window.skipReason).toBe("timeout");
	expect(state.receipts).toEqual([{ window: 1, token: 3, outcome: "skipped", from: 0, to: 5, keys: [], at: 0 }]);
});

test("adoption skips the gap as one receipted window, fences the old token and floors later read ranges", () => {
	const claimed = claim(emptyWindow(), { userTurn: 2, everyTurns: 2, now: 0, leaseMs: 100 });
	if (!claimed.ok) throw new Error("claim");
	const adopted = adopt({ window: claimed.record, receipts: [] }, { userTurn: 7, now: 5 });
	expect(adopted?.record).toMatchObject({ window: 2, cursorTurn: 7, floorTurn: 7, state: "skipped", token: claimed.token + 1 });
	expect(adopted?.receipts).toEqual([{ window: 2, token: claimed.token + 1, outcome: "skipped", from: 0, to: 7, keys: [], at: 5 }]);
	expect(commitWindow({ window: adopted!.record, receipts: adopted!.receipts }, { token: claimed.token, now: 6, keys: [] })).toEqual({ ok: false, reason: "stale_token" });
	const next = claim(adopted!.record, { userTurn: 9, everyTurns: 2, now: 6, leaseMs: 100 });
	expect(next.ok && next.range).toEqual({ fromExclusive: 7, toInclusive: 9 });
	expect(adopt({ window: adopted!.record, receipts: adopted!.receipts }, { userTurn: 7, now: 7 })).toBeUndefined();
});
