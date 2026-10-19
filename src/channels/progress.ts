import { safeHint, TODO_SUMMARY } from "./safe-preview.ts";
import type { ProgressEvent } from "./types.ts";

/**
 * Pure model of a turn's visible progress (ADR 0047): `foldProgress` folds events into a bounded state and
 * `renderProgress` projects it to status text. Header/idle use minutes; each running tool uses seconds.
 * Platform writers coalesce those views at >=3s spacing (ADR 0055); elapsed time is not activity.
 *
 * Running invariant (I): for every line key k, the `running` counts of the recent lines with key k sum to at most the
 * number of open calls with key k. Hence no line shows ▸ once no call with its key is open.
 */

/** Recent tool lines kept in the view (status mode); detailed mode keeps RECENT_TOOLS_DETAILED (ADR 0057). */
export const RECENT_TOOLS = 3;
export const RECENT_TOOLS_DETAILED = 8;
/** Preview hint cap, in code points. */
export const PREVIEW_CHARS = 40;
/** Detailed hint cap and todo item cap, in code points (ADR 0057). */
export const DETAIL_VIEW_CHARS = 60;
const TODO_VIEW_CHARS = 60;
/** Longest draft tail shown, in UTF-16 units, before the 4096 message bound is applied (ADR 0057). */
export const DRAFT_VIEW_UNITS = 2_900;
/** Telegram message bound the whole view must respect. */
export const VIEW_LIMIT_UNITS = 4_096;
/** Idle time after which the view says nothing new has happened. */
export const STALE_MS = 60_000;
const NAME_CHARS = 32;

const REASON_CHARS = 80;

export type ToolLine = {
	readonly key: string;
	readonly name: string;
	readonly preview?: string;
	/** Redacted argument line, shown only in detailed mode. */
	readonly detail?: string;
	/** Calls of this line still running. */
	readonly running: number;
	/** Calls merged into this line (consecutive identical name + preview). */
	readonly count: number;
	readonly failed: boolean;
	readonly startedAt: number;
	readonly endedAt?: number | undefined;
};

export type ProgressOutcome = { readonly kind: "done" } | { readonly kind: "failed"; readonly reason: string };

export type ProgressState = {
	readonly startedAt: number;
	/** Detailed mode: argument lines, todo text and more recent lines (ADR 0057). */
	readonly detailed: boolean;
	/** Last event that was not a heartbeat. */
	readonly lastActivityAt: number;
	readonly tools: number;
	readonly recent: readonly ToolLine[];
	/** Answer text written so far (tail); cleared by the outcome. */
	readonly draft?: string;
	/** Inputs that joined this turn. */
	readonly steers: number;
	/** Open call id -> line key; bounded by the calls still running. */
	readonly open: Readonly<Record<string, string>>;
	readonly todos?: { readonly done: number; readonly total: number; readonly current?: string };
	readonly phase?: "thinking" | "writing";
	readonly retry?: number;
	readonly outcome?: ProgressOutcome;
};

export function initialProgress(now: number, options: { readonly detailed?: boolean } = {}): ProgressState {
	return { startedAt: now, detailed: options.detailed === true, lastActivityAt: now, tools: 0, recent: [], open: {}, steers: 0 };
}

/** One line of plain text, control characters removed, at most `max` code points. */
export function clip(text: string, max: number): string {
	const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
	const points = [...flat];
	return points.length <= max ? flat : `${points.slice(0, max - 1).join("")}…`;
}

const OPEN_LIMIT = 256;

