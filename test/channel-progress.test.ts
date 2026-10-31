import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { httpChannel } from "../src/channels/http.ts";
import { failureNotice } from "../src/channels/messaging.ts";
import {
	clip,
	foldProgress,
	initialProgress,
	parseProgressEvent,
	type ProgressState,
	RECENT_TOOLS,
	renderProgress,
	withOutcome,
} from "../src/channels/progress.ts";
import { type TelegramResult, telegramProgress } from "../src/channels/telegram-progress.ts";
import { telegramChannel } from "../src/channels/telegram.ts";
import type { BotReply, InboundMessage, ProgressEvent } from "../src/channels/types.ts";
import { createTelegramForwarder } from "../src/cli/telegram-run.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { ACTIVITY_INTERVAL_MS, agentProgress } from "../src/core/progress-events.ts";

/** Deterministic PRNG (mulberry32) so property runs are reproducible. */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const NAMES = ["bash", "read", "codemode", "task", "edit"];
function randomEvent(random: () => number, opened: string[], next: () => string): ProgressEvent {
	const r = random();
	if (r < 0.3) {
		const id = next();
		opened.push(id);
		return { type: "tool_start", id, name: NAMES[Math.floor(random() * NAMES.length)]!, ...(random() < 0.5 ? { preview: `bun test ${"x".repeat(Math.floor(random() * 80))}\nrm -rf` } : {}) };
	}
	if (r < 0.55 && opened.length > 0) return { type: "tool_end", id: opened.splice(Math.floor(random() * opened.length), 1)[0]!, ok: random() < 0.8 };
	if (r < 0.65) return { type: "todos", done: Math.floor(random() * 8), total: Math.floor(random() * 8), current: "step ".repeat(Math.floor(random() * 30)) };
	if (r < 0.72) return { type: "phase", phase: random() < 0.5 ? "thinking" : "writing" };
	if (r < 0.76) return { type: "retry", attempt: 1 + Math.floor(random() * 3) };
	if (r < 0.85) return { type: "activity" };
	return { type: "heartbeat" };
}

