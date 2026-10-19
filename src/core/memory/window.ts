import { defineDoc } from "@earendil-works/pi-durable";

/**
 * Per-conversation extraction window state machine of the memory curator. Pure functions over `CuratorState`
 * (no clock reads, no I/O); the curator applies them inside one durable commit together with the memory writes.
 *
 * Let t be the number of counted user turns, c the cursor, N = everyTurns, R = maxRetries.
 *
 *   idle/committed/skipped -> claimed     t - c >= N and no live lease; token := token + 1
 *   claimed -> extracting                 same token, lease alive
 *   claimed/extracting -> committed       same token: cursor := max(c, windowEnd), receipt
 *   claimed/extracting -> idle            aux failure with attempt < R: attempt + 1, cursor unchanged
 *   claimed/extracting -> skipped         aux failure with attempt >= R: cursor := max(c, windowEnd), receipt
 *   claimed/extracting -> claimed         lease expired: re-claim of the same window under a new token
 *   any -> skipped                        adoption: turns before the curator (re)started are skipped as one synthetic
 *                                         window with a receipt; token + 1 fences any task of the old window
 *
 * Invariants (checked by test/memory-window.test.ts over random event sequences):
 *   I1 at most one terminal receipt per window, and only the current token settles it (fencing);
 *   I2 the cursor never decreases and only moves with a receipt;
 *   I4 once no lease is held, every due window can be claimed again, so every turn up to t - (t mod N) is eventually
 *      covered by a committed or skipped window.
 */
export type WindowStatus = "idle" | "claimed" | "extracting" | "committed" | "skipped";
export type WindowRecord = {
	/** Index of the current (or last finished) window; 0 before the first claim. */
	window: number;
	/** Last user turn the current window covers; fixed when the window is first claimed. */
	windowEnd: number;
	/** Every user turn <= cursorTurn is covered by a committed or skipped window. */
	cursorTurn: number;
	attempt: number;
	/** Last fencing token issued in this conversation; strictly increasing. */
	token: number;
	state: WindowStatus;
	leaseUntil: number | null;
	skipReason: string | null;
	/** Turns <= floorTurn were adopted, never extracted; no window reads them, not even as overlap. */
	floorTurn?: number;
};
export type Receipt = { window: number; token: number; outcome: "committed" | "skipped"; from: number; to: number; keys: string[]; at: number };
export type CuratorState = {
	/** Entry ids of every counted user turn, oldest first: t = userEntries.length. */
	userEntries: number[];
	/** Newest entry id already classified. */
	scannedTo: number;
	/** When this conversation was last scanned (epoch ms); compared with the adoption epoch. */
	scannedAt?: number;
	window: WindowRecord;
	/** The newest receipts, bounded. */
	receipts: Receipt[];
};

export const MAX_RECEIPTS = 64;

export const CuratorDoc = defineDoc<CuratorState>({
	kind: "dinobot.memory.curator", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ userEntries: [], scannedTo: 0, window: emptyWindow(), receipts: [] }),
});

/**
 * Adoption epoch: when the curator last started after not running (first start, or a start after a run with automatic
 * extraction disabled). Turns a conversation gained before the epoch and had not been scanned are adopted, not replayed.
 */
export const ActivationDoc = defineDoc<{ epoch: number | null; disabled: boolean }>({
	kind: "dinobot.memory.activation", version: 1, scope: "session", initial: () => ({ epoch: null, disabled: false }),
});

export function emptyWindow(): WindowRecord {
	return { window: 0, windowEnd: 0, cursorTurn: 0, attempt: 0, token: 0, state: "idle", leaseUntil: null, skipReason: null };
}

/** T(t) = t - c >= N: a jump past N (7 vs 0 with N = 5) still fires, unlike t mod N == 0. */
export function shouldTrigger(userTurn: number, cursor: number, everyTurns: number): boolean {
	return userTurn - cursor >= everyTurns;
}

/** User turns a window reads, (fromExclusive, toInclusive], overlapping the previous window by `overlap` turns but never below the adoption floor. */
export function readRange(cursor: number, windowEnd: number, overlap = 1, floor = 0): { fromExclusive: number; toInclusive: number } {
	return { fromExclusive: Math.max(0, floor, cursor - overlap), toInclusive: windowEnd };
}

/**
 * Adoption: skip turns (cursor, userTurn] as one synthetic window. The receipt keeps I1/I2 (one receipt per window, the
 * cursor moves only with a receipt) and the new token fences any task still holding the old window.
 */
export function adopt(state: Pick<CuratorState, "window" | "receipts">, input: { userTurn: number; now: number }): { record: WindowRecord; receipts: Receipt[] } | undefined {
	const current = state.window;
	if (input.userTurn <= current.cursorTurn) return undefined;
	const record: WindowRecord = {
		window: current.window + 1, windowEnd: input.userTurn, cursorTurn: input.userTurn, attempt: 0, token: current.token + 1,
		state: "skipped", leaseUntil: null, skipReason: "adopted", floorTurn: input.userTurn,
	};
	return {
		record,
		receipts: bounded(state.receipts, { window: record.window, token: record.token, outcome: "skipped", from: current.cursorTurn, to: input.userTurn, keys: [], at: input.now }),
	};
}

