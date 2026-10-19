import { type Component, Container, HStack, type ScrollView, truncateToWidth, visibleWidth, stripTerminalSequences, wrapTextWithAnsi, VStack } from "@earendil-works/pi-tui";
import type { SubagentProgress } from "../../core/ui-contract.ts";
import { ReflowScrollView } from "../chrome.ts";
import { shownWorkflow, workflowState, workflowStyle, workflowText } from "../panes/plan.ts";
import type { RenderContext } from "../screen.ts";
import type { Block, SubagentBlock, ToolBlock } from "../state.ts";
import { bold, color, dim, brailleSpinner, formatElapsed, glyph, paint, separator, spacing, spinnerFrame, square, type Style } from "../theme.ts";
import { statusText, statusStyle, type DisplayStatus, type ToolVerb, verbFor } from "./tools.ts";

const LABEL = "Subagent";
const LABEL_WIDTH = LABEL.length + 1;
/** Grok clamps an activity subject to its first non-empty line and 40 characters (acp/tracker.rs). */
const ACTIVITY_SUBJECT_CHARS = 40;
/** Four live tasks occupy at most eight activity rows; overflow is accessible through /agents. */
export const ROSTER_MAX_ROWS = 4;
const RAIL_ROWS = 512;
const EMPTY: string[] = [];

type Cached = { key: string; lines: string[] };
export type Clock = { readonly tick: number; readonly now: number };

const blink = (style: Style, tick: number): Style => (tick % 8 < 4 ? style : (text) => dim(style(text)));

const elapsedLabel = (progress: SubagentProgress, now: number): string => progress.status !== "running" && progress.endedAt === undefined ? "" : formatElapsed(elapsedMs(progress, now));

const elapsedMs = (progress: SubagentProgress, now: number): number => Math.max(0, (progress.endedAt ?? (progress.status === "running" ? now : progress.startedAt)) - progress.startedAt);

/** `4s`, `1m06s`, `1h02m`: the dock column (views/goal_detail.rs format_elapsed), zero-padded unlike the row's `completed in 1m6s`. */
const dockElapsed = (ms: number): string => {
	const total = Math.floor(ms / 1000);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
};

const clampSubject = (text: string): string => {
	const line = text.split("\n").map((part) => part.trim()).find((part) => part !== "") ?? text.trim();
	const chars = [...line];
	return chars.length <= ACTIVITY_SUBJECT_CHARS ? line : chars.slice(0, ACTIVITY_SUBJECT_CHARS).join("");
};

/** The live activity Grok shows beside a running subagent: the running tool, else its latest text clamped with `…`, else the response wait. */
export function activityLabel(progress: SubagentProgress): string {
	if (progress.status !== "running") return "";
	if (progress.currentTool !== undefined) return `Running: ${clean(progress.currentTool)}`;
	const text = stripTerminalSequences(progress.lastText ?? "").trim();
	return text === "" ? `Waiting for response${glyph.ellipsis}` : `${clampSubject(text)}${glyph.ellipsis}`;
}

/** The contract carries no model yet; a progress that has one fills Grok's model slot, otherwise the subagent type stands in. */
const modelOf = (progress: SubagentProgress): string | undefined =>
	"model" in progress && typeof progress.model === "string" && progress.model !== "" ? progress.model : undefined;
const metaColumn = (progress: SubagentProgress): string => modelOf(progress) ?? progress.subagentType;

const clean = (text: string): string => stripTerminalSequences(text).replace(/[\r\n\t]/g, " ");
export const subagentStatus = (progress: SubagentProgress): DisplayStatus => progress.status === "completed" ? "done" : progress.status;
/**
 * Runner settlement first, then the host-validated workflow state in the same mark + word grammar; a state the two
 * render identically (cancelled) shows once. A dot joins them: `separator.meta` would sit against the unicode
 * cancelled mark as `- –`.
 */
