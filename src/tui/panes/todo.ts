import { type Component, type Focusable, matchesKey, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { TodoItem, WorkflowStatus } from "../../core/ui-contract.ts";
import { bold, color, glyph, pad, paint, spacing, square, strike } from "../theme.ts";
import { planFocus, planLabel, planLine, planPlaceholder, planRows, shownPlan } from "./plan.ts";

export type TodoSource = () => { todos: readonly TodoItem[]; version: number };
/** The host workflow and the revision of its last visible change, on the same clock as the todo version. */
export type PlanSource = () => { workflow: WorkflowStatus | null; version: number };
export type PaneTab = "plan" | "todo";

const MAX_ROWS = 10;
const MAX_FRACTION = 0.15;
/** Grok keeps the cursor this many rows away from the viewport edge while it fits (list_pane scroll_margin). */
const SCROLL_MARGIN = 2;
/** Grok's list scrollbar: one blank gap column and one track column (render/scrollbar.rs SCROLLBAR_TOTAL_COLS). */
const SCROLLBAR_COLS = 2;
const SCROLL_THUMB = "█";
/** Columns between the caption's title, its current item and its next item. */
const CAPTION_GAP = 2;
/** The caption drops its item below this width rather than show a cut too short to read. */
const CAPTION_MIN_ITEM = 12;

const fit = (text: string, width: number): string => {
	if (visibleWidth(text) <= width) return text;
	const reserve = Math.max(1, visibleWidth(glyph.ellipsis));
	if (width <= reserve) return sliceByColumn(text, 0, Math.max(0, width), true);
	return `${sliceByColumn(text, 0, width - reserve, true)}${glyph.ellipsis}`;
};

const isDone = (todo: TodoItem): boolean => todo.status === "completed" || todo.status === "cancelled";

export const todoRows = (viewHeight: number): number => Math.max(1, Math.min(MAX_ROWS, Math.floor(viewHeight * MAX_FRACTION)));

export function todoLine(todo: TodoItem, width: number): string {
	const icon =
		todo.status === "pending"
			? color.textPrimary(glyph.todoPending)
			: todo.status === "in_progress"
				? color.warning(glyph.todoInProgress)
				: todo.status === "completed"
					? color.accentSuccess(glyph.todoCompleted)
					: color.accentError(glyph.todoCancelled);
	const text = fit(todo.content, Math.max(0, width - visibleWidth(icon) - 1));
	switch (todo.status) {
		case "pending":
			return `${icon} ${color.textPrimary(text)}`;
		case "in_progress":
			return `${icon} ${bold(color.textPrimary(text))}`;
		case "completed":
			return `${icon} ${color.grayBright(text)}`;
		case "cancelled":
			return `${icon} ${strike(color.grayBright(text))}`;
	}
}

export function todoPlaceholder(todos: readonly TodoItem[]): string {
	if (todos.length === 0) return "No todo items.";
	const completed = todos.filter((todo) => todo.status === "completed").length;
	const cancelled = todos.filter((todo) => todo.status === "cancelled").length;
	if (cancelled === 0) return "All done.";
	if (completed === 0) return `${cancelled} cancelled.`;
	return `${completed} done. ${cancelled} cancelled.`;
}

const thumbRange = (offset: number, rows: number, count: number): { start: number; end: number } => {
	const length = Math.max(1, Math.round((rows * rows) / count));
	const start = Math.round((offset * (rows - length)) / Math.max(1, count - rows));
	return { start, end: start + length };
};

/**
 * τ: which tab the pane shows. Unfocused, it follows the source that changed last (both versions come from one
 * monotone revision clock, so the order is total). Focused, the viewer's choice holds while that tab has content.
 * With one source, that source; with none, the todo tab and its placeholder.
 */
export function chooseTab(input: { plan: boolean; todo: boolean; planVersion: number; todoVersion: number; chosen: PaneTab | undefined }): PaneTab {
	const has = (tab: PaneTab): boolean => (tab === "plan" ? input.plan : input.todo);
	if (input.chosen !== undefined && has(input.chosen)) return input.chosen;
	if (input.plan && input.todo) return input.planVersion > input.todoVersion ? "plan" : "todo";
	return input.plan ? "plan" : "todo";
}

type Row = { key: string; line: (width: number) => string };
type Segment = readonly [text: string, style: (text: string) => string];

/** Truncates plain segment text across the joined width, then styles each piece, so no reset escapes into the row. */
function fitStyled(segments: readonly Segment[], width: number): string {
	const plain = segments.map(([text]) => text).join("");
	const target = visibleWidth(plain) <= width ? plain : fit(plain, width);
	let out = "";
	let used = 0;
	const end = visibleWidth(target);
	for (const [text, style] of segments) {
		if (used >= end) break;
		const take = Math.min(visibleWidth(text), end - used);
		const piece = sliceByColumn(target, used, take, true);
		if (piece !== "") out += style(piece);
		used += take;
	}
	return out;
}
type View = { tab: PaneTab; rows: readonly Row[]; focus: number; placeholder: string };

/**
 * The work caption on the prompt box: the agent's TODO list and, when a work item is registered, its acceptance plan.
 * At rest it is one row (the tab's title, the current item, the next item when they fit). Ctrl+T gives it keyboard
 * focus as the framed, scrollable pane; ←/→ switch tabs while both have content; Esc, q or Tab collapse it back to the
 * caption. Visibility follows the sources; an explicit open of an empty pane holds until focus leaves.
 */
export class TodoPane implements Component, Focusable {
	private visibility: boolean | undefined;
	get visible(): boolean {
		return this.visibility ?? (this.source().todos.length > 0 || this.hasPlan());
	}
	set visible(value: boolean) {
		this.visibility = value;
	}
	private focus = false;
	/** Set on focus so live updates cannot switch the tab under the viewer's cursor; cleared on blur. */
	private chosen: PaneTab | undefined;
	get focused(): boolean {
		return this.focus;
	}
	set focused(value: boolean) {
		if (value && !this.focus) this.chosen = this.tab();
		if (!value) {
			this.chosen = undefined;
			// Losing focus releases the explicit open, so an empty pane leaves no row behind.
			this.visibility = undefined;
		}
		this.focus = value;
	}
	hideDone = false;
	onClose?: () => void;
	private selectedKey: string | undefined;
	private offset = 0;
	private shown: { key: string; view: View } | undefined;
	private cache: { key: string; lines: string[] } | undefined;

	constructor(
		private readonly source: TodoSource,
		private readonly viewHeight: () => number,
		private readonly plan: PlanSource = () => ({ workflow: null, version: 0 }),
		/** Rows the screen can give the whole pane (title and bottom row included); the title always shows. */
		private readonly maxRows?: () => number,
	) {}

	reset(): void {
		this.visibility = undefined;
		this.hideDone = false;
		this.selectedKey = undefined;
		this.chosen = this.focus ? undefined : this.chosen;
		this.offset = 0;
		this.invalidate();
	}

	invalidate(): void {
		this.cache = undefined;
		this.shown = undefined;
	}

	/** The tab currently on screen. */
	tab(): PaneTab {
		const { todos, version } = this.source();
		return chooseTab({ plan: this.hasPlan(), todo: todos.length > 0, planVersion: this.plan().version, todoVersion: version, chosen: this.chosen });
	}

	/** Both tabs have content, so ←/→ does something. */
	switchable(): boolean {
		return this.hasPlan() && this.source().todos.length > 0;
	}

	private hasPlan(): boolean {
		return shownPlan(this.plan().workflow) !== undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "h")) {
			this.hideDone = !this.hideDone;
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.onClose?.();
			return;
		}
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			if (this.switchable()) {
				const other: PaneTab = this.tab() === "plan" ? "todo" : "plan";
				this.chosen = other;
				this.selectedKey = undefined;
				this.offset = 0;
			}
			return;
		}
		const { rows } = this.view();
		if (rows.length === 0) return;
		const index = this.selectedIndex();
		const page = this.rows(rows.length, this.maxRows?.());
		let next: number | undefined;
		if (matchesKey(data, "down") || matchesKey(data, "j") || matchesKey(data, "ctrl+n")) next = index + 1;
		else if (matchesKey(data, "up") || matchesKey(data, "k") || matchesKey(data, "ctrl+p")) next = index - 1;
		else if (matchesKey(data, "pageDown")) next = index + page;
		else if (matchesKey(data, "pageUp")) next = index - page;
		else if (matchesKey(data, "home") || matchesKey(data, "g")) next = 0;
		else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) next = rows.length - 1;
		if (next === undefined) return;
		this.selectedKey = rows[Math.max(0, Math.min(rows.length - 1, next))]?.key;
	}

	render(width: number): string[] {
		if (!this.visible) return [];
		const view = this.view();
		if (!this.focus) {
			const key = `${this.shown?.key}:caption:${width}`;
			if (this.cache?.key === key) return this.cache.lines;
			const lines = [paint(this.caption(view, width), width)];
			this.cache = { key, lines };
			return lines;
		}
		const limit = this.maxRows?.();
		const rows = this.rows(view.rows.length, limit);
		const selected = this.selectedIndex();
		this.scrollTo(selected, rows, view.rows.length);
		const key = `${this.shown?.key}:${rows}:${this.focus}:${selected}:${this.offset}:${width}:${limit}`;
		if (this.cache?.key === key) return this.cache.lines;
		const all = this.lines(view, rows, selected, width).map((line) => paint(line, width));
		// Under three rows the frame cannot hold an item, so only its title row shows.
		const lines = limit === undefined ? all : limit < 3 ? all.slice(0, 1) : all.slice(0, limit);
		this.cache = { key, lines };
		return lines;
	}

	/**
	 * The one-row caption at rest: the title, then the current item and the next one when they fit, each cut as plain text
	 * before it is styled. The title never gives way to an item; the next item shows whole or not at all; the current item
	 * is cut with the ellipsis and dropped under CAPTION_MIN_ITEM columns.
	 */
	private caption(view: View, width: number): string {
		const inner = Math.max(0, width - spacing.margin * 2);
		const title = fitStyled(this.title(view.tab, inner), inner);
		let out = `${" ".repeat(spacing.margin)}${title}`;
		let room = inner - visibleWidth(title) - CAPTION_GAP;
		const [current, next] = this.captionItems(view);
		if (current === undefined || room < CAPTION_MIN_ITEM) return out;
		const shown = current(room);
		out += `${" ".repeat(CAPTION_GAP)}${shown}`;
		room -= visibleWidth(shown) + CAPTION_GAP;
		const whole = next?.(Number.POSITIVE_INFINITY);
		if (whole !== undefined && visibleWidth(whole) <= room) out += `${" ".repeat(CAPTION_GAP)}${whole}`;
		return out;
	}

	/**
	 * What the caption shows after the title. TODO tab: the first in-progress item, else the first pending one, else the
	 * placeholder; next is the first other pending item. Plan tab: the requirement `planFocus` picks; no next.
	 */
	private captionItems(view: View): [current: ((width: number) => string) | undefined, next: ((width: number) => string) | undefined] {
		if (view.tab === "plan") {
			const plan = shownPlan(this.plan().workflow);
			const requirements = plan === undefined ? [] : planRows(plan, false).filter((row) => row.kind === "requirement");
			const row = requirements[planFocus(requirements)];
			return [row === undefined ? undefined : (width) => planLine(row, width), undefined];
		}
		const todos = this.source().todos;
		const current = todos.find((todo) => todo.status === "in_progress") ?? todos.find((todo) => todo.status === "pending");
		if (current === undefined) return [(width) => color.grayBright(fit(view.placeholder, width)), undefined];
		const next = todos.find((todo) => todo !== current && todo.status === "pending");
		return [(width) => todoLine(current, width), next === undefined ? undefined : (width) => todoLine(next, width)];
	}

	private view(): View {
		const { todos, version } = this.source();
		const { workflow, version: planVersion } = this.plan();
		const tab = this.tab();
		const key = `${tab}:${version}:${planVersion}:${this.hideDone}`;
		if (this.shown?.key === key) return this.shown.view;
		let view: View;
		const plan = tab === "plan" ? shownPlan(workflow) : undefined;
		if (plan) {
			const rows = planRows(plan, this.hideDone);
			view = { tab, rows: rows.map((row) => ({ key: row.key, line: (width: number) => planLine(row, width) })), focus: planFocus(rows), placeholder: planPlaceholder(plan) };
		} else {
			const shown = this.hideDone ? todos.filter((todo) => !isDone(todo)) : todos;
			const active = shown.findIndex((todo) => todo.status === "in_progress");
			view = { tab: "todo", rows: shown.map((todo) => ({ key: `t:${todo.id}`, line: (width: number) => todoLine(todo, width) })), focus: Math.max(0, active), placeholder: todoPlaceholder(todos) };
		}
		this.shown = { key, view };
		return view;
	}

	private rows(count: number, limit?: number): number {
		return Math.max(1, Math.min(count, todoRows(this.viewHeight()), limit === undefined ? count : limit - 2));
	}

	private selectedIndex(): number {
		const view = this.view();
		const chosen = this.selectedKey === undefined ? -1 : view.rows.findIndex((row) => row.key === this.selectedKey);
		return chosen >= 0 ? chosen : view.focus;
	}

	private scrollTo(selected: number, rows: number, count: number): void {
		const margin = Math.min(SCROLL_MARGIN, Math.floor((rows - 1) / 2));
		if (selected < this.offset + margin) this.offset = Math.max(0, selected - margin);
		if (selected + 1 + margin > this.offset + rows) this.offset = selected + 1 + margin - rows;
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, count - rows)));
	}

	/** One label per source that has content; with two, the shown tab is bracketed so the choice does not rest on color. */
	private title(tab: PaneTab, width: number): Segment[] {
		const todos = this.source().todos;
		const completed = todos.filter((todo) => todo.status === "completed").length;
		const todoLabel = `TODO ${completed}/${todos.length} done`;
		const workflow = this.plan().workflow;
		const plan = shownPlan(workflow);
		const planText = plan && workflow ? planLabel(workflow, plan) : "";
		const both = plan !== undefined && todos.length > 0;
		const hint = both && this.focus ? " · ←/→ · Ctrl+T" : " · Ctrl+T";
		const active = (text: string): string => bold(color.textPrimary(text));
		const label = (text: string, on: boolean): Segment => (on ? [`[${text}]`, active] : [text, color.grayBright]);
		const current = tab === "plan" ? planText : todoLabel;
		const full: Segment[] = both
			? [label(planText, tab === "plan"), ["  ", color.grayBright], label(todoLabel, tab === "todo"), [hint, color.grayBright]]
			: [[`${current}${hint}`, color.grayBright]];
		if (visibleWidth(full.map(([text]) => text).join("")) <= width) return full;
		// Keep the active tab and its opening key discoverable before secondary labels.
		const compact = fit(current, Math.max(0, width - visibleWidth(hint) - (both ? 2 : 0)));
		return [both ? label(compact, true) : [compact, color.grayBright], [hint, color.grayBright]];
	}

	/** The focused pane: frame, title row, items with the cursor band and the scroll indicators, bottom row. */
	private lines(view: View, rows: number, selected: number, width: number): string[] {
		const border = color.selectionBorder;
		// The frame takes the page margin on both sides: its bar sits in the column before the content column.
		const lead = " ".repeat(Math.max(0, spacing.margin - 1));
		const inner = Math.max(0, width - lead.length * 2 - 2);
		const area = Math.max(1, inner - spacing.bullet - spacing.rightPad);
		const left = `${lead}${border(square.v)}`;
		const right = `${border(square.v)}${lead}`;
		const row = (body: string): string => `${left}${" ".repeat(spacing.bullet)}${body}${" ".repeat(spacing.rightPad)}${right}`;
		const title = fitStyled(this.title(view.tab, inner), inner);
		const top = `${lead}${border(square.tl)}${pad(title, inner)}${border(square.tr)}${lead}`;
		const bottom = `${lead}${border(square.bl)}${" ".repeat(inner)}${border(square.br)}${lead}`;
		if (view.rows.length === 0) return [top, row(pad(color.grayBright(view.placeholder), area)), bottom];
		const overflow = view.rows.length > rows;
		const content = overflow ? Math.max(1, area - SCROLLBAR_COLS) : area;
		const thumb = overflow ? thumbRange(this.offset, rows, view.rows.length) : undefined;
		const body: string[] = [];
		for (let k = 0; k < rows; k++) {
			const index = this.offset + k;
			const item = view.rows[index] as Row;
			const indicator = k === 0 && this.offset > 0 ? glyph.cutAbove : k === rows - 1 && index + 1 < view.rows.length ? glyph.cutBelow : undefined;
			let text = indicator === undefined ? pad(item.line(content), content) : `${pad(item.line(content - 2), content - 1)}${color.gray(indicator)}`;
			if (index === selected) text = color.bgHighlight(text);
			if (thumb) text += ` ${k >= thumb.start && k < thumb.end ? color.scrollbarThumb(SCROLL_THUMB) : " "}`;
			body.push(row(text));
		}
		return [top, ...body, bottom];
	}
}