/** Total and pure. Heartbeats return the same state object; events after an outcome change nothing. */
export function foldProgress(state: ProgressState, event: ProgressEvent, now: number): ProgressState {
	if (event.type === "heartbeat" || state.outcome) return state;
	const base = { ...state, lastActivityAt: Math.max(state.lastActivityAt, now) };
	switch (event.type) {
		case "activity":
			return base;
		case "phase":
			return { ...base, phase: event.phase };
		case "retry":
			return { ...base, retry: event.attempt };
		case "draft":
			return { ...base, draft: event.text };
		case "steer":
			return { ...base, steers: state.steers + 1 };
		case "todos": {
			const total = Math.max(0, Math.floor(event.total));
			const done = Math.min(total, Math.max(0, Math.floor(event.done)));
			const current = event.current ? (state.detailed ? clip(event.current, TODO_VIEW_CHARS) || TODO_SUMMARY : TODO_SUMMARY) : undefined;
			return { ...base, todos: current ? { done, total, current } : { done, total } };
		}
		case "tool_start": {
			if (Object.hasOwn(state.open, event.id)) return state;
			const name = clip(event.name, NAME_CHARS) || "tool";
			const preview = event.preview ? safeHint(event.preview) : undefined;
			const detail = state.detailed && event.detail ? clip(event.detail, DETAIL_VIEW_CHARS) || undefined : undefined;
			const identity = `${name}\u0000${preview ?? ""}\u0000${detail ?? ""}`;
			const keep = state.detailed ? RECENT_TOOLS_DETAILED : RECENT_TOOLS;
			const key = `${identity}\u0000${state.tools}`;
			// Forgetting every open call (calls whose end never arrived) must also forget their running counts, or (I) breaks.
			const full = Object.keys(state.open).length >= OPEN_LIMIT;
			const open = full ? {} : state.open;
			const lines = full ? state.recent.map((line) => (line.running > 0 ? { ...line, running: 0, failed: true, endedAt: now } : line)) : state.recent;
			const last = lines.at(-1);
			const recent =
				last && `${last.name}\u0000${last.preview ?? ""}\u0000${last.detail ?? ""}` === identity
					? [...lines.slice(0, -1), { ...last, running: last.running + 1, count: last.count + 1, startedAt: Math.min(last.startedAt, event.at !== undefined ? Math.min(now, Math.max(state.startedAt, event.at)) : now) }]
					: [...lines, { key, name, ...(preview ? { preview } : {}), ...(detail ? { detail } : {}), running: 1, count: 1, failed: false, startedAt: event.at !== undefined ? Math.min(now, Math.max(state.startedAt, event.at)) : now }].slice(-keep);
			const { phase: _phase, retry: _retry, ...rest } = base;
			return { ...rest, tools: state.tools + 1, recent, open: { ...open, [event.id]: recent.at(-1)!.key } };
		}
		case "tool_end": {
			if (!Object.hasOwn(state.open, event.id)) return state;
			const key = state.open[event.id];
			const { [event.id]: _closed, ...open } = state.open;
			// The newest line with that key is the one the call joined; older lines may share a key after other tools.
			const index = state.recent.findLastIndex((line) => line.key === key && line.running > 0);
			if (index < 0) return { ...base, open };
			const line = state.recent[index]!;
			const recent = state.recent.map((entry, i) =>
				i === index ? { ...line, running: line.running - 1, failed: line.failed || !event.ok, endedAt: Math.max(line.endedAt ?? line.startedAt, Math.min(now, event.at ?? now)) } : entry,
			);
			return { ...base, open, recent };
		}
	}
}

export function withOutcome(state: ProgressState, outcome: ProgressOutcome, now: number): ProgressState {
	if (state.outcome) return state;
	const reason = outcome.kind === "failed" ? clip(outcome.reason, REASON_CHARS) || "failed" : undefined;
	const { draft: _draft, ...rest } = state;
	return { ...rest, open: {}, recent: state.recent.map(line => line.running > 0 ? { ...line, running: 0, failed: true, endedAt: Math.max(now, line.startedAt) } : line), lastActivityAt: Math.max(state.lastActivityAt, now), outcome: reason === undefined ? outcome : { kind: "failed", reason } };
}

/** Whole minutes as Korean text: "1분 미만", "3분", "1시간 5분". */
export function minutes(ms: number): string {
	const total = Math.floor(Math.max(0, ms) / 60_000);
	if (total < 1) return "1분 미만";
	const hours = Math.floor(total / 60);
	const rest = total % 60;
	if (hours === 0) return `${total}분`;
	return rest === 0 ? `${hours}시간` : `${hours}시간 ${rest}분`;
}

function toolLine(line: ToolLine, now: number): string {
	const mark = line.running > 0 ? "▸" : line.failed ? "✗" : "✓";
	const repeat = line.count > 1 ? ` ×${line.count}` : "";
	const hint = line.detail ?? line.preview;
	return `${mark} ${line.name}${hint ? `: ${hint}` : ""}${repeat} · ${line.running > 0 ? "running" : line.failed ? "failed" : "done"} ${Math.floor(Math.max(0, (line.running > 0 ? now : line.endedAt ?? now) - line.startedAt) / 1000)}s`;
}

/** The last `units` UTF-16 units of `text` without splitting a surrogate pair; an `…` prefix marks a cut. */
export function tail(text: string, units: number): string {
	if (units <= 0) return "";
	if (text.length <= units) return text;
	let start = text.length - units + 1;
	const unit = text.charCodeAt(start);
	if (unit >= 0xdc00 && unit <= 0xdfff) start++;
	return `…${text.slice(start)}`;
}