const badge = (progress: SubagentProgress, tick: number): string => {
	const runner = statusText(subagentStatus(progress), { tick });
	if (!shownWorkflow(progress.workflow)) return runner;
	const workflow = workflowState(progress.workflow);
	return workflow === runner ? runner : `${runner}${color.gray(" · ")}${workflow}`;
};

/** Summary is separate from the live list: completed tasks never reappear as active rows. */
export function subagentCounts(subagents: readonly SubagentProgress[]) {
	const counts = { running: 0, completed: 0, failed: 0, cancelled: 0 };
	for (const progress of subagents) counts[progress.status]++;
	return counts;
}

export function subagentDetails(progress: SubagentProgress, width: number): string[] {
	const meta = `${clean(progress.subagentType)} · ${progress.background ? "background" : "foreground"} · ${progress.toolCount} tools${progress.tokens === undefined ? "" : ` · ${progress.tokens} output tokens`}`;
	const rows = [color.textPrimary(`Task: ${clean(progress.description)}`), color.textSecondary(meta)];
	if (shownWorkflow(progress.workflow)) rows.push(workflowText(progress.workflow));
	if (progress.status === "running") rows.push(color.textPrimary(activityLabel(progress)));
	if (progress.lastText) rows.push(color.textSecondary(`Latest: ${clean(progress.lastText)}`));
	if (progress.error) rows.push(color.accentError(`Error: ${clean(progress.error)}`));
	return rows.flatMap(row => wrapTextWithAnsi(row, Math.max(1, width)));
}

const rowCache = new WeakMap<SubagentBlock, Cached>();
export function renderSubagentRow(block: SubagentBlock, width: number, ctx: RenderContext): string[] {
	const progress = block.progress;
	const phase = progress.status === "running" ? `${spinnerFrame(brailleSpinner, ctx.tick)}:${formatElapsed(elapsedMs(progress, ctx.now))}` : "rest";
	const key = `${block.version}:${width}:${ctx.selected}:${ctx.expanded}:${phase}`;
	const cached = rowCache.get(block);
	if (cached?.key === key) return cached.lines;
	const indent = " ".repeat(spacing.bullet);
	const available = Math.max(1, width - spacing.rightPad);
	const prefix = `${indent}${badge(progress, ctx.tick)}  ${bold(color.textPrimary("Subagent"))} `;
	const duration = elapsedLabel(progress, ctx.now);
	const suffix = duration ? color.textSecondary(` · ${duration}`) : "";
	const title = truncateToWidth(clean(progress.description), Math.max(1, available - visibleWidth(prefix) - visibleWidth(suffix)), glyph.ellipsis);
	const lines = [truncateToWidth(`${prefix}${title}${suffix}`, available, "")];
	if (ctx.expanded) {
		lines.push(...subagentDetails(progress, Math.max(1, available - spacing.text)).map(line => `${" ".repeat(spacing.text)}${line}`));
		lines.push(truncateToWidth(`${" ".repeat(spacing.text)}${color.textSecondary(progress.conversationId > 0 ? "Enter: conversation & result · ←: collapse" : "Conversation starting...")}`, available, ""));
	} else if (ctx.selected) lines.push(truncateToWidth(`${indent}${color.textSecondary("→ details · Enter conversation")}`, available, ""));
	rowCache.set(block, { key, lines });
	return lines;
}

export const isGroupable = (block: Block): block is ToolBlock | SubagentBlock =>
	(block.kind === "tool" && block.name !== "codemode" && block.status !== "error" && block.status !== "cancelled" && verbFor(block.name).groupable);

const subagentVerb: ToolVerb = { past: "Ran", present: "Running", noun: "subagent", plural: "subagents", groupable: true, rail: false };
type Bucket = { key: string; verb: ToolVerb; count: number; running: number };
export type GroupLabel = { text: string; running: boolean; failed: number };