describe("progress model", () => {
	test("heartbeats are the identity; events after an outcome change nothing", () => {
		const state = foldProgress(initialProgress(0), { type: "tool_start", id: "a", name: "bash" }, 10);
		expect(foldProgress(state, { type: "heartbeat" }, 99_999)).toBe(state);
		const done = withOutcome(state, { kind: "done" }, 20);
		expect(foldProgress(done, { type: "tool_start", id: "b", name: "read" }, 30)).toBe(done);
	});

	test("random traces keep the view bounded and time-dependent only on explicit clock grids", () => {
		for (let seed = 1; seed <= 300; seed++) {
			const random = rng(seed);
			let state: ProgressState = initialProgress(0);
			let t = 0;
			let counter = 0;
			const opened: string[] = [];
			const started = new Set<string>();
			for (let i = 0; i < 80; i++) {
				t += Math.floor(random() * 20_000);
				const event = randomEvent(random, opened, () => `id${counter++}`);
				if (event.type === "tool_start") started.add(event.id);
				const before = state;
				state = foldProgress(state, event, t);
				if (event.type === "heartbeat") expect(state).toBe(before);
				const view = renderProgress(state, t);
				expect(view.length).toBeLessThanOrEqual(1024);
				expect(view.split("\n").length).toBeLessThanOrEqual(7);
				expect(state.recent.length).toBeLessThanOrEqual(RECENT_TOOLS);
				expect(Object.keys(state.open).length).toBeLessThanOrEqual(opened.length);
				// Every line is a view line; a preview's newline never starts a line of its own.
				for (const line of view.split("\n")) expect(line).toMatch(/^(⏳|🔁|✅|⚠️|📋|▸|✓|✗|💭|✍️)/u);
			}
			expect(state.tools).toBe(started.size);
			// Piecewise constant: any two instants in the same elapsed-minute and idle-minute bucket render alike.
			const probe = t + Math.floor(random() * 600_000);
			const bucket = (x: number) => [Math.floor((x - state.startedAt) / 60_000), Math.floor((x - state.lastActivityAt) / 60_000), ...state.recent.filter(line => line.running > 0).map(line => Math.floor((x - line.startedAt) / 1000))].join();
			let other = probe + 1;
			while (bucket(other) === bucket(probe) && other < probe + 120_000) {
				expect(renderProgress(state, other)).toBe(renderProgress(state, probe));
				other += 997;
			}
			const final = withOutcome(state, { kind: "done" }, t);
			expect(renderProgress(final, t)).toStartWith("✅ 완료");
		}
	});

	test("P: seconds-based running views remain bounded by event and clock boundaries", () => {
		// With startedAt and every event on whole seconds, every minute boundary of either grid is a whole second, so the
		// view is constant on each [n s, n+1 s): sampling every second counts view changes exactly.
		const changes = (events: readonly (readonly [number, ProgressEvent])[], duration: number) => {
			let state = initialProgress(0);
			let index = 0;
			let last: string | undefined;
			let views = 0;
			for (let t = 0; t <= duration; t += 1_000) {
				for (; index < events.length && events[index]![0] <= t; index++) state = foldProgress(state, events[index]![1], events[index]![0]);
				const view = renderProgress(state, t);
				if (view !== last) views++;
				last = view;
			}
			if (renderProgress(withOutcome(state, { kind: "done" }, duration), duration) !== last) views++;
			return views;
		};
		for (let seed = 1; seed <= 200; seed++) {
			const random = rng(seed);
			const duration = 1_000 * Math.floor(random() * 1_800);
			const opened: string[] = [];
			let counter = 0;
			const events: [number, ProgressEvent][] = [];
			for (let t = 0; t <= duration; t += 1_000) {
				if (random() < 0.02) events.push([t, randomEvent(random, opened, () => `p${counter++}`)]);
			}
			const counted = events.filter(([, event]) => event.type !== "heartbeat").length;
			expect(changes(events, duration)).toBeLessThanOrEqual(counted + 3 * Math.floor(duration / 1000) + 2 * Math.floor(duration / 60_000) + 2);
		}
		// Counterexample to the former bound #events + ⌊D/1min⌋ + 2: idle after an event off the elapsed-minute grid.
		const idle: [number, ProgressEvent][] = [
			[0, { type: "tool_start", id: "a", name: "bash", preview: "sleep" }],
			[30_000, { type: "activity" }],
		];
		const views = changes(idle, 600_000);
		expect(views).toBeGreaterThan(2 + 10 + 2);
		expect(views).toBeLessThanOrEqual(2 + 3 * 600 + 2 * 10 + 2);
	});

	test("I: running counts never exceed open calls per key, so no line stays running once its calls closed", () => {
		const holds = (state: ProgressState) => {
			const open = new Map<string, number>();
			for (const key of Object.values(state.open)) open.set(key, (open.get(key) ?? 0) + 1);
			const running = new Map<string, number>();
			for (const line of state.recent) running.set(line.key, (running.get(line.key) ?? 0) + line.running);
			for (const [key, count] of running) expect(count).toBeLessThanOrEqual(open.get(key) ?? 0);
		};
		for (let seed = 1; seed <= 100; seed++) {
			const random = rng(seed);
			let state = initialProgress(0);
			const opened: string[] = [];
			let counter = 0;
			// Mostly starts, rarely ends: open calls pile up past the 256 limit and get forgotten.
			for (let i = 0; i < 900; i++) {
				const r = random();
				const event: ProgressEvent =
					r < 0.75
						? (() => {
								const id = `o${counter++}`;
								opened.push(id);
								return { type: "tool_start", id, name: NAMES[Math.floor(random() * 2)]!, ...(random() < 0.5 ? { preview: "x" } : {}) };
							})()
						: opened.length > 0
							? { type: "tool_end", id: opened.splice(Math.floor(random() * opened.length), 1)[0]!, ok: random() < 0.5 }
							: { type: "activity" };
				state = foldProgress(state, event, i);
				holds(state);
				expect(Object.keys(state.open).length).toBeLessThanOrEqual(256);
			}
			for (const id of opened) state = foldProgress(state, { type: "tool_end", id, ok: true }, 1_000);
			expect(Object.keys(state.open)).toEqual([]);
			expect(state.recent.every((line) => line.running === 0)).toBe(true);
		}
		// Regression: 256 calls without an end, then one more; ending the known calls left the line running forever.
		let s = initialProgress(0);
		for (let i = 0; i < 256; i++) s = foldProgress(s, { type: "tool_start", id: `leak${i}`, name: "bash", preview: "long" }, 0);
		s = foldProgress(s, { type: "tool_start", id: "trigger", name: "bash", preview: "long" }, 0);
		s = foldProgress(s, { type: "tool_end", id: "trigger", ok: true }, 0);
		expect(renderProgress(s, 0)).not.toContain("▸");
	});

	test("renders running, merged, failed, todo, stale and terminal views", () => {
		let s = initialProgress(0);
		s = foldProgress(s, { type: "todos", done: 2, total: 5, current: "테스트 실행" }, 1_000);
		s = foldProgress(s, { type: "tool_start", id: "1", name: "bash", preview: "bun test" }, 1_000);
		s = foldProgress(s, { type: "tool_end", id: "1", ok: true }, 2_000);
		s = foldProgress(s, { type: "tool_start", id: "2", name: "bash", preview: "bun test" }, 3_000);
		s = foldProgress(s, { type: "tool_end", id: "2", ok: false }, 4_000);
		s = foldProgress(s, { type: "tool_start", id: "3", name: "read", preview: "src/a.ts" }, 5_000);
		expect(renderProgress(s, 125_000)).toBe(["⏳ 작업 중 · 2분 · 도구 3회", "📋 2/5 · step in progress", "✗ bash: bun test ×2 · failed 3s", "▸ read: file (.ts) · running 120s", "⚠️ 2분째 새 활동 없음"].join("\n"));
		s = foldProgress(s, { type: "tool_end", id: "3", ok: true }, 126_000);
		s = foldProgress(s, { type: "phase", phase: "writing" }, 126_000);
		expect(renderProgress(s, 127_000).split("\n").at(-1)).toBe("✍️ 답변 작성 중");
		expect(renderProgress(withOutcome(s, { kind: "failed", reason: "core 응답 없음" }, 3_700_000), 3_700_000)).toBe(
			["⚠️ 중단 · 1시간 1분 · 도구 3회", "core 응답 없음", "📋 2/5 · step in progress", "✗ bash: bun test ×2 · failed 3s", "✓ read: file (.ts) · done 121s"].join("\n"),
		);
		expect(clip("a\nb\u0007c   d", 40)).toBe("a b c d");
		expect([...clip("가".repeat(100), 40)].length).toBe(40);
	});

	test("wire events are validated", () => {
		expect(parseProgressEvent({ type: "tool_start", id: "1", name: "bash", preview: "ls" })).toEqual({ type: "tool_start", id: "1", name: "bash", preview: "ls" });
		expect(parseProgressEvent({ type: "tool_start", id: 1, name: "bash" })).toBeUndefined();
		expect(parseProgressEvent({ type: "todos", done: -1, total: 2 })).toBeUndefined();
		expect(parseProgressEvent({ type: "nope" })).toBeUndefined();
		expect(parseProgressEvent({ type: "tool_start", id: "1", name: "x".repeat(201) })).toBeUndefined();
	});
});