/**
 * Status text; second durations and minute header/idle. The card is at most 12 lines of bounded width; while the turn
 * runs, the draft tail follows after a blank line and the whole view stays within VIEW_LIMIT_UNITS (ADR 0057).
 */
export function renderProgress(state: ProgressState, now: number): string {
	const elapsed = minutes(now - state.startedAt);
	const tools = state.tools > 0 ? ` · 도구 ${state.tools}회` : "";
	const todo = state.todos && state.todos.total > 0 ? `📋 ${state.todos.done}/${state.todos.total}${state.todos.current ? ` · ${state.todos.current}` : ""}` : undefined;
	const steers = state.steers > 0 ? [`📨 추가 메시지 ${state.steers}건 반영`] : [];
	if (state.outcome?.kind === "done") return [`✅ 완료 · ${elapsed}${tools}`, ...(todo ? [todo] : []), ...steers, ...state.recent.map(line => toolLine(line, now))].join("\n");
	if (state.outcome?.kind === "failed") return [`⚠️ 중단 · ${elapsed}${tools}`, state.outcome.reason, ...(todo ? [todo] : []), ...steers, ...state.recent.map(line => toolLine(line, now))].join("\n");
	const header = state.retry !== undefined ? `🔁 모델 재시도 ${state.retry}회 · ${elapsed}${tools}` : `⏳ 작업 중 · ${elapsed}${tools}`;
	const lines = [header, ...(todo ? [todo] : []), ...steers, ...state.recent.map(line => toolLine(line, now))];
	const idle = now - state.lastActivityAt;
	const running = state.recent.some((line) => line.running > 0);
	if (idle >= STALE_MS) lines.push(`⚠️ ${minutes(idle)}째 새 활동 없음`);
	else if (!running && state.phase === "thinking") lines.push("💭 생각 중");
	else if (!running && state.phase === "writing") lines.push("✍️ 답변 작성 중");
	const card = lines.join("\n");
	if (!state.draft) return card;
	const cursor = state.phase === "writing" && !running ? " ▉" : "";
	const room = Math.min(DRAFT_VIEW_UNITS, VIEW_LIMIT_UNITS - card.length - 2 - cursor.length);
	const draft = tail(state.draft.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g, ""), room);
	return draft === "" ? card : `${card}\n\n${draft}${cursor}`;
}

const isString = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;

/** Validates an untrusted wire value (the sidecar's NDJSON); undefined for anything malformed. */
export function parseProgressEvent(value: unknown): ProgressEvent | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const v = value as Record<string, unknown>;
	switch (v.type) {
		case "heartbeat":
		case "activity":
		case "steer":
			return { type: v.type };
		case "draft":
			return isString(v.text, 4096) && v.text !== "" ? { type: "draft", text: v.text } : undefined;
		case "phase":
			return v.phase === "thinking" || v.phase === "writing" ? { type: "phase", phase: v.phase } : undefined;
		case "retry":
			return isCount(v.attempt) ? { type: "retry", attempt: v.attempt } : undefined;
		case "todos":
			if (!isCount(v.done) || !isCount(v.total) || (v.current !== undefined && !isString(v.current, 1000))) return undefined;
			return { type: "todos", done: v.done, total: v.total, ...(v.current !== undefined ? { current: v.current } : {}) };
		case "tool_start":
			if (!isString(v.id, 200) || !isString(v.name, 200) || (v.preview !== undefined && !isString(v.preview, 1000)) || (v.detail !== undefined && !isString(v.detail, 400))) return undefined;
			if (v.at !== undefined && (typeof v.at !== "number" || !Number.isSafeInteger(v.at) || v.at < 0)) return undefined;
			return { type: "tool_start", id: v.id, name: v.name, ...(v.preview !== undefined ? { preview: v.preview } : {}), ...(v.detail !== undefined ? { detail: v.detail } : {}), ...(typeof v.at === "number" ? { at: v.at } : {}) };
		case "tool_end":
			if (v.at !== undefined && (typeof v.at !== "number" || !Number.isSafeInteger(v.at) || v.at < 0)) return undefined;
			return isString(v.id, 200) && typeof v.ok === "boolean" ? { type: "tool_end", id: v.id, ok: v.ok, ...(typeof v.at === "number" ? { at: v.at } : {}) } : undefined;
		default:
			return undefined;
	}
}