/** `Read 2 files, Searched 1 pattern` / `Running 2 subagents, 1 completed`: Grok's bucket walk (verb_group.rs), one bucket per verb in first-seen order, tool tense group-wide, subagent tense per bucket; `failed` members get the red ` · N failed` suffix at render time. */
export function groupLabel(members: readonly (ToolBlock | SubagentBlock)[]): GroupLabel {
	const buckets: Bucket[] = [];
	let failed = 0;
	for (const member of members) {
		const verb = member.kind === "subagent" ? subagentVerb : verbFor(member.name);
		const key = member.kind === "subagent" ? "subagent" : verb.past;
		let bucket = buckets.find((candidate) => candidate.key === key);
		if (bucket === undefined) {
			bucket = { key, verb, count: 0, running: 0 };
			buckets.push(bucket);
		}
		bucket.count++;
		if (member.kind === "subagent") {
			if (member.progress.status === "running") bucket.running++;
			else if (member.progress.status === "failed") failed++;
		} else if (member.status === "running" || member.status === "pending") bucket.running++;
		else if (member.status === "error") failed++;
	}
	const running = buckets.some((bucket) => bucket.running > 0);
	const text = buckets
		.map(({ key, verb, count, running: active }) => {
			const done = count - active;
			if (key === "subagent" && active > 0 && done > 0) return `${verb.present} ${active} ${active === 1 ? verb.noun : verb.plural}, ${done} completed`;
			const tense = (key === "subagent" ? active > 0 : running) ? verb.present : verb.past;
			return `${tense} ${count} ${count === 1 ? verb.noun : verb.plural}`;
		})
		.join(", ");
	return { text, running, failed };
}

const groupCache = new WeakMap<ToolBlock | SubagentBlock, Cached>();

/** Renders the `◈ Read 2 files, Searched 1 pattern` header: the diamond red when a member failed, pulsing while running, gray at rest. */
export function renderGroupHeader(members: readonly (ToolBlock | SubagentBlock)[], width: number, ctx: RenderContext): string[] {
	const first = members[0];
	if (first === undefined) return EMPTY;
	const parts = groupLabel(members);
	const caret = ctx.selected && !ctx.expanded;
	const phase = caret ? "caret" : parts.failed > 0 ? "failed" : parts.running ? (ctx.tick % 8 < 4 ? "on" : "off") : "idle";
	const key = `${width}:${phase}:${parts.failed}:${parts.text}`;
	const cached = groupCache.get(first);
	if (cached?.key === key) return cached.lines;
	const diamond = parts.failed > 0 ? color.accentError : parts.running ? blink(color.accentTool, ctx.tick) : color.gray;
	const bullet = caret ? color.grayBright(glyph.chevron) : diamond(glyph.groupBullet);
	const suffix = parts.failed > 0 ? color.accentError(`${separator.meta}${parts.failed} failed`) : "";
	const text = truncateToWidth(`${bold(color.grayBright(parts.text))}${suffix}`, Math.max(1, width - spacing.text - spacing.rightPad), glyph.ellipsis);
	const lines = [`${" ".repeat(spacing.bullet)}${bullet} ${text}`];
	groupCache.set(first, { key, lines });
	return lines;
}

let rosterCache: { width: number; lines: string[] } | undefined;

/** `History:` and as many whole counts as fit; counts that do not fit leave an ellipsis instead of a cut word. */
function historyLine(counts: readonly string[], width: number): string {
	const label = " History: ";
	const more = visibleWidth(glyph.ellipsis);
	let room = width - visibleWidth(label);
	let shown = "";
	for (const [index, count] of counts.entries()) {
		const piece = `${index > 0 ? " · " : ""}${count}`;
		if (visibleWidth(piece) > room - (index === counts.length - 1 ? 0 : more)) {
			if (room >= more) shown += color.textSecondary(glyph.ellipsis);
			break;
		}
		shown += piece;
		room -= visibleWidth(piece);
	}
	return `${color.textSecondary(label)}${shown}`;
}