type Call = { at: number; method: string; body: Record<string, unknown> };
function fakeTelegram(respond: (call: Call) => TelegramResult = (call) => ({ ok: true, result: call.method === "sendMessage" ? { message_id: 42 } : true })) {
	let t = 0;
	const calls: Call[] = [];
	const reporterOptions = {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
		call: async (method: string, body: Record<string, unknown>) => {
			const call = { at: t, method, body };
			calls.push(call);
			return respond(call);
		},
	};
	return { calls, advance: (ms: number) => (t += ms), now: () => t, reporterOptions };
}

describe("telegram status message", () => {
	test("a quick answer gets typing only, no status message", async () => {
		const api = fakeTelegram();
		const reporter = telegramProgress({ ...api.reporterOptions, chat: "-9", topic: "0" });
		for (let i = 0; i < 5; i++) {
			await reporter.tick();
			api.advance(1_000);
		}
		reporter.event({ type: "phase", phase: "writing" });
		await reporter.finish({ kind: "done" });
		expect(api.calls.map((call) => call.method)).toEqual(["sendChatAction", "sendChatAction"]);
	});

	test("long random turns satisfy spacing, topic routing, change-only edits, convergence and silence after finish", async () => {
		for (let seed = 1; seed <= 60; seed++) {
			const random = rng(seed);
			let failedWrites = 0;
			const api = fakeTelegram((call) => {
				if (random() < 0.05) {
					if (call.method !== "sendChatAction") failedWrites++;
					return { ok: false, status: 0 };
				}
				return { ok: true, result: call.method === "sendMessage" ? { message_id: 7 } : true };
			});
			const reporter = telegramProgress({ ...api.reporterOptions, chat: "-100", topic: "15520" });
			let state = initialProgress(0);
			const opened: string[] = [];
			let counter = 0;
			const duration = 30_000 + Math.floor(random() * 300_000);
			const views = new Set<string>();
			while (api.now() < duration) {
				if (random() < 0.4) {
					const event = randomEvent(random, opened, () => `t${counter++}`);
					reporter.event(event);
					state = foldProgress(state, event, api.now());
				}
				views.add(renderProgress(state, api.now()));
				await reporter.tick();
				api.advance(250 + Math.floor(random() * 1_000));
			}
			await reporter.finish({ kind: "done" });
			const after = api.calls.length;
			await reporter.tick();
			reporter.event({ type: "tool_start", id: "late", name: "bash" });
			await reporter.tick();
			expect(api.calls.length).toBe(after);

			const writes = api.calls.filter((call) => call.method !== "sendChatAction");
			// R1: running writes start ≥ Δ apart, the final edit ≥ 1 s after the last; ≤ K = 20 in any 60 s window.
			for (let i = 1; i < writes.length; i++) expect(writes[i]!.at - writes[i - 1]!.at).toBeGreaterThanOrEqual(i === writes.length - 1 ? 1_000 : 3_000);
			for (const first of writes) expect(writes.filter((call) => call.at >= first.at && call.at < first.at + 60_000).length).toBeLessThanOrEqual(20);
			const typing = api.calls.filter((call) => call.method === "sendChatAction");
			for (let i = 1; i < typing.length; i++) expect(typing[i]!.at - typing[i - 1]!.at).toBeGreaterThanOrEqual(4_000);
			for (const call of api.calls) {
				if (call.method === "editMessageText") expect(call.body.message_id).toBe(7);
				else expect(call.body.message_thread_id).toBe(15520);
				if (typeof call.body.text === "string") expect(call.body.text.length).toBeLessThanOrEqual(4096);
			}
			// A failed (possibly ambiguous) first send may be retried once: at most two status messages per turn.
			expect(writes.filter((call) => call.method === "sendMessage").length).toBeLessThanOrEqual(2);
			// Each successful write carries a new view: at most one write per distinct view, plus failed retries and the final.
			expect(writes.length).toBeLessThanOrEqual(views.size + failedWrites + 1);
			if (writes.some((call) => call.method === "sendMessage")) {
				// Convergence: the last write is the terminal view.
				expect(String(writes.at(-1)!.body.text)).toStartWith("✅ 완료");
			}
		}
	});

	test("R1: a quiet minute's final edit waits only the 1 s gap", async () => {
		const api = fakeTelegram();
		const reporter = telegramProgress({ ...api.reporterOptions, chat: "1", topic: "0" });
		reporter.event({ type: "tool_start", id: "a", name: "bash" });
		await reporter.tick();
		await reporter.finish({ kind: "done" });
		expect(api.calls.filter((call) => call.method !== "sendChatAction").map((call) => [call.method, call.at])).toEqual([["sendMessage", 0], ["editMessageText", 1_000]]);
	});

	test("R1 regression: after a saturated minute the final edit waits for the window, so no 60 s holds more than 20 writes", async () => {
		const api = fakeTelegram();
		const reporter = telegramProgress({ ...api.reporterOptions, chat: "1", topic: "0" });
		for (let i = 0; i < 61; i++) {
			reporter.event({ type: "tool_start", id: `x${i}`, name: `t${i}` });
			await reporter.tick();
			api.advance(1_000);
		}
		await reporter.finish({ kind: "done" });
		const writes = api.calls.filter((call) => call.method !== "sendChatAction").map((call) => call.at);
		expect(String(api.calls.at(-1)!.body.text)).toStartWith("✅ 완료");
		// Saturated: writes at 0, 3, …, 60 s; the former 1 s gap put the final edit at 61 s, the 21st write in [3 s, 63 s).
		expect(writes.length).toBeGreaterThan(20);
		expect(writes.at(-1)! - writes.at(-2)!).toBe(3_000);
		for (let i = 1; i < writes.length; i++) expect(writes[i]! - writes[i - 1]!).toBeGreaterThanOrEqual(i === writes.length - 1 ? 1_000 : 3_000);
		for (const first of writes) expect(writes.filter((at) => at >= first && at < first + 60_000).length).toBeLessThanOrEqual(20);
	});

	test("R7: finish meets its budget, then no call is issued and calls in flight are aborted", async () => {
		const budget = 150;
		const options = { chat: "1", topic: "0", editIntervalMs: 20, finalGapMs: 10, finalWaitMs: 20, finishBudgetMs: budget, bubbleDelayMs: 0 };
		// (a) The platform hangs until aborted, like a stalled fetch given the signal.
		{
			const calls: { method: string; signal?: AbortSignal | undefined }[] = [];
			let hang = false;
			const reporter = telegramProgress({
				...options,
				call: (method, _body, signal) => {
					calls.push({ method, signal });
					if (!hang) return Promise.resolve({ ok: true, result: { message_id: 3 } });
					return new Promise((resolve) => signal?.addEventListener("abort", () => resolve({ ok: false, status: 0 }), { once: true }));
				},
			});
			reporter.event({ type: "tool_start", id: "a", name: "bash" });
			await reporter.tick();
			expect(calls.map((c) => c.method)).toEqual(["sendChatAction", "sendMessage"]);
			hang = true;
			await Bun.sleep(30);
			reporter.event({ type: "tool_start", id: "b", name: "read" });
			void reporter.tick(); // edit in flight, never answered
			const started = performance.now();
			await reporter.finish({ kind: "done" });
			const took = performance.now() - started;
			expect(took).toBeGreaterThanOrEqual(budget - 5);
			expect(took).toBeLessThan(budget + 100);
			expect(calls.every((c) => c.signal?.aborted === true)).toBe(true);
			const issued = calls.length;
			await Bun.sleep(50);
			await reporter.tick();
			expect(calls.length).toBe(issued);
		}
		// (b) The platform ignores the signal and never settles: finish still resolves at the budget, nothing follows.
		{
			let issued = 0;
			let hang = false;
			const reporter = telegramProgress({
				...options,
				call: () => {
					issued++;
					return hang ? new Promise(() => {}) : Promise.resolve({ ok: true, result: { message_id: 3 } });
				},
			});
			reporter.event({ type: "tool_start", id: "a", name: "bash" });
			await reporter.tick();
			hang = true;
			await Bun.sleep(30);
			reporter.event({ type: "tool_start", id: "b", name: "read" });
			void reporter.tick();
			const before = issued;
			const started = performance.now();
			await reporter.finish({ kind: "failed", reason: "x" });
			expect(performance.now() - started).toBeLessThan(budget + 100);
			await Bun.sleep(50);
			expect(issued).toBe(before);
		}
		// (c) A healthy platform: the final edit waits out the spacing and lands before finish resolves.
		{
			const calls: { method: string; at: number; text?: unknown }[] = [];
			const reporter = telegramProgress({
				...options,
				call: async (method, body) => {
					calls.push({ method, at: performance.now(), text: body.text });
					return { ok: true, result: { message_id: 3 } };
				},
			});
			reporter.event({ type: "tool_start", id: "a", name: "bash" });
			await reporter.tick();
			await reporter.finish({ kind: "done" });
			const writes = calls.filter((c) => c.method !== "sendChatAction");
			expect(writes.map((c) => c.method)).toEqual(["sendMessage", "editMessageText"]);
			expect(String(writes[1]!.text)).toStartWith("✅ 완료");
			expect(writes[1]!.at - writes[0]!.at).toBeGreaterThanOrEqual(9);
		}
		expect(() => telegramProgress({ call: async () => ({ ok: true }), chat: "1", topic: "0", finalWaitMs: 1_000 })).toThrow(RangeError);
		expect(() => telegramProgress({ call: async () => ({ ok: true }), chat: "1", topic: "0", finalWaitMs: 9_000 })).toThrow(RangeError);
		expect(() => telegramProgress({ call: async () => ({ ok: true }), chat: "1", topic: "0", finalGapMs: 4_000 })).toThrow(RangeError);
	});

	test("429 pauses every call until retry_after; 'not modified' is success; a permanent 400 stops status writes", async () => {
		let mode: "ok" | "limited" | "unmodified" | "gone" = "ok";
		const api = fakeTelegram((call) => {
			if (mode === "limited") return { ok: false, status: 429, retryAfterMs: 20_000 };
			if (mode === "unmodified" && call.method === "editMessageText") return { ok: false, status: 400, description: "Bad Request: message is not modified" };
			if (mode === "gone" && call.method === "editMessageText") return { ok: false, status: 400, description: "Bad Request: message to edit not found" };
			return { ok: true, result: call.method === "sendMessage" ? { message_id: 5 } : true };
		});
		const reporter = telegramProgress({ ...api.reporterOptions, chat: "1", topic: "0" });
		reporter.event({ type: "tool_start", id: "a", name: "bash" });
		await reporter.tick();
		expect(api.calls.map((c) => c.method)).toEqual(["sendChatAction", "sendMessage"]);
		mode = "limited";
		api.advance(4_000);
		reporter.event({ type: "tool_start", id: "b", name: "read" });
		await reporter.tick();
		const limitedAt = api.calls.length;
		for (let i = 0; i < 19; i++) {
			api.advance(1_000);
			await reporter.tick();
		}
		expect(api.calls.length).toBe(limitedAt);
		mode = "unmodified";
		api.advance(1_500);
		await reporter.tick();
		expect(api.calls.slice(limitedAt).map((c) => c.method)).toEqual(["sendChatAction", "editMessageText"]);
		const settled = api.calls.length;
		api.advance(3_000);
		await reporter.tick();
		// Running duration changed, typing not yet due: exactly one bounded edit.
		expect(api.calls.slice(settled).map(c => c.method)).toEqual(["editMessageText"]);
		mode = "gone";
		reporter.event({ type: "tool_start", id: "c", name: "edit" });
		api.advance(3_000);
		await reporter.tick();
		const gone = api.calls.length;
		reporter.event({ type: "tool_start", id: "d", name: "task" });
		api.advance(5_000);
		await reporter.tick();
		await reporter.finish({ kind: "done" });
		expect(api.calls.slice(gone).map((c) => c.method)).toEqual(["sendChatAction"]);
	});
});

