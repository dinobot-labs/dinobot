import { TELEGRAM_GATE_POLICY, type GatePolicy } from "../../src/channels/api-gate.ts";

/**
 * Explicitly scaled shared API gate policy (ADR 0048 §5) for fixtures whose assertions concern scheduling, ordering,
 * isolation, durability and recovery — not wall-clock Telegram rate. It is passed as the test-only `gatePolicy`
 * dependency; nothing infers it from apiBase, and the gate stays fully active: every final chunk, progress call and
 * poll still takes a durable permit, honours the shared 429 cooldown and the same three inequalities (bot start spacing,
 * per-chat write spacing, per-chat rolling-window limit with the production count of 20).
 *
 * Only the time constants shrink, by 40x (40 ms -> 1 ms, 1 s -> 25 ms, 60 s -> 1.5 s). This is not a weaker
 * concurrency acceptance: the gate never delays a handler start or holds an engine slot while it waits, so barrier
 * assertions about handler starts, active counts, slot caps and per-lane FIFO are unchanged and still observed directly.
 * The production constants themselves are proved by test/telegram-api-gate.test.ts with a fixed clock and by the
 * production-policy channel tests there. maxCooldownMs (the fail-closed classification bound, not a wait) and
 * progressWaitMs keep their production values.
 */
export const SCALED_GATE_POLICY: GatePolicy = Object.freeze({
	...TELEGRAM_GATE_POLICY,
	botSpacingMs: 1,
	chatSpacingMs: 25,
	chatWindowMs: 1_500,
	chatWindowLimit: 20,
});
