import { type Component, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { DagNodeView, DagView, ResearchView, SubagentProgress } from "../../core/ui-contract.ts";
import { activityLabel } from "../blocks/subagents.ts";
import { researchReportState, researchText } from "../slash.ts";
import type { AskView } from "../state.ts";
import { bold, brailleSpinner, color, formatElapsed, glyph, type IconStatus, icons, paint, separator, spacing, spinnerFrame, type Style } from "../theme.ts";

/**
 * The always-on DAG pane (ADR 0032; .omo/plans/dag-tui-rendering.md 2.2-2.6 as amended by 2.9). Everything here is
 * a pure function of the client `DagView` projection and a live clock. Node rows follow the tool row grammar (state
 * first, then the purpose icon, the name, the title, the parents it consumes and right-aligned meta), the wave spine
 * is a level guide that always points down (longest-path layering, A1), and folding (A5) keeps the body inside its
 * row budget while every node lands in exactly one item.
 */

/** Live inputs the view does not carry: bound subagents (activity, settlement), open asks (questions) and the screen clock. */
export type DagLive = { subagents: ReadonlyMap<string, SubagentProgress>; asks: ReadonlyMap<string, AskView>; tick: number; now: number };
type LiveChildren = Pick<DagLive, "subagents">;

export type DagDisplayState = "running" | "settling" | "waiting" | "ready" | "retry" | "pending" | "done" | "failed" | "skipped" | "lastseen";

const childOf = (node: DagNodeView, live: LiveChildren | undefined): SubagentProgress | undefined =>
	node.handle === undefined ? undefined : live?.subagents.get(node.handle);

/**
 * The A3 state mapping. A running or waiting node of a run that is no longer running is `lastseen`: run termination
 * never claims child termination, so the row keeps the recorded word, freezes and stops spinning. Inside a running
 * run the same node is `settling` once its bound subagent has settled (the executor has not reconciled it yet). A
 * pending node that already failed an attempt is `retry` even when it sits in the frontier again.
 */
export function displayState(view: DagView, node: DagNodeView, live?: LiveChildren): DagDisplayState {
	switch (node.state) {
		case "running":
		case "waiting": {
			if (view.status !== "running") return "lastseen";
			const child = childOf(node, live);
			return child !== undefined && child.status !== "running" ? "settling" : node.state;
		}
		case "pending":
		case "ready":
			return node.attempt > 0 && node.error !== undefined && node.error !== "" ? "retry" : node.state;
		case "succeeded":
			return "done";
		case "failed":
		case "skipped":
			return node.state;
	}
}

const WORD_COLUMNS = 8;
const WORDS: Record<DagDisplayState, string> = {
	running: "running", settling: "settling", waiting: "waiting", ready: "ready", retry: "retry", pending: "pending",
	done: "done", failed: "failed", skipped: "skipped", lastseen: "last seen",
};
const MARKS: Record<Exclude<DagDisplayState, "running">, IconStatus> = {
	settling: "pending", waiting: "pending", ready: "pending", retry: "pending", pending: "pending",
	done: "done", failed: "failed", skipped: "cancelled", lastseen: "unknown",
};
/** Amber runs, green succeeded, coral failed, yellow for every state that needs a decision, a rerun or a second look (ADR 0015). */
const STYLES: Record<DagDisplayState, Style> = {
	running: color.accentRunning, settling: color.textSecondary, waiting: color.warning, ready: color.textPrimary, retry: color.warning,
	pending: color.gray, done: color.accentSuccess, failed: color.accentError, skipped: color.warning, lastseen: color.warning,
};
const stateMark = (state: DagDisplayState, tick: number): string => (state === "running" ? spinnerFrame(brailleSpinner, tick) : icons().status[MARKS[state]]);
/** A `lastseen` row keeps the recorded word (running/waiting); the meta says it is stale. */
const rowWord = (state: DagDisplayState, node: DagNodeView): string => (state === "lastseen" ? node.state : WORDS[state]);
/** Icons encode node purpose: act/delegate/expand are subagent work, verify is a checklist, ask is a conversation turn. */
const kindIcon = (kind: DagNodeView["kind"]): string => {
	const set = icons().tools;
	return kind === "verify" ? set.todo : kind === "ask" ? set.session : set.subagent;
};

const MIN_BODY_ROWS = 3;
const MAX_BODY_ROWS = 10;
const BODY_FRACTION = 0.2;

export function dagBudget(terminalRows: number): number {
	return Math.max(MIN_BODY_ROWS, Math.min(MAX_BODY_ROWS, Math.floor(BODY_FRACTION * terminalRows)));
}

export type FoldItem =
	| { kind: "node"; node: DagNodeView }
	| { kind: "wave"; level: number; nodes: DagNodeView[] }
	| { kind: "more"; level: number; nodes: DagNodeView[] }
	| { kind: "group"; from: number; to: number; nodes: DagNodeView[] }
	| { kind: "rest"; nodes: DagNodeView[] };

/** States that make a wave active: something runs, settles, waits, failed, will rerun, is dispatchable, or was last seen in flight. */
const ACTIVE: ReadonlySet<DagDisplayState> = new Set<DagDisplayState>(["running", "settling", "waiting", "failed", "retry", "ready", "lastseen"]);
/** Which nodes of a partially expanded wave get their own row (A5); ties keep display order. */
const PRIORITY: Record<DagDisplayState, number> = { running: 0, settling: 1, waiting: 2, failed: 3, retry: 4, ready: 5, lastseen: 6, pending: 7, skipped: 8, done: 9 };

type Wave = { level: number; nodes: DagNodeView[]; active: boolean; done: boolean };
type WorkItem = { kind: "wave"; wave: Wave } | { kind: "group"; from: number; to: number; nodes: DagNodeView[] };

function wavesOf(view: DagView, live: LiveChildren | undefined): Wave[] {
	const byLevel = new Map<number, DagNodeView[]>();
	for (const node of view.nodes) {
		const list = byLevel.get(node.level);
		if (list) list.push(node);
		else byLevel.set(node.level, [node]);
	}
	return [...byLevel.entries()]
		.sort(([a], [b]) => a - b)
		.map(([level, nodes]) => {
			const states = nodes.map((node) => displayState(view, node, live));
			return { level, nodes, active: states.some((state) => ACTIVE.has(state)), done: states.every((state) => state === "done") };
		});
}

/**
 * Total folding (A5). N <= budget shows every node. Otherwise waves start collapsed; while there are too many rows
 * and two adjacent items are both non-active, the pair farthest from the anchor (the first active level, else 0;
 * distance = min |level - anchor| over the levels the pair covers, ties toward higher levels) merges into a group.
 * Still too many: the first budget-1 items stay and ONE remainder owns the whole suffix, with no expansion. Else
 * singleton waves expand in priority order (active ascending, future ascending, done descending), recomputing the
 * spare rows each time: fully when n-1 fits, otherwise only an active wave shows its k = spare most urgent nodes in
 * display order above a summary owning the rest; zero spare leaves it collapsed. `live` tells settling from
 * running, which the priority order distinguishes.
 */
export function foldRows(view: DagView, budget: number, live?: LiveChildren): FoldItem[] {
	const limit = Math.max(1, Math.floor(budget));
	if (view.nodes.length <= limit) return view.nodes.map((node) => ({ kind: "node", node }));
	const waves = wavesOf(view, live);
	const anchor = waves.find((wave) => wave.active)?.level ?? 0;
	const lo = (item: WorkItem): number => (item.kind === "wave" ? item.wave.level : item.from);
	const hi = (item: WorkItem): number => (item.kind === "wave" ? item.wave.level : item.to);
	const nodesOf = (item: WorkItem): DagNodeView[] => (item.kind === "wave" ? item.wave.nodes : item.nodes);
	const isActive = (item: WorkItem): boolean => item.kind === "wave" && item.wave.active;
	const items: WorkItem[] = waves.map((wave) => ({ kind: "wave", wave }));
	while (items.length > limit) {
		let best = -1;
		let bestDistance = -1;
		let bestLevel = -1;
		for (let index = 0; index + 1 < items.length; index++) {
			const a = items[index]!;
			const b = items[index + 1]!;
			if (isActive(a) || isActive(b)) continue;
			const from = lo(a);
			const to = hi(b);
			const distance = from > anchor ? from - anchor : to < anchor ? anchor - to : 0;
			if (distance > bestDistance || (distance === bestDistance && from > bestLevel)) {
				best = index;
				bestDistance = distance;
				bestLevel = from;
			}
		}
		if (best < 0) break;
		const a = items[best]!;
		const b = items[best + 1]!;
		items.splice(best, 2, { kind: "group", from: lo(a), to: hi(b), nodes: [...nodesOf(a), ...nodesOf(b)] });
	}
	const collapsed = (item: WorkItem): FoldItem =>
		item.kind === "wave" ? { kind: "wave", level: item.wave.level, nodes: item.wave.nodes } : { kind: "group", from: item.from, to: item.to, nodes: item.nodes };
	if (items.length > limit) {
		return [...items.slice(0, limit - 1).map(collapsed), { kind: "rest", nodes: items.slice(limit - 1).flatMap(nodesOf) }];
	}
	let spare = limit - items.length;
	const candidates = items.flatMap((item) => (item.kind === "wave" ? [item.wave] : []));
	const order = [
		...candidates.filter((wave) => wave.active),
		...candidates.filter((wave) => !wave.active && !wave.done),
		...candidates.filter((wave) => wave.done).reverse(),
	];
	const expansion = new Map<number, "all" | ReadonlySet<string>>();
	for (const wave of order) {
		const extra = wave.nodes.length - 1;
		if (extra <= spare) {
			expansion.set(wave.level, "all");
			spare -= extra;
		} else if (wave.active && spare > 0) {
			const picked = wave.nodes
				.map((node, index) => ({ node, index, priority: PRIORITY[displayState(view, node, live)] }))
				.sort((a, b) => a.priority - b.priority || a.index - b.index)
				.slice(0, spare);
			expansion.set(wave.level, new Set(picked.map((entry) => entry.node.id)));
			spare = 0;
		}
	}
	const out: FoldItem[] = [];
	for (const item of items) {
		const shown = item.kind === "wave" ? expansion.get(item.wave.level) : undefined;
		if (item.kind !== "wave" || shown === undefined) out.push(collapsed(item));
		else if (shown === "all") for (const node of item.wave.nodes) out.push({ kind: "node", node });
		else {
			for (const node of item.wave.nodes) if (shown.has(node.id)) out.push({ kind: "node", node });
			out.push({ kind: "more", level: item.wave.level, nodes: item.wave.nodes.filter((node) => !shown.has(node.id)) });
		}
	}
	return out;
}

const GAP = "  ";
/** A right-aligned meta cut below this many columns says nothing; it is dropped instead. */
const META_MIN_COLUMNS = 12;
/** Like the workflow blocker: the first 160 columns of the run reason. */
const REASON_COLUMNS = 160;
const LABEL = "DAG";
const HINT = "/dag";
const UNCOMPILED = "plan does not compile";
const EMPTY: string[] = [];

type Segment = readonly [text: string, style: Style];
const plain: Style = (text) => text;
const columns = (segments: readonly Segment[]): number => segments.reduce((sum, [text]) => sum + visibleWidth(text), 0);
const clean = (text: string): string => stripTerminalSequences(text).replace(/\s+/g, " ").trim();

/** Cuts plain text to `width` columns with the ellipsis; callers style the result, so no reset escapes into a row. */
const fit = (text: string, width: number): string => {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const reserve = visibleWidth(glyph.ellipsis);
	if (width <= reserve) return sliceByColumn(text, 0, width, true);
	return `${sliceByColumn(text, 0, width - reserve, true)}${glyph.ellipsis}`;
};

function fitSegments(segments: readonly Segment[], width: number): string {
	const target = fit(segments.map(([text]) => text).join(""), width);
	const end = visibleWidth(target);
	let out = "";
	let used = 0;
	for (const [text, style] of segments) {
		if (used >= end) break;
		const take = Math.min(visibleWidth(text), end - used);
		const piece = sliceByColumn(target, used, take, true);
		if (piece !== "") out += style(piece);
		used += take;
	}
	return out;
}

class Row {
	text = "";
	used = 0;
	/** Columns kept back for a suffix that must survive (the blocker count); `release` returns them. */
	private held = 0;
	constructor(private readonly limit: number) {}
	get room(): number {
		return this.limit - this.used - this.held;
	}
	hold(columns: number): void {
		this.held = Math.max(0, Math.min(columns, this.limit - this.used));
	}
	release(): void {
		this.held = 0;
	}
	fits(text: string): boolean {
		return visibleWidth(text) <= this.room;
	}
	add(text: string, style: Style = plain): this {
		if (text !== "") {
			this.text += style(text);
			this.used += visibleWidth(text);
		}
		return this;
	}
	/** A gap then `text` in full, or `text` cut to what is left; false when it was cut or skipped. */
	place(text: string, style: Style): boolean {
		if (this.fits(`${GAP}${text}`)) {
			this.add(GAP).add(text, style);
			return true;
		}
		const room = this.room - GAP.length;
		if (room > visibleWidth(glyph.ellipsis)) this.add(GAP).add(fit(text, room), style);
		return false;
	}
	alignRight(text: string, style: Style): void {
		const room = this.room - GAP.length;
		if (room < visibleWidth(text) && room < META_MIN_COLUMNS) return;
		const shown = fit(text, room);
		this.add(" ".repeat(this.room - visibleWidth(shown))).add(shown, style);
	}
}

/** `a, b, c`, or `a, b +3` when the whole list does not fit (the count survives); empty when not even one name fits. */
function idList(ids: readonly string[], room: number): string {
	const full = ids.join(", ");
	if (visibleWidth(full) <= room) return full;
	for (let keep = ids.length - 1; keep >= 1; keep--) {
		const text = `${ids.slice(0, keep).join(", ")} +${ids.length - keep}`;
		if (visibleWidth(text) <= room) return text;
	}
	return "";
}

const ARROW = "<-";
const BLOCKED = "blocked by";

/**
 * 2.2: `<- a, b` names the reduced parents in display order; `<- wave N` when they are exactly the previous wave and
 * that wave has at least two nodes (a barrier). `complete` is false when names were folded into `+k`.
 */
function depsText(view: DagView, node: DagNodeView, room: number): { text: string; complete: boolean } {
	const previous = view.nodes.filter((other) => other.level === node.level - 1).map((other) => other.id);
	const barrier = previous.length >= 2 && node.parents.length === previous.length && previous.every((id) => node.parents.includes(id));
	if (barrier) {
		const text = `${ARROW} wave ${node.level}`;
		return visibleWidth(text) <= room ? { text, complete: true } : { text: "", complete: false };
	}
	const list = idList(node.parents, room - ARROW.length - 1);
	return list === "" ? { text: "", complete: false } : { text: `${ARROW} ${list}`, complete: list === node.parents.join(", ") };
}

/** A2: direct parents the reduction hides that have not succeeded while this node is not done (a replan can revert a parent). */
function blockers(view: DagView, node: DagNodeView): string[] {
	if (node.state === "succeeded") return [];
	const states = new Map(view.nodes.map((other) => [other.id, other.state]));
	return node.directParents.filter((id) => !node.parents.includes(id) && states.get(id) !== "succeeded");
}

const ORCHESTRATOR = "orchestrator";

function metaText(view: DagView, node: DagNodeView, state: DagDisplayState, live: DagLive): string {
	const child = childOf(node, live);
	switch (state) {
		case "running": {
			const activity = child ? activityLabel(child) : "";
			const elapsed = node.startedAt === undefined ? "" : formatElapsed(live.now - node.startedAt);
			return [activity, elapsed].filter((part) => part !== "").join(separator.meta);
		}
		case "settling":
			return `child ${child?.status ?? "settled"}${separator.meta}awaiting dag_step`;
		case "waiting": {
			const ask = [...live.asks.values()].find((candidate) => candidate.state === "open" && candidate.from === node.handle);
			if (ask) return `asks ${glyph.quoteOpen}${clean(ask.question)}${glyph.quoteClose}`;
			return node.handle === ORCHESTRATOR ? "answer with ask/answer" : "waiting for an answer";
		}
		case "lastseen": {
			const elapsed = node.startedAt === undefined ? "" : formatElapsed(view.updatedAt - node.startedAt);
			return ["last seen", child ? `child ${child.status}` : "", elapsed].filter((part) => part !== "").join(separator.meta);
		}
		case "retry":
			return `attempt ${node.attempt}/${node.maxAttempts} failed: ${clean(node.error ?? "")}`;
		case "failed":
			return clean(node.error ?? "");
		case "done":
			return node.startedAt !== undefined && node.endedAt !== undefined ? formatElapsed(node.endedAt - node.startedAt) : "";
		default:
			return "";
	}
}

/** Node ids share one column up to this width, so titles line up; a longer id pushes only its own row. */
const ID_COLUMNS = 16;

/** `spine  mark word  icon  id  title  <- deps  blocked by  ...meta`; when narrow: meta goes first, then deps, then the title is cut, then the id. */
function nodeLine(view: DagView, node: DagNodeView, spine: readonly Segment[], inner: number, live: DagLive, idColumns: number): string {
	const state = displayState(view, node, live);
	const mark = stateMark(state, live.tick);
	const word = rowWord(state, node);
	const head: Segment[] = [...spine, [GAP, plain], [`${mark} ${word.padEnd(WORD_COLUMNS)}`, STYLES[state]]];
	if (columns(head) > inner) {
		const bare: Segment[] = [...spine, [GAP, plain], [`${mark} ${word}`, STYLES[state]]];
		return columns(bare) <= inner ? bare.map(([text, style]) => style(text)).join("") : fitSegments(bare, inner);
	}
	const row = new Row(inner);
	for (const [text, style] of head) row.add(text, style);
	// An unfinished direct parent hidden by the reduction outranks the name, title and deps (A2): its count is held back first.
	const blocked = blockers(view, node);
	const blockedCount = `${BLOCKED} +${blocked.length}`;
	if (blocked.length > 0) row.hold(GAP.length + visibleWidth(blockedCount));
	const body = (): boolean => {
		const icon = kindIcon(node.kind);
		if (!row.fits(`${GAP}${icon}`)) return false;
		row.add(GAP).add(icon, color.accentTool);
		const faded = state === "done" || state === "skipped";
		const name: Style = state === "running" ? (text) => bold(color.textPrimary(text)) : faded ? color.grayBright : color.textPrimary;
		if (!row.place(node.id, name)) return false;
		const padding = " ".repeat(Math.max(0, idColumns - visibleWidth(node.id)));
		if (padding !== "" && row.fits(`${padding}${GAP}`)) row.add(padding);
		if (node.title !== "" && !row.place(node.title, faded ? color.grayBright : color.textSecondary)) return false;
		if (node.parents.length > 0) {
			const deps = depsText(view, node, row.room - GAP.length);
			if (deps.text === "") return false;
			row.add(GAP).add(deps.text, color.gray);
			if (!deps.complete) return false;
		}
		return true;
	};
	const complete = body();
	row.release();
	if (blocked.length > 0) {
		const list = idList(blocked, row.room - GAP.length - BLOCKED.length - 1);
		const text = list === "" ? blockedCount : `${BLOCKED} ${list}`;
		if (row.fits(`${GAP}${text}`)) row.add(GAP).add(text, color.warning);
		if (!complete || list !== blocked.join(", ")) return row.text;
	} else if (!complete) return row.text;
	const meta = metaText(view, node, state, live);
	if (meta !== "") row.alignRight(meta, color.gray);
	return row.text;
}

/** Reading order of folded counts: what moves or needs a hand first, then outcomes, then what has not started. */
const COUNT_ORDER: readonly DagDisplayState[] = ["running", "settling", "waiting", "failed", "retry", "ready", "lastseen", "done", "pending", "skipped"];

type CountPart = { text: string; style: Style; count: number };

function countParts(view: DagView, nodes: readonly DagNodeView[], live: DagLive): CountPart[] {
	const counts = new Map<DagDisplayState, number>();
	for (const node of nodes) {
		const state = displayState(view, node, live);
		counts.set(state, (counts.get(state) ?? 0) + 1);
	}
	return COUNT_ORDER.flatMap((state): CountPart[] => {
		const count = counts.get(state);
		return count === undefined ? [] : [{ text: `${stateMark(state, live.tick)} ${count} ${WORDS[state]}`, style: STYLES[state], count }];
	});
}

function summaryLine(view: DagView, spine: readonly Segment[], label: string | undefined, nodes: readonly DagNodeView[], names: boolean, inner: number, live: DagLive): string {
	const lead: Segment[] = [...spine, [GAP, plain]];
	if (label !== undefined) lead.push([label, color.grayBright]);
	if (columns(lead) > inner) return fitSegments(lead, inner);
	const row = new Row(inner);
	for (const [text, style] of lead) row.add(text, style);
	let first = label === undefined;
	// Counts that do not fit fold into one `+N more`, kept back before each count, so the row still accounts for every node.
	let remaining = nodes.length;
	for (const part of countParts(view, nodes, live)) {
		const joint = first ? "" : separator.meta;
		const after = remaining - part.count;
		if (!row.fits(`${joint}${part.text}${after > 0 ? ` +${after} more` : ""}`)) break;
		row.add(joint, color.gray).add(part.text, part.style);
		first = false;
		remaining = after;
	}
	if (remaining > 0) {
		const rest = `${first ? "" : " "}+${remaining} more`;
		if (row.fits(rest)) row.add(rest, color.gray);
		return row.text;
	}
	if (names) {
		const list = idList(nodes.map((node) => node.id), row.room - GAP.length);
		if (list !== "") row.add(GAP).add(list, color.gray);
	}
	return row.text;
}

function itemLine(view: DagView, item: FoldItem, spine: readonly Segment[], inner: number, live: DagLive, idColumns: number): string {
	switch (item.kind) {
		case "node":
			return nodeLine(view, item.node, spine, inner, live, idColumns);
		case "wave":
			return summaryLine(view, spine, undefined, item.nodes, true, inner, live);
		case "more":
			return summaryLine(view, spine, `${glyph.enlarge} ${item.nodes.length} more`, item.nodes, false, inner, live);
		case "group":
			return summaryLine(view, spine, `waves ${item.from + 1}-${item.to + 1}`, item.nodes, false, inner, live);
		case "rest":
			return summaryLine(view, spine, `${item.nodes.length} more nodes`, item.nodes, false, inner, live);
	}
}

/** 2.4: the spine number reads as progress: green all done, amber anything in flight (running or settling), coral any failed, yellow a decision, rerun or stale sighting, gray ahead. */
function waveStyle(view: DagView, nodes: readonly DagNodeView[], live: DagLive): Style {
	const states = nodes.map((node) => displayState(view, node, live));
	if (states.every((state) => state === "done")) return color.accentSuccess;
	if (states.some((state) => state === "running" || state === "settling")) return color.accentRunning;
	if (states.includes("failed")) return color.accentError;
	if (states.some((state) => state === "waiting" || state === "retry" || state === "lastseen")) return color.warning;
	return color.gray;
}

const spineSegments = (number: string, mark: string, digits: number, style: Style): Segment[] => [[number.padStart(digits), style], [" ", plain], [mark, color.grayDim]];

const levelCount = (view: DagView): number => Math.max(view.levels, ...view.nodes.map((node) => node.level + 1));

const uncompiled = (view: DagView): boolean => view.nodes.length === 0 && (view.diagnostics?.length ?? 0) > 0;

/** Run status in the workflow grammar of panes/plan.ts: static amber while it moves, green only for verified, coral blocked, yellow cancelled. */
const RUN_ROLES: Record<DagView["status"], { readonly mark: IconStatus; readonly style: Style }> = {
	compiling: { mark: "pending", style: color.accentRunning },
	running: { mark: "pending", style: color.accentRunning },
	verified: { mark: "done", style: color.accentSuccess },
	blocked: { mark: "failed", style: color.accentError },
	cancelled: { mark: "cancelled", style: color.warning },
};

/** `wave K/h` (first wave with an unfinished node; absent once all succeeded), `D/N done`, `reqs C/R`, `rev X` after a replan, then the reason of a blocked or cancelled run. */
function titleMeta(view: DagView): string[] {
	const parts: string[] = [];
	const open = view.nodes.filter((node) => node.state !== "succeeded");
	if (open.length > 0) parts.push(`wave ${1 + Math.min(...open.map((node) => node.level))}/${levelCount(view)}`);
	parts.push(`${view.nodes.length - open.length}/${view.nodes.length} done`);
	if (view.requirements.length > 0) parts.push(`reqs ${view.requirements.filter((requirement) => requirement.certified).length}/${view.requirements.length}`);
	if (view.revision > 0) parts.push(`rev ${view.revision}`);
	if ((view.status === "blocked" || view.status === "cancelled") && view.reason !== undefined) {
		const reason = clean(view.reason);
		if (reason !== "") parts.push(fit(reason, REASON_COLUMNS));
	}
	return parts;
}

/**
 * 2.4 title row: `DAG  mark status - meta - meta` with a right-aligned `/dag` hint when it fits; an uncompiled run
 * reads `! blocked - plan does not compile`. Plain text is cut before it is styled; the state survives longest, the
 * first meta that does not fit is cut and the rest dropped.
 */
export function dagTitle(view: DagView, width: number): string {
	const margin = " ".repeat(spacing.margin);
	const inner = Math.max(0, width - spacing.margin * 2);
	const broken = uncompiled(view);
	const role = broken ? RUN_ROLES.blocked : RUN_ROLES[view.status];
	const head: Segment[] = [[`${LABEL}${GAP}`, color.grayBright], [`${icons().status[role.mark]} ${broken ? "blocked" : view.status}`, role.style]];
	if (columns(head) > inner) return `${margin}${fitSegments(head, inner)}`;
	const row = new Row(inner);
	for (const [text, style] of head) row.add(text, style);
	const ellipsis = visibleWidth(glyph.ellipsis);
	for (const part of broken ? [UNCOMPILED] : titleMeta(view)) {
		const piece = `${separator.meta}${part}`;
		if (row.fits(piece)) {
			row.add(piece, color.gray);
			continue;
		}
		if (row.room > separator.meta.length + ellipsis) row.add(fit(piece, row.room), color.gray);
		else if (row.room >= ellipsis) row.add(glyph.ellipsis, color.gray);
		break;
	}
	if (row.room >= GAP.length + HINT.length) row.add(" ".repeat(row.room - HINT.length)).add(HINT, color.gray);
	return `${margin}${row.text}`;
}

function diagnosticLines(view: DagView, rows: number, inner: number): string[] {
	const texts = (view.diagnostics ?? []).map(clean).filter((text) => text !== "");
	const limit = Math.max(1, Math.floor(rows));
	if (texts.length <= limit) return texts.map((text) => color.gray(fit(text, inner)));
	const shown = texts.slice(0, limit - 1).map((text) => color.gray(fit(text, inner)));
	return [...shown, color.grayBright(fit(`${glyph.enlarge} ${texts.length - shown.length} more`, inner))];
}

/** Incumbent is selected by the research comparator, not guessed from numeric magnitude by the UI. */
export function researchSummary(mission: ResearchView, now: number): string[] {
	const best = mission.candidates.find((candidate) => candidate.id === mission.incumbentId);
	const comparable = best !== undefined && best.validity === "valid" && (best.value === undefined || Number.isFinite(best.value));
	const remaining = Number.isFinite(mission.deadlineAt) ? formatElapsed(Math.max(0, mission.deadlineAt - now)) : "unknown";
	const invalid = mission.candidates.filter((candidate) => candidate.validity === "invalid").length;
	const unknown = mission.candidates.filter((candidate) => candidate.validity === undefined || candidate.validity === "unknown").length;
	const inconclusive = mission.candidates.filter((candidate) => candidate.verdict === undefined || candidate.verdict === "inconclusive").length;
	return [
		`Research ${mission.status} · outcome ${mission.judgment ?? "unknown"} · ${mission.question}${mission.stopReason ? ` · ${mission.stopReason}` : ""}`,
		`Attempts ${mission.attempts.used}/${mission.attempts.limit} · rounds ${mission.rounds.used}/${mission.rounds.limit} · left ${remaining} · active ${mission.activeAttempts}/${mission.maxConcurrent}`,
		`Best ${comparable ? `${best.id}: ${best.value === undefined ? best.verdict ?? "inconclusive" : `${best.value} ${best.unit ?? ""}`}` : "unknown (no comparable result)"} · invalid ${invalid} · unknown ${unknown} · inconclusive ${inconclusive}`,
		`Candidates ${mission.candidateBudget.used}/${mission.candidateBudget.limit} · reserved ${mission.confirmationReserved} · report ${researchReportState(mission)}`,
	].map(researchText);
}

export function dagLines(view: DagView, width: number, rows: number, live: DagLive): string[] {
	const margin = " ".repeat(spacing.margin);
	const inner = Math.max(0, width - spacing.margin * 2);
	const lines = [dagTitle(view, width)];
	// Fixed summary slots preserve execution row order; reserve at least one row for the DAG.
	const summary = view.research === undefined ? [] : researchSummary(view.research, live.now).slice(0, Math.max(0, rows - 1));
	for (const line of summary) lines.push(`${margin}${color.textSecondary(fit(line, inner))}`);
	const executionRows = Math.max(1, rows - summary.length);
	if (uncompiled(view)) {
		for (const line of diagnosticLines(view, executionRows, inner)) lines.push(`${margin}${line}`);
	} else if (view.nodes.length > 0) {
		const digits = String(levelCount(view)).length;
		const idColumns = Math.min(ID_COLUMNS, Math.max(...view.nodes.map((node) => visibleWidth(node.id))));
		const tones = new Map(wavesOf(view, live).map((wave) => [wave.level, waveStyle(view, wave.nodes, live)]));
		let previous: number | undefined;
		for (const item of foldRows(view, executionRows, live)) {
			const level = item.kind === "node" ? item.node.level : item.kind === "wave" || item.kind === "more" ? item.level : undefined;
			const first = level !== undefined && level !== previous;
			const mark = item.kind === "rest" ? glyph.cutBelow : first || item.kind === "group" ? glyph.groupBullet : glyph.accentBar;
			const spine = spineSegments(first ? String(level + 1) : "", mark, digits, (level === undefined ? undefined : tones.get(level)) ?? color.gray);
			lines.push(`${margin}${itemLine(view, item, spine, inner, live, idColumns)}`);
			previous = level;
		}
	}
	return lines.map((line) => paint(line, width));
}

/**
 * The pane on the prompt box, above the TODO/Plan caption (composer work deck): visible whenever the conversation has
 * a DAG run, never focused, never scrolled; the screen caps it to its title row once every node succeeded.
 * Lines are cached per (view version, width, budget); per tick and second only while a node runs in a running run
 * (spinner, elapsed); per open ask while a node waits; and per bound child status for every running or waiting
 * node, so a child that settles after the view arrived still flips its row.
 */
export class DagPane implements Component {
	private cache: { key: string; lines: string[] } | undefined;

	constructor(
		private readonly source: () => { dag: DagView | null; version: number },
		private readonly viewHeight: () => number,
		private readonly live: () => DagLive,
		/** Rows the screen can give the whole pane (title included); absent means the natural budget. */
		private readonly maxRows?: () => number,
	) {}

	/** Body rows the pane renders: the natural budget, capped by what the screen allows; below 1 only the title shows. */
	bodyRows(): number {
		const budget = dagBudget(this.viewHeight());
		const max = this.maxRows?.();
		return max === undefined ? budget : Math.min(budget, max - 1);
	}

	get visible(): boolean {
		return this.source().dag !== null;
	}

	render(width: number): string[] {
		const { dag, version } = this.source();
		if (dag === null) return EMPTY;
		const rows = this.bodyRows();
		const live = this.live();
		const states = dag.nodes.map((node) => displayState(dag, node, live));
		const clock = states.includes("running") || dag.research !== undefined ? `${live.tick}:${Math.floor(live.now / 1000)}` : "";
		const asks = states.includes("waiting") ? [...live.asks.values()].filter((ask) => ask.state === "open").map((ask) => ask.id).join(",") : "";
		const children = dag.nodes
			.filter((node) => (node.state === "running" || node.state === "waiting") && node.handle !== undefined)
			.map((node) => `${node.handle}=${childOf(node, live)?.status ?? ""}`)
			.join(",");
		const key = `${version}:${width}:${rows}:${clock}:${asks}:${children}`;
		if (this.cache?.key === key) return this.cache.lines;
		const lines = rows < 1 ? dagLines(dag, width, 1, live).slice(0, 1) : dagLines(dag, width, rows, live);
		this.cache = { key, lines };
		return lines;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}
