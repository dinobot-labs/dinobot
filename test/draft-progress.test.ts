import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DRAFT_VIEW_UNITS, foldProgress, initialProgress, parseProgressEvent, RECENT_TOOLS, RECENT_TOOLS_DETAILED, renderProgress, tail, VIEW_LIMIT_UNITS, withOutcome } from "../src/channels/progress.ts";
import { detailPreview, redactSecrets } from "../src/channels/safe-preview.ts";
import { type TelegramResult, telegramProgress } from "../src/channels/telegram-progress.ts";
import type { InboundMessage, ProgressEvent } from "../src/channels/types.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { agentProgress, DRAFT_INTERVAL_MS, DRAFT_TAIL_UNITS, draftTail } from "../src/core/progress-events.ts";

// ADR 0057: detailed tool progress, answer draft streaming and steer events, from the core mapping to the card.

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

describe("detail previews", () => {
	test("the primary argument line is shown, one line, bounded, with token shapes masked", () => {
		expect(detailPreview({ command: "bun test test/foo.test.ts" })).toBe("bun test test/foo.test.ts");
		expect(detailPreview({ path: "src/channels/progress.ts", content: "SECRET=1" })).toBe("src/channels/progress.ts");
		expect(detailPreview({ pattern: "foo\n  bar\tbaz" })).toBe("foo bar baz");
		expect(detailPreview({ code: "await tools.bash({command:'cat .env'})" })).toBeUndefined();
		expect(detailPreview({ command: "word ".repeat(100) })!.length).toBe(200);
		expect(detailPreview({ command: "x".repeat(500) })).toBe("[redacted]"); // an opaque blob is masked, not shown
		const curl = detailPreview({ command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123' https://x" })!;
		expect(curl).toContain("[redacted]");
		expect(curl).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
		expect(detailPreview({ command: "export OPENAI_KEY=sk-proj-abcdefghijklmnop123456" })).toBe("export OPENAI_KEY=[redacted]");
		expect(detailPreview({ command: "git push https://ghp_abcdefghijklmnop1234@github.com/x" })).toContain("[redacted]");
		expect(redactSecrets("AKIA" + "ABCDEFGHIJKLMNOP and xoxb-12345678-abcdefgh and password=hunter2")).toBe("[redacted] and [redacted] and [redacted]");
		expect(redactSecrets("a".repeat(45))).toBe("[redacted]"); // long opaque blobs are masked too
		expect(redactSecrets("plain words only")).toBe("plain words only");
	});
});

describe("draft and detailed card", () => {
	test("status mode hides details and todo text; detailed mode shows them and keeps more lines", () => {
		const t = 10_000;
		let status = initialProgress(0);
		let detailed = initialProgress(0, { detailed: true });
		const events: ProgressEvent[] = [
			{ type: "tool_start", id: "a", name: "bash", preview: "bun test", detail: "bun test test/x.test.ts --bail" },
			{ type: "tool_end", id: "a", ok: true },
			{ type: "todos", done: 1, total: 3, current: "wire the forwarder" },
			{ type: "tool_start", id: "b", name: "read", detail: "src/channels/messaging.ts" },
		];
		for (const event of events) { status = foldProgress(status, event, t); detailed = foldProgress(detailed, event, t); }
		expect(renderProgress(status, t + 1000)).toBe(["⏳ 작업 중 · 1분 미만 · 도구 2회", "📋 1/3 · step in progress", "✓ bash: bun test · done 0s", "▸ read · running 1s"].join("\n"));
		expect(renderProgress(detailed, t + 1000)).toBe(["⏳ 작업 중 · 1분 미만 · 도구 2회", "📋 1/3 · wire the forwarder", "✓ bash: bun test test/x.test.ts --bail · done 0s", "▸ read: src/channels/messaging.ts · running 1s"].join("\n"));
		for (let i = 0; i < 20; i++) { status = foldProgress(status, { type: "tool_start", id: `t${i}`, name: `tool${i}` }, t); detailed = foldProgress(detailed, { type: "tool_start", id: `t${i}`, name: `tool${i}` }, t); }
		expect(status.recent).toHaveLength(RECENT_TOOLS);
		expect(detailed.recent).toHaveLength(RECENT_TOOLS_DETAILED);
	});

	test("a draft follows the card while running, is replaced by later snapshots, and is cleared by the outcome", () => {
		let s = initialProgress(0, { detailed: true });
		s = foldProgress(s, { type: "phase", phase: "writing" }, 1000);
		s = foldProgress(s, { type: "draft", text: "Hello" }, 1500);
		expect(renderProgress(s, 2000)).toBe("⏳ 작업 중 · 1분 미만\n✍️ 답변 작성 중\n\nHello ▉");
		s = foldProgress(s, { type: "draft", text: "Hello, world" }, 2500);
		expect(renderProgress(s, 3000)).toBe("⏳ 작업 중 · 1분 미만\n✍️ 답변 작성 중\n\nHello, world ▉");
		s = foldProgress(s, { type: "tool_start", id: "x", name: "bash" }, 3500);
		expect(renderProgress(s, 4000)).toBe("⏳ 작업 중 · 1분 미만 · 도구 1회\n▸ bash · running 0s\n\nHello, world"); // no cursor while a tool runs
		s = foldProgress(s, { type: "steer" }, 4500);
		expect(renderProgress(s, 5000)).toContain("📨 추가 메시지 1건 반영");
		const done = withOutcome(s, { kind: "done" }, 6000);
		expect(done.draft).toBeUndefined();
		expect(renderProgress(done, 6000)).toBe("✅ 완료 · 1분 미만 · 도구 1회\n📨 추가 메시지 1건 반영\n✗ bash · failed 2s");
		expect(foldProgress(done, { type: "draft", text: "late" }, 7000)).toBe(done);
	});

	test("tail keeps the end, marks a cut, and never splits a surrogate pair", () => {
		expect(tail("abc", 10)).toBe("abc");
		expect(tail("abcdef", 4)).toBe("…def");
		expect(tail("x😀😀", 3)).toBe("…😀");
		expect(tail("x😀😀", 4)).toBe("…😀");
		expect(tail("abc", 0)).toBe("");
		expect(draftTail("a".repeat(DRAFT_TAIL_UNITS + 5)).length).toBe(DRAFT_TAIL_UNITS);
		expect(draftTail("b" + "😀".repeat(DRAFT_TAIL_UNITS / 2)).length).toBe(DRAFT_TAIL_UNITS);
	});

	test("B: random detailed traces with long drafts keep every view within the Telegram message bound", () => {
		const random = rng(57);
		let worst = 0;
		for (let trace = 0; trace < 200; trace++) {
			let s = initialProgress(0, { detailed: true });
			let t = 0;
			let id = 0;
			for (let i = 0; i < 60; i++) {
				t += Math.floor(random() * 5000);
				const r = random();
				const event: ProgressEvent =
					r < 0.3 ? { type: "tool_start", id: String(id++), name: "tool".repeat(1 + Math.floor(random() * 20)), detail: "d".repeat(Math.floor(random() * 400)) }
					: r < 0.5 ? { type: "tool_end", id: String(Math.floor(random() * id)), ok: random() < 0.5 }
					: r < 0.7 ? { type: "draft", text: "😀x\n".repeat(Math.floor(random() * 1500)) }
					: r < 0.8 ? { type: "todos", done: 1, total: 9, current: "todo ".repeat(Math.floor(random() * 50)) }
					: r < 0.9 ? { type: "steer" }
					: { type: "phase", phase: "writing" };
				s = foldProgress(s, event, t);
				const view = renderProgress(s, t + Math.floor(random() * 120_000));
				worst = Math.max(worst, view.length);
				expect(view.length).toBeLessThanOrEqual(VIEW_LIMIT_UNITS);
				expect(view.split("\n").length).toBeLessThanOrEqual(12 + 2 + 1500);
				for (const unit of view) if (unit.charCodeAt(0) >= 0xd800 && unit.charCodeAt(0) <= 0xdbff) expect(view.length).toBeGreaterThan(0);
			}
			expect(renderProgress(withOutcome(s, { kind: "done" }, t), t).length).toBeLessThanOrEqual(2048);
		}
		expect(worst).toBeGreaterThan(DRAFT_VIEW_UNITS); // the bound was exercised
	});

	test("wire validation accepts draft, steer and detail and rejects malformed ones", () => {
		expect(parseProgressEvent({ type: "draft", text: "abc" })).toEqual({ type: "draft", text: "abc" });
		expect(parseProgressEvent({ type: "draft", text: "" })).toBeUndefined();
		expect(parseProgressEvent({ type: "draft", text: "x".repeat(4097) })).toBeUndefined();
		expect(parseProgressEvent({ type: "draft" })).toBeUndefined();
		expect(parseProgressEvent({ type: "steer" })).toEqual({ type: "steer" });
		expect(parseProgressEvent({ type: "tool_start", id: "a", name: "bash", detail: "ls" })).toEqual({ type: "tool_start", id: "a", name: "bash", detail: "ls" });
		expect(parseProgressEvent({ type: "tool_start", id: "a", name: "bash", detail: "x".repeat(401) })).toBeUndefined();
		expect(parseProgressEvent({ type: "tool_start", id: "a", name: "bash", detail: 5 })).toBeUndefined();
	});

	test("the Telegram writer carries the draft in its single status message under the same write bounds", async () => {
		let t = 0;
		const calls: { method: string; body: Record<string, unknown> }[] = [];
		const api = async (method: string, body: Record<string, unknown>): Promise<TelegramResult> => { calls.push({ method, body }); return { ok: true, result: { message_id: 1 } }; };
		const reporter = telegramProgress({ call: api, chat: "-1", topic: "0", now: () => t, sleep: async (ms) => { t += ms; }, detailed: true });
		reporter.event({ type: "tool_start", id: "a", name: "bash", detail: "bun test" });
		await reporter.tick();
		reporter.event({ type: "tool_end", id: "a", ok: true });
		reporter.event({ type: "phase", phase: "writing" });
		for (let i = 0; i < 40; i++) { t += 100; reporter.event({ type: "draft", text: "answer ".repeat(i + 1) }); await reporter.tick(); }
		const edits = calls.filter((c) => c.method === "editMessageText");
		expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(1);
		expect(edits.length).toBeGreaterThanOrEqual(1);
		expect(edits.length).toBeLessThanOrEqual(2); // 4 s of ticks at Δ = 3 s: the draft is sampled, not pushed per event
		expect(String(edits.at(-1)!.body.text)).toMatch(/\n\n(answer )+ ▉$/);
		expect(String(calls.find((c) => c.method === "sendMessage")!.body.text)).toContain("▸ bash: bun test");
		await reporter.finish({ kind: "done" });
		const final = calls.at(-1)!;
		expect(final.method).toBe("editMessageText");
		expect(String(final.body.text)).not.toContain("answer");
		expect(String(final.body.text)).toContain("✅ 완료");
	});
});

describe("agent events to drafts and steers", () => {
	test("text deltas accumulate into throttled snapshots; message_end forces one; snapshot resynchronizes; steers of other inputs are reported", () => {
		let t = 0;
		const out: ProgressEvent[] = [];
		const map = agentProgress((event) => out.push(event), { now: () => t, own: 5 as never });
		const ev = (event: unknown) => event as AgentEvent;
		map([ev({ type: "message_start", message: { role: "assistant", content: [] } })]);
		map([ev({ type: "message_update", usage: {}, changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } }, { type: "text_delta", contentIndex: 0, delta: "Hel" }] })]);
		t = 100;
		map([ev({ type: "message_update", usage: {}, changes: [{ type: "text_delta", contentIndex: 0, delta: "lo" }] })]);
		expect(out.filter((e) => e.type === "draft")).toEqual([{ type: "draft", text: "Hel" }]); // the second is within the interval
		t = DRAFT_INTERVAL_MS + 1;
		map([ev({ type: "message_update", usage: {}, changes: [{ type: "text_delta", contentIndex: 0, delta: ", world" }] })]);
		expect(out.filter((e) => e.type === "draft").at(-1)).toEqual({ type: "draft", text: "Hello, world" });
		map([ev({ type: "message_update", usage: {}, changes: [{ type: "thinking_delta", contentIndex: 1, delta: "secret thought" }] })]);
		expect(JSON.stringify(out)).not.toContain("secret thought");
		t += 10;
		map([ev({ type: "message_end", entry: { model: [{ role: "assistant", content: [{ type: "text", text: "Hello, world!" }] }] } })]);
		expect(out.filter((e) => e.type === "draft").at(-1)).toEqual({ type: "draft", text: "Hello, world!" }); // forced despite the interval
		t += 10;
		map([ev({ type: "snapshot", entries: [], tools: [], compactions: [], inbox: [], agent: {}, usage: {}, generation: { attempt: 1, message: { role: "assistant", content: [{ type: "text", text: "Resynced" }] } } })]);
		expect(out.filter((e) => e.type === "draft").at(-1)).toEqual({ type: "draft", text: "Resynced" });
		map([
			ev({ type: "submission", record: { id: 5, conversationId: 1, type: "input", status: "placed", entry: 9 } }),
			ev({ type: "submission", record: { id: 6, conversationId: 1, type: "input", status: "placed", entry: 10 } }),
			ev({ type: "submission", record: { id: 7, conversationId: 1, type: "input", status: "queued" } }),
		]);
		expect(out.filter((e) => e.type === "steer")).toHaveLength(1);
		// A long answer streams only its tail.
		t += 1000;
		map([ev({ type: "message_start", message: { role: "assistant", content: [] } }), ev({ type: "message_update", usage: {}, changes: [{ type: "text_start", contentIndex: 0, block: { type: "text", text: "z".repeat(DRAFT_TAIL_UNITS + 100) }}] })]);
		expect((out.at(-1) as { text: string }).text.length).toBe(DRAFT_TAIL_UNITS);
	});

	test("text already carried by message_start is kept at the front of the draft (report 8912da0e)", () => {
		let t = 0;
		const out: ProgressEvent[] = [];
		const map = agentProgress((event) => out.push(event), { now: () => t, own: 5 as never });
		const ev = (event: unknown) => event as AgentEvent;
		map([ev({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "**기본 서브에" }] } })]);
		t = DRAFT_INTERVAL_MS + 1;
		map([ev({ type: "message_update", usage: {}, changes: [{ type: "text_delta", contentIndex: 0, delta: "이전트를 쓰거나" }] })]);
		expect(out.filter((e) => e.type === "draft").at(-1)).toEqual({ type: "draft", text: "**기본 서브에이전트를 쓰거나" });
	});
});