/** At most four live tasks, followed by truthful history counts and an actionable command; `hiddenRows` (task ids) drops live rows only, never counts. */
export function renderRoster(subagents: readonly SubagentProgress[], width: number, tick: number, now: number, hiddenRows?: ReadonlySet<string>): string[] {
	if (subagents.length === 0) return EMPTY;
	const counts = subagentCounts(subagents);
	const ordered = subagents.filter(p => p.status === "running" && hiddenRows?.has(p.taskId) !== true).sort((a, b) => a.startedAt - b.startedAt);
	const hidden = Math.max(0, ordered.length - ROSTER_MAX_ROWS);
	const lines = [` ${bold(color.textPrimary("Subagents"))} · ${(counts.running ? color.accentRunning : color.textSecondary)(`${counts.running} running`)} · ${color.textSecondary("/agents")}`];
	for (const progress of ordered.slice(0, ROSTER_MAX_ROWS)) {
		lines.push(` ${badge(progress, tick)}  ${color.textPrimary(clean(progress.description))} · ${color.textSecondary(dockElapsed(elapsedMs(progress, now)))}`);
		lines.push(`   ${color.textSecondary(activityLabel(progress))}`);
	}
	if (hidden) lines.push(` ${color.textSecondary(`+${hidden} running · /agents to view all`)}`);
	const history = (["completed", "failed", "cancelled"] as const).filter(status => counts[status] > 0).map(status => {
		const state = status === "completed" ? "done" : status;
		return statusStyle(state)(`${counts[status]} ${state}`);
	});
	// Workflow outcomes of settled tasks follow the runner counts; a running task shows its own in its row. The open
	// count is neutral like `not verified` in the status row (coral stays with failed and blocked) and comes first, so
	// a clipped line never shows success while hiding what is not verified.
	const workflows = subagents.filter(progress => progress.status !== "running").map(progress => progress.workflow).filter(shownWorkflow);
	const verified = workflows.filter(workflow => workflow.status === "verified");
	if (workflows.length > verified.length) history.push(color.textSecondary(`${workflows.length - verified.length} not verified`));
	if (verified[0]) history.push(workflowStyle(verified[0])(`${verified.length} verified`));
	lines.push(history.length ? historyLine(history, width) : ` ${color.textSecondary("/agents: details & history")}`);
	const clipped = lines.map(line => truncateToWidth(line, Math.max(1, width), ""));
	if (rosterCache?.width === width && rosterCache.lines.length === clipped.length && rosterCache.lines.every((line, index) => line === clipped[index])) return rosterCache.lines;
	rosterCache = { width, lines: clipped };
	return clipped;
}

class CachedLines implements Component {
	private cache: { width: number; key: string; lines: string[] } | undefined;

	constructor(
		private readonly lines: (width: number) => string[],
		private readonly key: () => string = () => "",
	) {}