describe("agent events to progress", () => {
	test("maps tools, codemode inner calls, todos, retries and throttled activity without leaking arguments", () => {
		let t = 0;
		const out: ProgressEvent[] = [];
		const map = agentProgress((event) => out.push(event), () => t);
		const ev = (event: unknown) => event as AgentEvent;
		map([
			ev({ type: "tool_execution_start", toolCallId: "c1", toolName: "write", args: { path: "a.txt", content: "SECRET=1" } }),
			ev({ type: "tool_execution_end", toolCallId: "c1", toolName: "write", entry: { model: [{ role: "toolResult", isError: false }] } }),
			ev({ type: "tool_execution_start", toolCallId: "c2", toolName: "codemode", args: { code: "await tools.bash({command:'cat .env'})" } }),
			ev({ type: "tool_execution_update", toolCallId: "c2", toolName: "codemode", details: { codemodeCalls: [{ id: 1, name: "bash", status: "running" }] } }),
			ev({ type: "tool_execution_update", toolCallId: "c2", toolName: "codemode", details: { codemodeCalls: [{ id: 1, name: "bash", status: "done" }, { id: 2, name: "todo_write", status: "running" }], todos: [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "cancelled" }] } }),
			ev({ type: "tool_execution_end", toolCallId: "c2", toolName: "codemode", entry: { model: [{ role: "toolResult", isError: true, details: { codemodeCalls: [{ id: 1, name: "bash", status: "done" }, { id: 2, name: "todo_write", status: "failed" }] } }] } }),
			ev({ type: "auto_retry_start", attempt: 2, at: 0, errorMessage: "429" }),
			ev({ type: "message_update", usage: {}, changes: [{ type: "thinking_start", contentIndex: 0, block: {} }] }),
		]);
		// ADR 0057: `detail` is the redacted argument line (shown only by detailed cards); `current` is the todo text.
		// Neither carries tool output, code or file contents; the fixed `preview` vocabulary is unchanged.
		expect(out).toEqual([
			{ type: "tool_start", id: "c1", name: "write", preview: "file (.txt)", detail: "a.txt" },
			{ type: "tool_end", id: "c1", ok: true },
			{ type: "tool_start", id: "c2", name: "codemode" },
			{ type: "tool_start", id: "c2/1", name: "bash" },
			{ type: "activity" },
			{ type: "todos", done: 1, total: 2, current: "b" },
			{ type: "tool_end", id: "c2/1", ok: true },
			{ type: "tool_start", id: "c2/2", name: "todo_write" },
			{ type: "tool_end", id: "c2/2", ok: false },
			{ type: "tool_end", id: "c2", ok: false },
			{ type: "retry", attempt: 2 },
			{ type: "phase", phase: "thinking" },
		]);
		expect(JSON.stringify(out)).not.toContain("SECRET");
		expect(JSON.stringify(out)).not.toContain(".env");
		const before = out.length;
		for (let i = 0; i < 10; i++) {
			t += 1_000;
			map([ev({ type: "entry_appended", entry: {} })]);
		}
		expect(out.slice(before)).toEqual([{ type: "activity" }, { type: "activity" }]);
		expect(ACTIVITY_INTERVAL_MS).toBe(5_000);
	});

	test("J: inner calls pair start and end once, and a cell's end closes what its journal left running", () => {
		const ev = (event: unknown) => event as AgentEvent;
		const STATUSES = ["pending", "running", "done", "failed", "aborted"];
		for (let seed = 1; seed <= 200; seed++) {
			const random = rng(seed);
			const out: ProgressEvent[] = [];
			const map = agentProgress((event) => out.push(event), () => 0);
			const cells = ["c1", "c2", "c3"];
			const endedCells = new Set<string>();
			for (let i = 0; i < 60; i++) {
				const cell = cells[Math.floor(random() * cells.length)]!;
				const calls = Array.from({ length: Math.floor(random() * 4) }, (_, id) => ({ id, name: "bash", status: STATUSES[Math.floor(random() * STATUSES.length)] }));
				if (random() < 0.15) {
					endedCells.add(cell);
					map([ev({ type: "tool_execution_end", toolCallId: cell, toolName: "codemode", entry: { model: [{ details: { codemodeCalls: calls } }] } })]);
				} else map([ev({ type: "tool_execution_update", toolCallId: cell, toolName: "codemode", details: { codemodeCalls: calls } })]);
				const starts = new Map<string, number>();
				const ends = new Map<string, number>();
				for (const [index, event] of out.entries()) {
					if (event.type === "tool_start") {
						expect(starts.has(event.id)).toBe(false);
						starts.set(event.id, index);
					}
					if (event.type === "tool_end" && event.id.includes("/")) {
						expect(ends.has(event.id)).toBe(false);
						expect(starts.get(event.id)).toBeLessThan(index);
						ends.set(event.id, index);
					}
				}
				for (const id of starts.keys()) if (endedCells.has(id.split("/")[0]!)) expect(ends.has(id)).toBe(true);
			}
		}
		// Regression: an aborted cell whose journal still says running no longer leaves ▸ behind.
		const out: ProgressEvent[] = [];
		const map = agentProgress((event) => out.push(event), () => 0);
		map([
			ev({ type: "tool_execution_start", toolCallId: "c9", toolName: "codemode", args: {} }),
			ev({ type: "tool_execution_update", toolCallId: "c9", toolName: "codemode", details: { codemodeCalls: [{ id: 1, name: "bash", status: "running" }] } }),
			ev({ type: "tool_execution_end", toolCallId: "c9", toolName: "codemode", entry: { model: [{ isError: true, details: { codemodeCalls: [{ id: 1, name: "bash", status: "running" }] } }] } }),
			ev({ type: "tool_execution_update", toolCallId: "c9", toolName: "codemode", details: { codemodeCalls: [{ id: 2, name: "read", status: "running" }] } }),
		]);
		let state = initialProgress(0);
		for (const event of out) state = foldProgress(state, event, 0);
		expect(out.filter((event) => event.type === "tool_end" && event.id === "c9/1")).toEqual([{ type: "tool_end", id: "c9/1", ok: false }]);
		expect(out.some((event) => event.type === "tool_start" && event.id === "c9/2")).toBe(false);
		expect(renderProgress(state, 0)).not.toContain("▸");
	});
});