export type ClaimInput = { userTurn: number; everyTurns: number; now: number; leaseMs: number };
export type ClaimResult =
	| { ok: true; record: WindowRecord; token: number; range: { fromExclusive: number; toInclusive: number } }
	| { ok: false; reason: "not_due" | "lease_held" };

export function claim(current: WindowRecord, input: ClaimInput): ClaimResult {
	if (!shouldTrigger(input.userTurn, current.cursorTurn, input.everyTurns)) return { ok: false, reason: "not_due" };
	const active = current.state === "claimed" || current.state === "extracting";
	if (active && current.leaseUntil !== null && input.now <= current.leaseUntil) return { ok: false, reason: "lease_held" };
	const startsNew = current.window === 0 || current.state === "committed" || current.state === "skipped";
	const record: WindowRecord = {
		...current,
		window: startsNew ? current.window + 1 : current.window,
		windowEnd: startsNew ? current.cursorTurn + input.everyTurns : current.windowEnd,
		attempt: startsNew ? 0 : current.attempt,
		token: current.token + 1,
		state: "claimed",
		leaseUntil: input.now + input.leaseMs,
		skipReason: null,
	};
	return { ok: true, record, token: record.token, range: readRange(record.cursorTurn, record.windowEnd, 1, record.floorTurn) };
}

export type Fenced = { token: number; now: number };
export type Rejected = { ok: false; reason: "stale_token" | "not_claimed" | "lease_expired" };

/** claimed -> extracting, only for the current token while the lease holds. */
export function startExtracting(current: WindowRecord, input: Fenced): { ok: true; record: WindowRecord } | Rejected {
	if (current.token !== input.token) return { ok: false, reason: "stale_token" };
	if (current.state !== "claimed") return { ok: false, reason: "not_claimed" };
	if (current.leaseUntil !== null && input.now > current.leaseUntil) return { ok: false, reason: "lease_expired" };
	return { ok: true, record: { ...current, state: "extracting" } };
}

function bounded(receipts: readonly Receipt[], receipt: Receipt): Receipt[] {
	return [...receipts, receipt].slice(-MAX_RECEIPTS);
}

export type Settled = { ok: true; status: "applied" | "duplicate"; record: WindowRecord; receipts: Receipt[] } | Rejected;

/**
 * claimed/extracting -> committed for the current token (I1). A repeated commit of a token that already committed
 * returns `duplicate` with nothing changed; any other token is rejected. `keys` are the memory keys the commit wrote.
 */
export function commitWindow(state: Pick<CuratorState, "window" | "receipts">, input: Fenced & { keys: readonly string[] }): Settled {
	const current = state.window;
	if (state.receipts.some((receipt) => receipt.token === input.token && receipt.outcome === "committed")) {
		return { ok: true, status: "duplicate", record: current, receipts: state.receipts };
	}
	if (current.token !== input.token) return { ok: false, reason: "stale_token" };
	if (current.state !== "claimed" && current.state !== "extracting") return { ok: false, reason: "not_claimed" };
	const from = current.cursorTurn;
	const to = Math.max(current.cursorTurn, current.windowEnd);
	return {
		ok: true, status: "applied",
		record: { ...current, cursorTurn: to, state: "committed", leaseUntil: null },
		receipts: bounded(state.receipts, { window: current.window, token: input.token, outcome: "committed", from, to, keys: [...input.keys], at: input.now }),
	};
}

export type Failed = { ok: true; status: "retry" | "skipped"; record: WindowRecord; receipts: Receipt[] } | Rejected;

/** Aux failure: attempt < R retries the window (cursor unchanged); attempt >= R skips it with a receipt. */
export function failAttempt(state: Pick<CuratorState, "window" | "receipts">, input: Fenced & { maxRetries: number; reason: string }): Failed {
	const current = state.window;
	if (current.token !== input.token) return { ok: false, reason: "stale_token" };
	if (current.state !== "claimed" && current.state !== "extracting") return { ok: false, reason: "not_claimed" };
	if (current.attempt < input.maxRetries) {
		return { ok: true, status: "retry", record: { ...current, attempt: current.attempt + 1, state: "idle", leaseUntil: null }, receipts: state.receipts };
	}
	const from = current.cursorTurn;
	const to = Math.max(current.cursorTurn, current.windowEnd);
	return {
		ok: true, status: "skipped",
		record: { ...current, cursorTurn: to, state: "skipped", leaseUntil: null, skipReason: input.reason },
		receipts: bounded(state.receipts, { window: current.window, token: input.token, outcome: "skipped", from, to, keys: [], at: input.now }),
	};
}