	render(width: number): string[] {
		const key = this.key();
		if (this.cache?.width === width && this.cache.key === key) return this.cache.lines;
		const lines = this.lines(width).map((line) => paint(line, width));
		this.cache = { width, key, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

/** One frame rail (`  │` or `│  `) repeated down the body; the layout clips it to the body height. */
const rail = (text: string): Component => new CachedLines(() => Array.from({ length: RAIL_ROWS }, () => text));

const inset = " ".repeat(spacing.frameInset);
const border = color.selectionBorder;
const innerWidth = (width: number): number => Math.max(0, width - spacing.frameInset * 2 - 2);
const frameRow = (inner: number, text: string): string => `${inset}${border(square.v)}${truncateToWidth(text, inner, "", true)}${border(square.v)}${inset}`;

/** `┌─┐`, then `│ ✓ Subagent <desc> <model>   <activity> · <elapsed> [✗] │`, then `├─┤` (app/agent_view/subagent_takeover.rs). */
export function takeoverTitle(progress: SubagentProgress | undefined, width: number, clock: Clock): string[] {
	const inner = innerWidth(width);
	let left = "";
	let right = "";
	if (progress !== undefined) {
				const status = statusStyle(subagentStatus(progress));
		const state = badge(progress, clock.tick);
		right = `${color.gray(elapsedLabel(progress, clock.now))} ${color.gray(glyph.closeButton)} `;
		const meta = "";
		const descWidth = inner - 3 - visibleWidth(state) - LABEL_WIDTH - visibleWidth(meta) - visibleWidth(right);
		left = ` ${state} ${status(`${LABEL} `)}${bold(color.textPrimary(truncateToWidth(clean(progress.description), Math.max(0, descWidth), glyph.ellipsis)))}${color.gray(meta)}`;
	}
	const leftWidth = Math.max(0, inner - visibleWidth(right));
	const clipped = truncateToWidth(left, leftWidth, "");
	const title = `${clipped}${" ".repeat(Math.max(0, leftWidth - visibleWidth(clipped)))}${right}`;
	return [`${inset}${border(`${square.tl}${square.h.repeat(inner)}${square.tr}`)}${inset}`, frameRow(inner, title), `${inset}${border(`${square.sepL}${square.h.repeat(inner)}${square.sepR}`)}${inset}`];
}

export function takeoverFooter(footer: string, width: number): string[] {
	const inner = innerWidth(width);
	return [frameRow(inner, ""), frameRow(inner, `${" ".repeat(spacing.margin)}${footer}`), frameRow(inner, ""), `${inset}${border(`${square.bl}${square.h.repeat(inner)}${square.br}`)}${inset}`];
}

export type TakeoverParts = {
	progress: () => SubagentProgress | undefined;
	header: Component;
	transcript: Component;
	footer: () => string;
	tick: () => number;
	now: () => number;
};

/** Builds the framed subagent takeover: title bar, `├─┤`, the child's header + transcript between the rails, footer, `└─┘`. */
export function createTakeoverView(parts: TakeoverParts): { root: Component; scroll: ScrollView; headerRows: () => number } {
	let headerRows = 3;
	const body = new Container();
	body.addChild(parts.header);
	body.addChild(new CachedLines(width => {
		const progress = parts.progress();
		const lines = progress ? [...subagentDetails(progress, Math.max(1, width - spacing.margin * 2)).map(line => `${" ".repeat(spacing.margin)}${line}`), ""] : [];
		headerRows = parts.header.render(width).length + lines.length;
		return lines;
	}, () => JSON.stringify(parts.progress())));
	body.addChild(parts.transcript);
	const scroll = new ReflowScrollView(body, { follow: "end", scrollbar: "auto" });
	const railWidth = spacing.frameInset + 1;
	const middle = new HStack(
		[
			{ component: rail(`${inset}${border(square.v)}`), basis: railWidth, shrink: 0 },
			{ component: scroll, grow: 1, shrink: 1, basis: 0 },
			{ component: rail(`${border(square.v)}${inset}`), basis: railWidth, shrink: 0 },
		],
		{ align: "stretch" },
	);
	const titleKey = (): string => {
		const progress = parts.progress();
		if (progress === undefined) return "none";
		const frame = progress.status === "running" ? spinnerFrame(brailleSpinner, parts.tick()) : "";
		return `${progress.status}:${JSON.stringify(progress.workflow)}:${frame}:${formatElapsed(elapsedMs(progress, parts.now()))}:${activityLabel(progress)}:${progress.description}:${clean(metaColumn(progress))}`;
	};
	const root = new VStack([
		{ component: new CachedLines(() => [""]), shrink: 0 },
		{ component: new CachedLines((width) => takeoverTitle(parts.progress(), width, { tick: parts.tick(), now: parts.now() }), titleKey), shrink: 0 },
		{ component: middle, grow: 1, shrink: 1, basis: 0 },
		{ component: new CachedLines((width) => takeoverFooter(parts.footer(), width), parts.footer), shrink: 0 },
		{ component: new CachedLines(() => [""]), shrink: 0 },
	]);
	return { root, scroll, headerRows: () => headerRows };
}