let dir: string | undefined;
let bot: Bot | undefined;
let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
afterEach(async () => {
	await bot?.close(BACKGROUND_CONTEXT);
	bot = undefined;
	await storage?.close(BACKGROUND_CONTEXT);
	storage = undefined;
	if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	dir = undefined;
});

describe("core steering", () => {
	test("a steer joins the running turn: both inputs settle on one answer id and the primary sees a steer event", async () => {
		dir = await mkdtemp(join(tmpdir(), "dinobot-steer-"));
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 0.6" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done both"),
		]);
		bot = await openBot(
			{ storage: storage = await openNodeSqliteStorage(":memory:"), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [], workspaceRoot: dir },
			BACKGROUND_CONTEXT,
		);
		const base: InboundMessage = { channel: "telegram", threadKey: "1:2:0:3", messageId: "m1", userId: "3", text: "start" };
		const events: ProgressEvent[] = [];
		let started!: () => void;
		const toolStarted = new Promise<void>((r) => { started = r; });
		const primary = bot.handle(base, BACKGROUND_CONTEXT, (event) => { events.push(event); if (event.type === "tool_start") started(); });
		await toolStarted;
		const steer = await bot.handle({ ...base, messageId: "m2", text: "also mention this" }, BACKGROUND_CONTEXT, undefined, { whenBusy: "steer" });
		const first = await primary;
		expect(first).toMatchObject({ status: "answered", text: "done both" });
		expect(steer).toMatchObject({ status: "answered", text: "done both" });
		expect((steer as { answer?: number }).answer).toBe((first as { answer?: number }).answer);
		expect(events).toContainEqual({ type: "steer" });
		expect(events.find((e) => e.type === "tool_start")).toMatchObject({ name: "bash", detail: "sleep 0.6" });
		expect(events).toContainEqual({ type: "draft", text: "done both" });
	});
});