let dir: string | undefined;
let bot: Bot | undefined;
let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
afterEach(async () => {
	await bot?.close(BACKGROUND_CONTEXT);
	bot = undefined;
	await storage?.close(BACKGROUND_CONTEXT); storage = undefined;
	if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	dir = undefined;
});

const message: InboundMessage = { channel: "telegram", threadKey: "1:2:0:3", messageId: "m1", userId: "3", text: "hi" };

describe("core and sidecar transport", () => {
	test("bot.handle streams a real turn's tool and todo progress", async () => {
		dir = await mkdtemp(join(tmpdir(), "dinobot-progress-"));
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("todo_write", { todos: [{ id: "1", content: "check", status: "in_progress" }] }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			// No tool progress on reconciliation: the hook yields with the TODO still unfinished.
			fauxAssistantMessage("done"),
		]);
		bot = await openBot(
			{ storage: storage = await openNodeSqliteStorage(":memory:"), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [] },
			BACKGROUND_CONTEXT,
		);
		const events: ProgressEvent[] = [];
		const reply = await bot.handle(message, BACKGROUND_CONTEXT, (event) => events.push(event));
		expect(reply).toMatchObject({ status: "answered", text: "done" });
		expect(events.find((e) => e.type === "tool_start")).toMatchObject({ name: "todo_write" });
		expect(events).toContainEqual({ type: "todos", done: 0, total: 1, current: "check" });
		// ADR 0057: the answer text streams as draft snapshots before the reply settles.
		expect(events).toContainEqual({ type: "draft", text: "done" });
		expect(reply).toMatchObject({ answer: expect.any(Number) });
		expect(events.some((e) => e.type === "tool_end" && e.ok)).toBe(true);
	});

	test("http NDJSON carries progress, heartbeat and the reply to the forwarder; old clients still get JSON", async () => {
		const channel = httpChannel(0);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		await channel.start(async (_message, _signal, progress) => {
			progress?.({ type: "tool_start", id: "1", name: "bash", preview: "bun test" });
			await gate;
			progress?.({ type: "tool_end", id: "1", ok: true });
			return { status: "answered", text: "answer" };
		});
		try {
			const origin = channel.url().origin.replace("localhost", "127.0.0.1");
			const received: ProgressEvent[] = [];
			const pending = createTelegramForwarder(origin)(message, undefined, (event) => received.push(event));
			await Bun.sleep(100);
			release();
			expect(await pending).toEqual({ status: "answered", text: "answer" });
			expect(received[0]).toEqual({ type: "heartbeat" });
			expect(received).toContainEqual({ type: "tool_start", id: "1", name: "bash", preview: "bun test" });
			expect(received).toContainEqual({ type: "tool_end", id: "1", ok: true });
			const plain = await fetch(`${origin}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) });
			expect(plain.headers.get("content-type")).toContain("application/json");
			expect(await plain.json()).toEqual({ status: "answered", text: "answer" });
		} finally {
			await channel.stop();
		}
	});

	test("a silent core fails the turn as unresponsive after the idle bound", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"type":"heartbeat"}\n')); } }), { headers: { "content-type": "application/x-ndjson" } }),
		});
		try {
			const started = Date.now();
			const error = await createTelegramForwarder(server.url.origin, { idleTimeoutMs: 150 })(message).catch((e: Error) => e);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).name).toBe("CoreUnresponsive");
			expect(Date.now() - started).toBeLessThan(2_000);
		} finally {
			await server.stop(true);
		}
	});
});

describe("telegram channel integration", () => {
	type Recorded = { method: string; body: Record<string, unknown> };
	async function run(handler: (m: InboundMessage, s?: AbortSignal, p?: (e: ProgressEvent) => void) => Promise<BotReply>) {
		dir = await mkdtemp(join(tmpdir(), "dinobot-tgprogress-"));
		const recorded: Recorded[] = [];
		const menus: Recorded[] = [];
		const api = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const method = new URL(request.url).pathname.split("/").at(-1)!;
				const body = (await request.json()) as Record<string, unknown>;
				if (method === "setMyCommands") {
					expect(request.method).toBe("POST");
					menus.push({ method, body });
					return Response.json({ ok: true, result: true });
				}
				recorded.push({ method, body });
				return Response.json({ ok: true, result: method === "sendMessage" ? { message_id: recorded.length } : true });
			},
		});
		process.env.PROGRESS_TEST_TOKEN = "123:abc";
		process.env.PROGRESS_TEST_SECRET = "secret";
		const channel = telegramChannel(
			{ port: 0, databasePath: join(dir, "tg.sqlite"), allowedUserIds: ["7"], allowedChatIds: ["-9"], botTokenEnv: "PROGRESS_TEST_TOKEN", webhookSecretEnv: "PROGRESS_TEST_SECRET" },
			{ apiBase: api.url.origin },
		);
		await channel.start(handler);
		const update = { update_id: 1, message: { message_id: 1, message_thread_id: 77, from: { id: 7, is_bot: false }, chat: { id: -9, type: "supergroup" }, text: "work" } };
		const response = await fetch(new URL("/webhook", channel.url()), { method: "POST", headers: { "x-telegram-bot-api-secret-token": "secret", "content-type": "application/json" }, body: JSON.stringify(update) });
		expect(response.status).toBe(200);
		const until = async (check: () => boolean) => {
			for (let i = 0; i < 600 && !check(); i++) await Bun.sleep(10);
		};
		return { recorded, menus, until, stop: async () => { await channel.stop(); await api.stop(true); } };
	}

	test("status message, then its final edit, then the answer, all in the topic", async () => {
		const t = await run(async (_m, _s, progress) => {
			progress?.({ type: "tool_start", id: "1", name: "bash", preview: "bun test" });
			await Bun.sleep(1_300);
			progress?.({ type: "tool_end", id: "1", ok: true });
			return { status: "answered", text: "the answer" };
		});
		try {
			await t.until(() => t.recorded.some((r) => r.body.text === "the answer"));
			const writes = t.recorded.filter((r) => r.method !== "sendChatAction");
			expect(t.menus).toHaveLength(1);
			expect(t.menus[0]!.body).toMatchObject({ scope: { type: "default" }, commands: expect.arrayContaining([expect.objectContaining({ command: "new" })]) });
			expect(writes.map((r) => r.method)).toEqual(["sendMessage", "editMessageText", "sendMessage"]);
			expect(String(writes[0]!.body.text)).toContain("▸ bash: bun test");
			expect(writes[0]!.body).toMatchObject({ message_thread_id: 77, disable_notification: true });
			expect(String(writes[1]!.body.text)).toStartWith("✅ 완료");
			expect(writes[2]!.body).toMatchObject({ text: "the answer", message_thread_id: 77 });
			expect(t.recorded.some((r) => r.method === "sendChatAction" && r.body.message_thread_id === 77)).toBe(true);
		} finally {
			await t.stop();
		}
	});

	test("a failed turn edits the status to stopped and tells the user instead of staying silent", async () => {
		const t = await run(async (_m, _s, progress) => {
			progress?.({ type: "tool_start", id: "1", name: "bash" });
			await Bun.sleep(1_200);
			throw Object.assign(new Error("gone"), { name: "CoreUnresponsive" });
		});
		try {
			await t.until(() => t.recorded.filter((r) => r.method === "sendMessage").length === 2);
			const writes = t.recorded.filter((r) => r.method !== "sendChatAction");
			expect(String(writes.find((r) => r.method === "editMessageText")!.body.text)).toStartWith("⚠️ 중단");
			expect(writes.at(-1)!.body.text).toBe(failureNotice("core 응답 없음"));
		} finally {
			await t.stop();
		}
	});
});
