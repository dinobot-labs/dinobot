import {
	type Component,
	type Focusable,
	foregroundAnsi,
	getTerminalColorMode,
	isKeyRelease,
	matchesKey,
	type OverlayBounds,
	type OverlayHandle,
	type OverlayOptions,
	type ScrollView,
	type Terminal,
	truncateToWidth,
	TuiAltScreen,
	type TuiMouseEvent,
	type TuiInputListener,
	visibleWidth,
	VStack,
} from "@earendil-works/pi-tui";
import type { UpdateInfo } from "../update.ts";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { SubagentProgress } from "../core/ui-contract.ts";
import { isFoldablePrompt, renderAgent, renderNotice, renderThinking, renderUser } from "./blocks/messages.ts";
import { createTakeoverView, isGroupable, renderGroupHeader, renderRoster, renderSubagentRow } from "./blocks/subagents.ts";
import { renderTool } from "./blocks/tools.ts";
import { type FooterHint, type HeaderInfo, PromptBox, promptCaption, ReflowScrollView, renderFooter, renderHeader, renderTurnStatus, renderUpdateNotice, SHORTCUT_SECTIONS, ShortcutsOverlay, shortcutsOverlayOptions } from "./chrome.ts";
import { brandGradient, MASCOT_SIZE, renderMascot } from "./mascot.ts";
import { DagPane, displayState, foldRows } from "./panes/dag.ts";
import { renderQueue } from "./panes/queue.ts";
import { TodoPane } from "./panes/todo.ts";
import type { AgentBlock, Block, ChatState, NoticeBlock, SubagentBlock, ThinkingBlock, ToolBlock, UserBlock } from "./state.ts";
import { runningSubagents } from "./state.ts";
import { ansi, bold, color, cutCorner, glyph, pad, paint, separator, spacing, square, TICK_MS } from "./theme.ts";
import { entryOpen, initialView, setView, type ViewState, type ViewToggle } from "./view.ts";

export type RenderContext = { expanded: boolean; selected: boolean; tick: number; now: number; running: boolean };
export type BlockRenderer<B extends Block = Block> = (block: B, width: number, ctx: RenderContext) => string[];
export type GroupRenderer = (members: readonly (ToolBlock | SubagentBlock)[], width: number, ctx: RenderContext) => string[];

/** The plug-in table the transcript dispatches on; later lanes swap entries without touching the screen. */
export type BlockRenderers = {
	user: BlockRenderer<UserBlock>;
	agent: BlockRenderer<AgentBlock>;
	thinking: BlockRenderer<ThinkingBlock>;
	tool: BlockRenderer<ToolBlock>;
	subagent: BlockRenderer<SubagentBlock>;
	notice: BlockRenderer<NoticeBlock>;
	group: GroupRenderer;
};

export const defaultRenderers: BlockRenderers = {
	user: renderUser,
	agent: renderAgent,
	thinking: renderThinking,
	tool: renderTool,
	subagent: renderSubagentRow,
	notice: renderNotice,
	group: renderGroupHeader,
};

/** A chrome row whose lines are recomputed only when `key()` or the width changes. */
export class Region implements Component {
	private cache: { width: number; key: string; lines: string[] } | undefined;

	constructor(
		private readonly lines: (width: number) => string[],
		private readonly key: () => string,
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

const blankRow = (): Region => new Region(() => [""], () => "");

/**
 * Transcript geometry: content starts at the page margin; the selection frame's bars sit in the column before it on the
 * left and mirror that on the right, so the content area is the width less the frame lead, the two border columns and the tail.
 */
const frameLeadCols = Math.max(0, spacing.margin - 1);
const frameTailCols = Math.max(0, spacing.margin - 2);
const contentArea = (width: number): number => Math.max(1, width - (frameLeadCols + 2 + frameTailCols));
const marginText = " ".repeat(spacing.margin);
const frameLead = " ".repeat(frameLeadCols);
const frameTail = " ".repeat(frameTailCols);

/** Grok centers its `▼` / `▲` clipped-selection markers on the content columns (margin .. width - margin - 1). */
const centered = (mark: string, width: number): string => `${" ".repeat(spacing.margin + Math.floor(Math.max(0, width - spacing.margin * 2) / 2))}${color.gray(mark)}`;

/**
 * One selectable entry of a transcript row: a block, or the synthetic `◈` header of a verb run.
 * `run` points at the header slot of the run the entry belongs to; `expanded` is the fold state the footer shows.
 */
/** Which mode an entry's fold follows: Ctrl+O for tools and subagents, Ctrl+E for thoughts, a fixed closed mode for runs and prompts. */
type FoldClass = "tools" | "thinking" | "group" | "fixed";
const foldClass = (block: Block): FoldClass => (block.kind === "tool" || block.kind === "subagent" ? "tools" : block.kind === "thinking" ? "thinking" : "fixed");

type Slot = { key: string; block?: number; members?: number[]; run?: number; foldable: boolean; expanded: boolean; from: number; to: number };
type Row = {
	blocks: number[];
	chain: boolean;
	slots: Slot[];
	lines: string[];
	raw: string[] | undefined;
	inner: { from: number; to: number } | undefined;
	bands: number[];
	start: number;
	animated: boolean;
	cornerBelow: boolean;
};
type Viewport = { top: number; height: number };

const isChainKind = (block: Block): boolean => block.kind === "tool" || block.kind === "thinking" || block.kind === "subagent";
const isAnimated = (block: Block): boolean =>
	(block.kind === "tool" && block.status === "running") || (block.kind === "subagent" && block.progress.status === "running") || (block.kind === "thinking" && block.streaming) || (block.kind === "agent" && block.streaming);

/**
 * Grok's gap rule (scrollback/state/groups.rs): entries inside a verb run touch, an expanded entry always gets a gap after
 * it, and an expanded entry outside the previous entry's run gets a gap before it; collapsed neighbours touch.
 */
const gapBetween = (previous: Slot, next: Omit<Slot, "from" | "to">): boolean => {
	if (previous.block !== undefined && previous.expanded) return true;
	const sameRun = previous.run !== undefined && previous.run === next.run;
	return next.block !== undefined && next.expanded && !sameRun;
};

/** The scrollback: rows of blocks (messages, notices, tool chains with ◈ runs), cached per row and spliced into one flat line list. */
export class Transcript implements Component, Focusable {
	focused = false;
	tick = 0;
	onOpen?: (progress: SubagentProgress) => void;
	onSelect?: (range: { start: number; end: number } | undefined) => void;
	onBlur?: () => void;
	welcome?: (width: number) => string[];
	fillTo?: () => number;
	/** The visible line window of the owning scroll view, for the `┆` edges of a clipped selection box. */
	viewport?: () => Viewport;
	private rows: Row[] = [];
	private readonly rowOf = new Map<string, number>();
	private flat: string[] = [];
	private width = 0;
	private structure = -1;
	private blockCount = 0;
	/** Entries whose fold disagrees with their class mode (`entryOpen`). */
	private readonly flipped: Record<FoldClass, Set<string>> = { tools: new Set(), thinking: new Set(), group: new Set(), fixed: new Set() };
	private readonly decorated = new WeakMap<string[], { width: number; lines: string[] }[]>();
	private readonly modes = { tools: false, thinking: false };
	private selection: { row: number; slot: number } | undefined;
	private topCorner = false;
	/** Tallest collapsed prompt band, per width and block count (prompts never change once pushed). */
	private pinnedRows: { key: string; rows: number } | undefined;

	constructor(
		private state: ChatState,
		private readonly renderers: BlockRenderers = defaultRenderers,
	) {}

	bind(state: ChatState): void {
		this.state = state;
		this.structure = -1;
		this.selection = undefined;
		for (const set of Object.values(this.flipped)) set.clear();
	}

	/** Ctrl+O's mode, which also applies to blocks arriving later; folded runs restart closed. */
	setToolsExpanded(expand: boolean): void {
		this.modes.tools = expand;
		this.flipped.tools.clear();
		this.flipped.group.clear();
		this.selection = undefined;
		this.onSelect?.(undefined);
		this.invalidate();
	}

	/** Ctrl+E's mode, which also applies to thoughts arriving later; tool folds and the selection are kept. */
	setThinkingExpanded(expand: boolean): void {
		this.modes.thinking = expand;
		this.flipped.thinking.clear();
		const blocks = this.state.data.blocks;
		this.rows.forEach((row, index) => {
			if (row.blocks.some((block) => blocks[block]?.kind === "thinking")) this.rerender(index);
		});
		if (this.selection) this.refreshSelection();
	}

	thinkingExpanded(): boolean {
		return this.modes.thinking;
	}

	private classMode(fold: FoldClass): boolean {
		return fold === "tools" || fold === "thinking" ? this.modes[fold] : false;
	}

	private isOpen(fold: FoldClass, key: string): boolean {
		return entryOpen(this.classMode(fold), this.flipped[fold].has(key));
	}

	private blockExpanded(block: Block): boolean {
		return this.isOpen(foldClass(block), block.id);
	}

	private expandSlot(slot: Slot, expand: boolean): void {
		const fold = slot.block === undefined ? "group" : foldClass(this.state.data.blocks[slot.block] as Block);
		if (expand === this.classMode(fold)) this.flipped[fold].delete(slot.key);
		else this.flipped[fold].add(slot.key);
	}

	get selected(): { row: number; slot: number } | undefined {
		return this.selection;
	}

	get lineCount(): number {
		return this.flat.length;
	}

	/** True when the selected entry starts on the transcript's first line, so its `┌ ┐` corners belong on the row above the scrollback. */
	get cornerOnGap(): boolean {
		return this.topCorner;
	}

	invalidate(): void {
		this.structure = -1;
	}

	render(width: number): string[] {
		if (width !== this.width) {
			this.width = width;
			this.structure = -1;
		}
		this.sync();
		const welcome = this.rows.length === 0 && this.welcome && !this.state.data.run;
		const lines = welcome ? (this.welcome as (width: number) => string[])(width).map((line) => paint(line, width)) : this.withClippedEdges(this.flat);
		const fill = this.fillTo?.() ?? 0;
		if (lines.length >= fill) return lines;
		const blank = paint("", width);
		return [...lines, ...Array.from({ length: fill - lines.length }, () => blank)];
	}

	private sync(): void {
		const data = this.state.data;
		const rebuild = data.structure !== this.structure;
		if (rebuild) {
			this.structure = data.structure;
			this.rows = [];
			this.rowOf.clear();
			this.flat = [];
			this.blockCount = 0;
			this.topCorner = false;
			if (this.selection && this.selection.row >= data.blocks.length) this.selection = undefined;
		}
		for (let index = this.blockCount; index < data.blocks.length; index++) this.append(index, !rebuild);
		if (rebuild) {
			// Assemble chains before painting them: resizing must not repeatedly paint
			// every prefix of a tool/thinking run as its members are appended.
			for (let row = 0; row < this.rows.length; row++) this.rerender(row);
			data.dirty.clear();
		}
		if (data.dirty.size > 0) {
			const touched = new Set<number>();
			for (const id of data.dirty) {
				const row = this.rowOf.get(id);
				if (row !== undefined && !touched.has(row)) {
					touched.add(row);
					this.rerender(row);
				}
			}
			data.dirty.clear();
		}
	}

	private append(index: number, render = true): void {
		const block = this.state.data.blocks[index];
		if (!block) return;
		const chain = isChainKind(block);
		const last = this.rows[this.rows.length - 1];
		if (chain && last?.chain) {
			last.blocks.push(index);
			this.rowOf.set(block.id, this.rows.length - 1);
			if (render) this.rerender(this.rows.length - 1);
		} else {
			this.rows.push({ blocks: [index], chain, slots: [], lines: [], raw: undefined, inner: undefined, bands: [], start: this.flat.length, animated: false, cornerBelow: false });
			this.rowOf.set(block.id, this.rows.length - 1);
			if (render) this.rerender(this.rows.length - 1);
		}
		this.blockCount = index + 1;
	}

	private rerender(rowIndex: number): void {
		const row = this.rows[rowIndex];
		if (!row) return;
		const { lines, cornerAbove } = this.renderRow(row, rowIndex);
		const previous = row.lines.length;
		if (lines.length === previous) {
			for (let k = 0; k < lines.length; k++) this.flat[row.start + k] = lines[k] as string;
		} else {
			this.flat.splice(row.start, previous, ...lines);
			const delta = lines.length - previous;
			for (let later = rowIndex + 1; later < this.rows.length; later++) (this.rows[later] as Row).start += delta;
		}
		row.lines = lines;
		if (rowIndex === 0) this.topCorner = cornerAbove;
		const above = this.rows[rowIndex - 1];
		if (above !== undefined && above.cornerBelow !== cornerAbove) {
			above.cornerBelow = cornerAbove;
			this.rerender(rowIndex - 1);
		}
	}

	private renderBlock(block: Block, width: number, ctx: RenderContext): string[] {
		switch (block.kind) {
			case "user":
				return this.renderers.user(block, width, ctx);
			case "agent":
				return this.renderers.agent(block, width, ctx);
			case "thinking":
				return this.renderers.thinking(block, width, ctx);
			case "tool":
				return this.renderers.tool(block, width, ctx);
			case "subagent":
				return this.renderers.subagent(block, width, ctx);
			case "notice":
				return this.renderers.notice(block, width, ctx);
		}
	}

	/**
	 * Grok's verb run (state/groups.rs): from a groupable entry, walk over groupable entries and the finished collapsed
	 * thoughts between or after them; expanded members stay in the span but are not counted; the run folds only when
	 * at least one member is collapsed.
	 */
	private scanRun(indices: readonly number[], start: number): { entries: number[]; countable: number[]; end: number } | undefined {
		// The expanded view cannot produce folded runs; avoid rescanning every suffix.
		if (this.modes.tools && this.flipped.tools.size === 0) return undefined;
		const blocks = this.state.data.blocks;
		if (!isGroupable(blocks[indices[start] as number] as Block)) return undefined;
		const entries: number[] = [];
		const countable: number[] = [];
		let end = start;
		while (end < indices.length) {
			const block = blocks[indices[end] as number] as Block;
			if (isGroupable(block)) {
				entries.push(end);
				if (!this.blockExpanded(block)) countable.push(end);
			} else if (block.kind === "thinking" && !block.streaming && !this.blockExpanded(block)) entries.push(end);
			else break;
			end++;
		}
		return countable.length === 0 ? undefined : { entries, countable, end };
	}

	private renderRow(row: Row, rowIndex: number): { lines: string[]; cornerAbove: boolean } {
		const blocks = this.state.data.blocks;
		const area = contentArea(this.width);
		const selectedSlot = this.selection?.row === rowIndex ? this.selection.slot : -1;
		const base = { tick: this.tick, now: Date.now(), running: this.state.data.run !== undefined };
		const slots: Slot[] = [];
		const body: string[] = [];
		const plain = selectedSlot < 0 && !row.cornerBelow;
		const blank = plain ? paint("", this.width) : "";
		let animated = false;
		const emit = (slot: Omit<Slot, "from" | "to">, lines: string[]): void => {
			const previous = slots[slots.length - 1];
			if (previous !== undefined && gapBetween(previous, slot)) body.push(blank);
			slots.push({ ...slot, from: body.length, to: body.length + lines.length });
			for (const line of plain ? this.decoratePlain(lines) : lines) body.push(line);
		};
		const emitBlock = (index: number, run?: number): void => {
			const block = blocks[index] as Block;
			const expanded = this.blockExpanded(block);
			const foldable = block.kind === "subagent" || block.kind === "tool" || block.kind === "thinking" || (block.kind === "user" && isFoldablePrompt(block.text));
			emit({ key: block.id, block: index, ...(run === undefined ? {} : { run }), foldable, expanded }, this.renderBlock(block, area, { ...base, expanded, selected: selectedSlot === slots.length }));
			animated ||= isAnimated(block);
		};
		if (!row.chain) emitBlock(row.blocks[0] as number);
		else {
			let k = 0;
			while (k < row.blocks.length) {
				const run = this.scanRun(row.blocks, k);
				if (run === undefined) {
					emitBlock(row.blocks[k] as number);
					k++;
					continue;
				}
				const header = slots.length;
				const key = `group:${(blocks[row.blocks[k] as number] as Block).id}`;
				const open = this.isOpen("group", key);
				const members = run.countable.map((position) => row.blocks[position] as number);
				const memberBlocks = members.map((index) => blocks[index] as ToolBlock | SubagentBlock);
				emit({ key, members, run: header, foldable: true, expanded: open }, this.renderers.group(memberBlocks, area, { ...base, expanded: open, selected: selectedSlot === header }));
				animated ||= memberBlocks.some(isAnimated);
				for (const position of run.entries) {
					const index = row.blocks[position] as number;
					const block = blocks[index] as Block;
					if (!open && block.kind !== "tool" && block.kind !== "subagent") continue;
					emitBlock(index, header);
				}
				k = run.end;
			}
		}
		body.push(blank);
		const selected = selectedSlot >= 0 ? slots[selectedSlot] : undefined;
		let inner: { from: number; to: number } | undefined;
		const bands: number[] = [];
		if (selected !== undefined) {
			const header = selected.run === undefined ? undefined : (slots[selected.run] as Slot);
			const transparent = selected.block !== undefined && selected.expanded;
			if (header !== undefined && !transparent) {
				let to = header.to;
				for (const slot of slots) if (slot.run === selected.run) to = slot.to;
				inner = { from: header.from, to };
				if (row.chain && selected !== header) bands.push(header.from);
			} else inner = { from: selected.from, to: selected.to };
			if (row.chain) bands.push(selected.from);
		}
		row.slots = slots;
		row.animated = animated;
		row.inner = inner;
		row.bands = bands;
		row.raw = inner === undefined ? undefined : body;
		const last = body.length - 1;
		return { lines: plain ? body : body.map((line, index) => this.decorate(row, line, index, last)), cornerAbove: inner !== undefined && inner.from === 0 };
	}

	/** Renderer arrays are immutable and already bounded per block; let their lifetime own decoration. */
	private decoratePlain(lines: string[]): string[] {
		let entries = this.decorated.get(lines);
		const hit = entries?.find((entry) => entry.width === this.width);
		if (hit) return hit.lines;
		const decorated = lines.map((line) => paint(`${marginText}${line}`, this.width));
		if (!entries) {
			entries = [];
			this.decorated.set(lines, entries);
		}
		entries.unshift({ width: this.width, lines: decorated });
		entries.length = Math.min(entries.length, 2);
		return decorated;
	}

	/**
	 * Grok's SelectionBox (scrollback/selection.rs): `│` on the entry's own lines, `┌ ┐` on the line above and `└ ┘` on
	 * the line below, whatever they hold; `┆` on an edge line the viewport cuts; `bg_highlight` on the selected row and
	 * on the run header above a selected member.
	 */
	private decorate(row: Row, line: string, index: number, last: number, dashed = false): string {
		const area = contentArea(this.width);
		const border = color.selectionBorder;
		const frame = (left: string, right: string, content: string): string => paint(`${frameLead}${border(left)}${content}${border(right)}${frameTail}`, this.width);
		const inner = row.inner;
		if (inner !== undefined) {
			if (index === inner.from - 1) return frame(square.tl, square.tr, pad(line, area));
			if (index === inner.to) return frame(square.bl, square.br, pad(line, area));
			if (index >= inner.from && index < inner.to) {
				const side = dashed ? cutCorner : square.v;
				return frame(side, side, row.bands.includes(index) ? color.bgHighlight(pad(line, area)) : pad(line, area));
			}
		}
		if (index === last && row.cornerBelow) return frame(square.tl, square.tr, pad(line, area));
		return paint(`${marginText}${line}`, this.width);
	}

	/** The selected entry's own lines (run span for a header or claimed member) as inclusive flat indices. */
	selectionBox(): { top: number; bottom: number } | undefined {
		if (!this.selection) return undefined;
		const row = this.rows[this.selection.row];
		if (row?.inner === undefined) return undefined;
		return { top: row.start + row.inner.from, bottom: row.start + row.inner.to - 1 };
	}

	/**
	 * Grok's sticky turn header (scrollback_pane.rs pinned header): the latest prompt scrolled above the viewport, collapsed.
	 * Every prompt pins at one height (the tallest collapsed prompt), padded inside its band. The pin sits above the scroll
	 * view, so a height that differed per prompt would resize the viewport and move a followed scrollTop, which in turn
	 * re-picks the pin: a taller pin followed by a shorter one would swap every frame without ever settling.
	 */
	pinnedHeader(scrollTop: number): { id: string; lines: string[] } | undefined {
		if (scrollTop <= 0) return undefined;
		const blocks = this.state.data.blocks;
		for (let index = this.rows.length - 1; index >= 0; index--) {
			const row = this.rows[index] as Row;
			if (row.start >= scrollTop) continue;
			const block = blocks[row.blocks[0] as number];
			if (block?.kind !== "user") continue;
			const lines = this.collapsedPrompt(block);
			const rows = this.pinnedPromptRows();
			// The band ends with a blank band row; repeat it so the band itself grows to the shared height.
			const padded = lines.length >= rows || lines.length === 0 ? lines : [...lines.slice(0, -1), ...Array.from({ length: rows - lines.length + 1 }, () => lines.at(-1) as string)];
			return { id: `${block.id}:${block.version}:${this.width}`, lines: padded.map((line) => `${marginText}${line}`) };
		}
		return undefined;
	}

	private collapsedPrompt(block: UserBlock): string[] {
		return this.renderers.user(block, contentArea(this.width), { expanded: false, selected: false, tick: this.tick, now: Date.now(), running: false });
	}

	private pinnedPromptRows(): number {
		const blocks = this.state.data.blocks;
		const key = `${this.width}:${this.structure}:${blocks.length}`;
		if (this.pinnedRows?.key === key) return this.pinnedRows.rows;
		let rows = 0;
		for (const block of blocks) if (block.kind === "user") rows = Math.max(rows, this.collapsedPrompt(block).length);
		this.pinnedRows = { key, rows };
		return rows;
	}

	/** Whether the viewport cuts the selection box above or below (Grok's `▲` / `▼` markers). */
	clipState(viewport: Viewport): { above: boolean; below: boolean } {
		const box = this.selectionBox();
		if (box === undefined) return { above: false, below: false };
		return { above: box.top < viewport.top, below: box.bottom > viewport.top + viewport.height - 1 };
	}

	private withClippedEdges(lines: string[]): string[] {
		const box = this.selectionBox();
		const viewport = this.viewport?.();
		if (box === undefined || viewport === undefined || !this.selection) return lines;
		const first = viewport.top;
		const last = viewport.top + viewport.height - 1;
		const clipTop = box.top < first && box.bottom >= first;
		const clipBottom = box.bottom > last && box.top <= last;
		if (!clipTop && !clipBottom) return lines;
		const row = this.rows[this.selection.row] as Row;
		const raw = row.raw as string[];
		const out = lines.slice();
		const patch = (flatIndex: number): void => {
			const index = flatIndex - row.start;
			out[flatIndex] = this.decorate(row, raw[index] as string, index, raw.length - 1, true);
		};
		if (clipTop) patch(first);
		if (clipBottom) patch(last);
		return out;
	}

	animate(tick: number): boolean {
		this.tick = tick;
		let changed = false;
		this.rows.forEach((row, index) => {
			if (!row.animated) return;
			this.rerender(index);
			changed = true;
		});
		return changed;
	}

	private slotAt(selection: { row: number; slot: number }): Slot | undefined {
		return this.rows[selection.row]?.slots[selection.slot];
	}

	selectedBlock(): Block | undefined {
		if (!this.selection) return undefined;
		const slot = this.slotAt(this.selection);
		return slot?.block === undefined ? undefined : this.state.data.blocks[slot.block];
	}

	/** Fold state of the selected entry, for the footer's `→:expand` / `←:collapse` hint. */
	selectionInfo(): { foldable: boolean; expanded: boolean } | undefined {
		const slot = this.selection === undefined ? undefined : this.slotAt(this.selection);
		return slot === undefined ? undefined : { foldable: slot.foldable, expanded: slot.expanded };
	}

	private refreshSelection(previous?: { row: number; slot: number }): void {
		if (previous && previous.row !== this.selection?.row) this.rerender(previous.row);
		if (this.selection) this.rerender(this.selection.row);
		const row = this.selection ? this.rows[this.selection.row] : undefined;
		const inner = row?.inner;
		this.onSelect?.(row && inner ? { start: Math.max(0, row.start + inner.from - 1), end: Math.min(this.flat.length, row.start + inner.to + 1) } : undefined);
	}

	focus(): void {
		if (this.rows.length === 0) return;
		const previous = this.selection;
		this.selection ??= { row: this.rows.length - 1, slot: 0 };
		this.refreshSelection(previous);
	}

	blur(): void {
		const previous = this.selection;
		this.selection = undefined;
		if (previous) this.rerender(previous.row);
		this.onSelect?.(undefined);
		this.onBlur?.();
	}

	move(delta: 1 | -1): void {
		if (!this.selection) return this.focus();
		const previous = this.selection;
		let { row, slot } = this.selection;
		slot += delta;
		while (row >= 0 && row < this.rows.length) {
			const count = (this.rows[row] as Row).slots.length;
			if (slot >= 0 && slot < count) break;
			row += delta;
			slot = delta === 1 ? 0 : (this.rows[row]?.slots.length ?? 1) - 1;
		}
		if (row < 0 || row >= this.rows.length) return;
		this.selection = { row, slot };
		this.refreshSelection(previous);
	}

	setExpanded(expand: boolean): void {
		if (!this.selection) return;
		const slot = this.slotAt(this.selection);
		if (!slot?.foldable) return;
		this.expandSlot(slot, expand);
		this.refreshSelection();
	}

	toggleExpanded(): boolean {
		const target = this.selection ?? this.lastFoldable();
		if (!target) return false;
		const slot = this.slotAt(target);
		if (!slot?.foldable) return false;
		this.expandSlot(slot, !slot.expanded);
		this.rerender(target.row);
		return true;
	}

	private lastFoldable(): { row: number; slot: number } | undefined {
		for (let row = this.rows.length - 1; row >= 0; row--) {
			const slots = (this.rows[row] as Row).slots;
			for (let slot = slots.length - 1; slot >= 0; slot--) if (slots[slot]?.foldable) return { row, slot };
		}
		return undefined;
	}

	open(): void {
		const block = this.selectedBlock();
		if (block?.kind === "subagent") this.onOpen?.(block.progress);
		else this.toggleExpanded();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "up")) this.move(-1);
		else if (matchesKey(data, "down")) this.move(1);
		else if (matchesKey(data, "right")) this.setExpanded(true);
		else if (matchesKey(data, "left")) this.setExpanded(false);
		else if (matchesKey(data, "enter")) this.open();
		else if (matchesKey(data, "space") || matchesKey(data, "escape")) this.blur();
	}
}

/** A centered modal: a component shown through `showOverlay` that also owns pointer events outside its window (a click there cancels it). */
export interface Modal extends Component {
	readonly animating: boolean;
	cancel(): void;
	animate?(tick: number): void;
}

type ModalTarget = { readonly component: Modal; readonly bounds: () => OverlayBounds | undefined };

/**
 * pi-tui hands pointer events that miss every overlay to the base layout; while a modal is open they go to the modal instead,
 * with coordinates relative to its window, so it can cancel on an outside click and keep the chat beneath inert.
 */
export class ModalAltScreen extends TuiAltScreen {
	modal: ModalTarget | undefined;
	navigationPane: TodoPane | undefined;

	override addInputListener(listener: TuiInputListener): () => void {
		// The base constructor registers viewport navigation before application listeners.
		return super.addInputListener((data) => {
			const pane = this.navigationPane;
			if (pane?.focused && !this.hasOverlay() && (["home", "end", "pageUp", "pageDown"] as const).some((key) => matchesKey(data, key))) {
				if (!isKeyRelease(data)) pane.handleInput(data);
				this.requestRender();
				return { consume: true };
			}
			return listener(data);
		});
	}

	protected override dispatchMouseToOverlay(event: TuiMouseEvent) {
		const hit = super.dispatchMouseToOverlay(event);
		const modal = this.modal;
		if (hit.hit || modal === undefined) return hit;
		const bounds = modal.bounds();
		if (bounds === undefined) return hit;
		const outcome = modal.component.handleMouse?.({ ...event, x: event.screenX - bounds.col, y: event.screenY - bounds.row, width: bounds.width, height: bounds.height });
		if (outcome === undefined || !(outcome.handled || outcome.capture || outcome.focus)) return { hit: true };
		const result: NonNullable<typeof hit.result> = {
			...outcome,
			handled: true,
			target: { component: modal.component, originX: bounds.col, originY: bounds.row, width: bounds.width, height: bounds.height },
		};
		return { hit: true, result };
	}
}

export type ScreenInfo = { thread: string; cwd: string; branch?: string; model: string; toolMode: string; contextWindow?: number; version: string; thinkingLevel?: ModelThinkingLevel; supportedThinkingLevels?: readonly ModelThinkingLevel[]; fast?: boolean; fastSupported?: boolean };
export type ScreenMode = "prompt" | "transcript" | "todo" | "takeover";
export type TakeoverSource = { state: ChatState; progress: () => SubagentProgress | undefined; header: () => HeaderInfo };

/** The welcome layout: the mascot and the text column sit side by side from 90 columns, stacked below that. */
const WELCOME_WIDE_MIN_WIDTH = 90;
/** The wide block starts this far past the page margin; the text column follows the mascot after the gap. */
const WELCOME_INSET = 2;
const WELCOME_GAP = 4;
const WORDMARK = "dinobot";
const PRODUCT_LINE = "Team agent in your terminal";
const WELCOME_RULE = ". . --- . --- . .";

const WELCOME_MENU: readonly FooterHint[] = [
	["/new", "New thread"],
	["/thread <name>", "Switch thread"],
	["/sessions", "Browse sessions"],
	["/setup", "Set up channels & features"],
	["ctrl+d", "Quit"],
];

const colorMode = getTerminalColorMode();

/** Paints each character with its own point on the brand gradient (mint -> indigo, left to right), like the mascot's body. */
function gradientText(text: string): string {
	const chars = [...text];
	const span = Math.max(1, chars.length - 1);
	return `${chars.map((char, index) => `${foregroundAnsi(brandGradient(index / span), colorMode)}${char}`).join("")}${ansi.fgReset}`;
}

/**
 * The welcome screen (Dinobot Signal): the idle mascot beside a text column (gradient wordmark + version, the product
 * line, an ASCII rule, the command menu, then the model note) from 90 columns; the small mascot centered over the same
 * copy below that.
 */
export function renderWelcome(info: ScreenInfo, width: number): string[] {
	const wordmark = `${bold(gradientText(WORDMARK))}  ${color.gray(info.version)}`;
	const product = color.textSecondary(PRODUCT_LINE);
	const rule = color.grayDim(WELCOME_RULE);
	const note = color.gray(`${info.model}${separator.meta}${info.toolMode}`);
	const keyWidth = Math.max(...WELCOME_MENU.map(([key]) => visibleWidth(key)));
	const menu = WELCOME_MENU.map(([key, label]) => `${color.accentSystem(pad(key, keyWidth))}  ${color.gray(label)}`);
	const fit = (line: string, textWidth: number): string => truncateToWidth(line, textWidth, glyph.ellipsis);
	if (width >= WELCOME_WIDE_MIN_WIDTH) {
		const mascot = renderMascot("idle", 2);
		const left = spacing.margin + WELCOME_INSET;
		const textLeft = left + MASCOT_SIZE[2].cols + WELCOME_GAP;
		const textWidth = Math.max(1, width - textLeft - spacing.margin);
		const column = ["", wordmark, product, rule, "", ...menu];
		const rows = Math.max(mascot.length, column.length);
		return [
			"",
			"",
			...Array.from({ length: rows }, (_, row) => `${" ".repeat(left)}${mascot[row] ?? " ".repeat(MASCOT_SIZE[2].cols)}${" ".repeat(WELCOME_GAP)}${fit(column[row] ?? "", textWidth)}`),
			"",
			`${" ".repeat(textLeft)}${fit(note, textWidth)}`,
		];
	}
	const mascot = renderMascot("idle", 1);
	const block = [wordmark, product, rule, "", ...menu, "", note];
	const blockWidth = Math.min(Math.max(...block.map(visibleWidth)), Math.max(1, width - spacing.margin * 2));
	const blockLeft = Math.max(spacing.margin, Math.floor((width - blockWidth) / 2));
	const mascotLeft = Math.max(0, Math.floor((width - MASCOT_SIZE[1].cols) / 2));
	return ["", "", ...mascot.map((line) => `${" ".repeat(mascotLeft)}${line}`), "", ...block.map((line) => `${" ".repeat(blockLeft)}${fit(line, blockWidth)}`)];
}

/** Fixed single rows of the main layout: top blank, header, gap, cut marker, blank, footer, bottom blank. */
const CHROME_ROWS = 7;
const MIN_TRANSCRIPT_ROWS = 4;
const NO_HANDLES: ReadonlySet<string> = new Set();

/** A node of the shown DAG run spins and counts elapsed time even when no turn is active. */
const dagRunning = (data: ChatState["data"]): boolean => {
	const dag = data.dag;
	return dag !== null && ((dag.research?.status === "running" || dag.research?.status === "cancelling") ||
		dag.nodes.some((node) => displayState(dag, node, data) === "running"));
};

/** Completed execution collapses only without an independent research outcome to display. */
const dagFinished = (data: ChatState["data"]): boolean => {
	const dag = data.dag;
	return dag !== null && dag.research === undefined && dag.nodes.length > 0 && dag.nodes.every((node) => node.state === "succeeded");
};

/**
 * Owns the TuiAltScreen layout: header, gap row, transcript, turn status, clip marker, dock, the work deck on the prompt
 * box (DAG pane, then the TODO/Plan caption or its focused pane), prompt box, footer, overlays, takeover.
 */
export class Screen {
	readonly tui: ModalAltScreen;
	readonly prompt: PromptBox;
	readonly transcript: Transcript;
	readonly todoPane: TodoPane;
	readonly dagPane: DagPane;
	readonly scroll: ScrollView;
	private readonly root: VStack;
	private readonly header: Region;
	private readonly gap: Region;
	private readonly pinned: Region;
	private readonly status: Region;
	private readonly below: Region;
	private readonly dock: Region;
	private readonly queue: Region;
	private readonly footer: Region;
	private readonly update: Region;
	private updateInfo: UpdateInfo | null = null;
	private overlay: OverlayHandle | undefined;
	private modals: { component: Modal; handle: OverlayHandle }[] = [];
	private takeover: { source: TakeoverSource; root: Component; transcript: Transcript; unsubscribe: () => void } | undefined;
	private viewState: ViewState = initialView;
	private tick = 0;
	private stopped = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private unsubscribe: () => void;

	constructor(
		terminal: Terminal,
		private state: ChatState,
		readonly info: ScreenInfo,
	) {
		this.tui = new ModalAltScreen(terminal, true, undefined, {
			mouse: true,
			scrollToEndIndicator: () => (this.transcript.selected === undefined && this.takeover === undefined ? color.gray(` ${glyph.disclosureOpen} jump to end `) : ""),
		});
		this.prompt = new PromptBox(this.tui);
		this.prompt.caption = promptCaption(info.model, info.toolMode);
		this.transcript = new Transcript(state);
		this.transcript.setToolsExpanded(this.viewState.tools);
		this.transcript.welcome = () => renderWelcome(info, this.tui.terminal.columns);
		this.transcript.onSelect = (range) => this.ensureVisible(range);
		this.transcript.onBlur = () => this.focusPrompt();
		this.transcript.fillTo = () => this.scroll.viewportHeight;
		this.transcript.viewport = () => this.viewport();
		this.todoPane = new TodoPane(
			() => ({ todos: this.state.data.todos, version: this.state.data.todosVersion }),
			() => this.tui.terminal.rows,
			() => ({ workflow: this.state.data.workflow, version: this.state.data.workflowVersion }),
			// A focused pane is sized before the DAG body and may use the transcript's reserve down to one row; the DAG keeps its title row.
			() => Math.max(1, this.paneRoom() + MIN_TRANSCRIPT_ROWS - 1 - (this.dagPane.visible ? 1 : 0) - this.dockMinimum()),
		);
		this.todoPane.onClose = () => this.toggleTodoPane();
		this.tui.navigationPane = this.todoPane;
		this.dagPane = new DagPane(
			() => ({ dag: this.state.data.dag, version: this.state.data.dagVersion }),
			() => this.tui.terminal.rows,
			() => ({ subagents: this.state.data.subagents, asks: this.state.data.asks, tick: this.tick, now: Date.now() }),
			// At rest the caption is the one row this leaves; a focused pane takes its rows first; a finished run keeps its title only.
			() => (dagFinished(this.state.data) ? 1 : Math.max(1, this.paneRoom() - this.todoPane.render(this.tui.terminal.columns).length - this.dockMinimum())),
		);
		this.scroll = new ReflowScrollView(this.transcript, { follow: "end" });
		this.header = new Region((width) => [renderHeader(this.headerInfo(), width)], () => JSON.stringify(this.headerInfo()));
		this.gap = new Region(
			(width) => {
				if ((this.welcome && !this.dagPane.visible) || this.todoPane.visible) return [];
				// The scroll view keeps its last column for the scrollbar, so the corners follow the transcript's frame one column in.
				if (this.cornerOnGap()) return [`${frameLead}${color.selectionBorder(square.tl)}${" ".repeat(contentArea(width - 1))}${color.selectionBorder(square.tr)}`];
				return [this.clip().above && this.pinnedId() === undefined ? centered(glyph.cutAbove, width) : ""];
			},
			() => `${this.welcome}:${this.dagPane.visible}:${this.todoPane.visible}:${this.cornerOnGap()}:${this.clip().above}:${this.pinnedId()}`,
		);
		this.pinned = new Region(
			(width) => {
				const pinned = this.transcript.pinnedHeader(this.scroll.scrollTop);
				return pinned === undefined ? [] : [...pinned.lines, centered(glyph.cutAbove, width)];
			},
			() => `${this.pinnedId()}`,
		);
		this.status = new Region(
			(width) => [
				...renderTurnStatus({ run: this.state.data.run, tick: this.tick, now: Date.now(), contextTokens: this.state.data.usage.contextTokens, runningSubagents: runningSubagents(this.state.data).length, ...(this.state.data.metrics.call ? { metrics: this.state.data.metrics.call } : {}) }, width),
			],
			() => `${this.state.data.run ? this.tick : "idle"}:${this.state.data.revision}`,
		);
		this.below = new Region(
			(width) => [this.clip().below ? centered(glyph.cutBelow, width) : ""],
			() => `${this.clip().below}`,
		);
		this.dock = new Region(
			(width) => {
				const lines = renderRoster([...this.state.data.subagents.values()], width - spacing.margin * 2, this.tick, Date.now(), this.dockHidden());
				const shown = lines.length + 1 <= this.dockRoom() ? [...lines, ""] : lines.slice(0, 1);
				return shown.map((line) => (line === "" ? "" : `${" ".repeat(spacing.margin)}${line}`));
			},
			() => `${this.state.data.subagentsVersion}:${this.state.data.dagVersion}:${[...this.dockHidden()].join(",")}:${this.tui.terminal.columns}x${this.tui.terminal.rows}:${this.dockRoom()}:${runningSubagents(this.state.data).length > 0 ? this.tick : "rest"}:${this.state.data.run ? "run" : "idle"}`,
		);
		this.queue = new Region(
			(width) => renderQueue(this.state.data.queue, width, this.tui.terminal.rows),
			() => `${JSON.stringify(this.state.data.queue)}:${this.tui.terminal.rows}`,
		);
		this.update = new Region(width => renderUpdateNotice(this.updateInfo, width), () => JSON.stringify(this.updateInfo));
		this.footer = new Region((width) => [this.footerLine(width)], () => this.footerKey());
		this.root = new VStack([
			{ component: blankRow(), shrink: 0 },
			{ component: this.header, shrink: 0 },
			{ component: this.gap, shrink: 0 },
			{ component: this.pinned, shrink: 0 },
			{ component: this.scroll, basis: 0, grow: 1, shrink: 1 },
			{ component: this.status, shrink: 0 },
			{ component: this.below, shrink: 0 },
			{ component: this.dock, shrink: 0 },
			{ component: this.dagPane, shrink: 0 },
			{ component: this.todoPane, shrink: 0 },
			{ component: this.queue, shrink: 0 },
			{ component: this.update, shrink: 0 },
			{ component: this.prompt, shrink: 0 },
			{ component: blankRow(), shrink: 0 },
			{ component: this.footer, shrink: 0 },
			{ component: blankRow(), shrink: 0 },
		]);
		this.tui.setLayoutRoot(this.root);
		this.unsubscribe = state.subscribe(() => this.onStateChange());
		this.updateCaption();
	}

	setUpdateNotice(info: UpdateInfo | null): void {
		if (this.stopped) return;
		this.updateInfo = info;
		this.requestRender();
	}

	get welcome(): boolean {
		return this.state.data.blocks.length === 0 && this.state.data.run === undefined;
	}

	get mode(): ScreenMode {
		if (this.takeover) return "takeover";
		const focused = this.tui.getFocusedComponent();
		if (focused === this.transcript) return "transcript";
		if (focused === this.todoPane) return "todo";
		return "prompt";
	}

	/** After a theme switch: drop every cached row so the transcript, chrome and welcome mascot repaint in the new colors. */
	restyle(): void {
		this.tui.invalidate();
		this.tui.requestRender(true);
	}

	bind(state: ChatState): void {
		this.unsubscribe();
		this.state = state;
		this.transcript.bind(state);
		this.todoPane.reset();
		this.dagPane.invalidate();
		if (this.mode === "todo") this.focusPrompt();
		// Version counters belong to a conversation, including hidden panes and dock regions.
		this.root.invalidate();
		this.unsubscribe = state.subscribe(() => this.onStateChange());
		this.onStateChange();
	}

	start(): void {
		this.tui.start();
		this.focusPrompt();
		this.tui.requestRender();
		setTimeout(() => this.tui.requestRender(), 0);
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		for (const entry of [...this.modals].reverse()) entry.component.cancel();
		this.stopTicker();
		this.unsubscribe();
		this.takeover?.unsubscribe();
		// Restore the shell screen without dumping the viewport into its scrollback.
		this.tui.stop({ preserveScreen: true });
	}

	requestRender(): void {
		this.tui.requestRender();
	}

	focusPrompt(): void {
		if (this.takeover) return;
		this.tui.setFocus(this.prompt);
		this.scroll.scrollToEnd();
		this.tui.requestRender();
	}

	focusTranscript(): void {
		const transcript = this.takeover?.transcript ?? this.transcript;
		transcript.focus();
		this.tui.setFocus(transcript);
		this.tui.requestRender();
	}

	toggleFocus(): void {
		if (this.mode === "transcript") {
			this.transcript.blur();
			return;
		}
		if (this.mode === "todo") {
			this.focusPrompt();
			return;
		}
		this.focusTranscript();
	}

	/**
	 * Ctrl+T: the framed pane takes keyboard focus (a pane without content is opened explicitly and shows its placeholder);
	 * a focused pane collapses back to the caption, or to no row once it has nothing to show.
	 */
	toggleTodoPane(): void {
		if (this.takeover) return;
		if (this.todoPane.focused) {
			this.focusPrompt();
			return;
		}
		this.todoPane.visible = true;
		this.tui.setFocus(this.todoPane);
		this.tui.requestRender();
	}

	/** The cheatsheet overlay is the effect of `view.shortcuts`; its own Esc/q/Ctrl+X close sets the state back. */
	private showShortcuts(open: boolean): void {
		if (!open) {
			this.overlay?.hide();
			this.overlay = undefined;
			return;
		}
		const size = () => ({ cols: this.tui.terminal.columns, rows: this.tui.terminal.rows });
		const sections = this.reasoningUsable && this.mode === "prompt" && this.prompt.answer === undefined && !this.prompt.menuOpen && !this.inTakeover
			? [{ title: "Reasoning · next model request", rows: [["Cycle reasoning", "Shift+Tab"]] as const }, ...SHORTCUT_SECTIONS]
			: SHORTCUT_SECTIONS;
		const component = new ShortcutsOverlay(() => this.setView("shortcuts", false), { size, sections });
		this.overlay = this.tui.showOverlay(component, shortcutsOverlayOptions(size()));
	}

	/** The topmost modal (a picker over a login card, say); keyboard focus follows it. */
	get modal(): Modal | undefined {
		return this.modals.at(-1)?.component;
	}

	modalBounds(): OverlayBounds | undefined {
		return this.modals.at(-1)?.handle.getBounds();
	}

	size(): { cols: number; rows: number } {
		return { cols: this.tui.terminal.columns, rows: this.tui.terminal.rows };
	}

	openModal(component: Modal, options: OverlayOptions): void {
		const handle = this.tui.showOverlay(component, options);
		this.modals.push({ component, handle });
		this.tui.modal = { component, bounds: () => handle.getBounds() };
		this.syncTicker();
		this.tui.requestRender();
	}

	closeModal(component: Modal): void {
		const index = this.modals.findIndex((entry) => entry.component === component);
		if (index < 0) return;
		const [entry] = this.modals.splice(index, 1);
		entry?.handle.hide();
		const top = this.modals.at(-1);
		this.tui.modal = top === undefined ? undefined : { component: top.component, bounds: () => top.handle.getBounds() };
		this.syncTicker();
		this.tui.requestRender();
	}

	get view(): ViewState {
		return this.viewState;
	}

	get toolsExpanded(): boolean {
		return this.viewState.tools;
	}

	/** The only writer of the view state; each changed coordinate runs its effect once, an unchanged one is a no-op. */
	setView(key: ViewToggle, value: boolean): void {
		const next = setView(this.viewState, key, value);
		if (next === this.viewState) return;
		this.viewState = next;
		for (const transcript of this.transcripts()) {
			if (key === "tools") transcript.setToolsExpanded(value);
			if (key === "thinking") transcript.setThinkingExpanded(value);
		}
		if (key === "shortcuts") this.showShortcuts(value);
		this.tui.requestRender();
	}

	toggleView(key: ViewToggle): void {
		this.setView(key, !this.viewState[key]);
	}

	setToolsExpanded(expand: boolean): void {
		this.setView("tools", expand);
	}

	private transcripts(): Transcript[] {
		return this.takeover === undefined ? [this.transcript] : [this.transcript, this.takeover.transcript];
	}

	openTakeover(source: TakeoverSource): void {
		this.closeTakeover();
		const transcript = new Transcript(source.state);
		transcript.setToolsExpanded(this.viewState.tools);
		transcript.setThinkingExpanded(this.viewState.thinking);
		transcript.onOpen = (progress) => this.transcript.onOpen?.(progress);
		const header = new Region((width) => ["", renderHeader(source.header(), width), ""], () => JSON.stringify(source.header()));
		const view = createTakeoverView({
			progress: source.progress,
			header,
			transcript,
			footer: () => this.footerText(),
			tick: () => this.tick,
			now: () => Date.now(),
		});
		transcript.fillTo = () => view.scroll.viewportHeight - view.headerRows();
		transcript.viewport = () => ({ top: view.scroll.scrollTop - view.headerRows(), height: view.scroll.viewportHeight });
		// The child's own DAG run (A8): fixed above the frame, hidden while the child has none.
		const childDag = new DagPane(
			() => ({ dag: source.state.data.dag, version: source.state.data.dagVersion }),
			() => this.tui.terminal.rows,
			() => ({ subagents: source.state.data.subagents, asks: source.state.data.asks, tick: this.tick, now: Date.now() }),
		);
		const root = new VStack([
			{ component: new Region(() => (childDag.visible ? [""] : []), () => `${childDag.visible}`), shrink: 0 },
			{ component: childDag, shrink: 0 },
			{ component: view.root, basis: 0, grow: 1, shrink: 1 },
		]);
		const unsubscribe = source.state.subscribe(() => {
			this.syncTicker();
			this.tui.requestRender();
		});
		this.takeover = { source, root, transcript, unsubscribe };
		this.tui.setLayoutRoot(root);
		transcript.focus();
		this.tui.setFocus(transcript);
		this.syncTicker();
		this.tui.requestRender();
		setTimeout(() => this.tui.requestRender(), 0);
	}

	closeTakeover(): void {
		if (!this.takeover) return;
		this.takeover.unsubscribe();
		this.takeover = undefined;
		this.tui.setLayoutRoot(this.root);
		this.focusPrompt();
		this.syncTicker();
		this.tui.requestRender();
	}

	get inTakeover(): boolean {
		return this.takeover !== undefined;
	}

	/**
	 * Enter sends the queued input now and ↓ takes the newest back (ADR 0036) only while the prompt is focused and empty,
	 * no slash menu or command answer is open, and something is queued; otherwise both keep their editor meaning.
	 */
	get queueKeys(): boolean {
		return this.mode === "prompt" && this.prompt.answer === undefined && !this.prompt.menuOpen && this.prompt.getText() === "" && this.state.data.queue.length > 0;
	}

	/** The thread's model changed (`/model`, or a fresh attach): the prompt caption and the welcome note follow. */
	setModel(model: string): void {
		this.setModelState({ model });
	}

	private reasoningEnabled = false;

	get reasoningUsable(): boolean {
		return this.reasoningEnabled && this.info.thinkingLevel !== undefined && (this.info.supportedThinkingLevels?.length ?? 0) > 1;
	}

	setReasoningEnabled(enabled: boolean): void {
		this.reasoningEnabled = enabled;
		this.tui.requestRender();
	}

	/** A fresh attach: reasoning and fast state stay unknown until the daemon reports them for this thread. */
	resetReasoning(): void {
		delete this.info.thinkingLevel;
		delete this.info.supportedThinkingLevels;
		delete this.info.fast;
		delete this.info.fastSupported;
		this.updateCaption();
	}

	setReasoning(state: { thinkingLevel?: ModelThinkingLevel; supportedThinkingLevels?: readonly ModelThinkingLevel[] }): void {
		this.setModelState(state);
	}

	setModelState(state: { model?: string; thinkingLevel?: ModelThinkingLevel; supportedThinkingLevels?: readonly ModelThinkingLevel[]; fast?: boolean; fastSupported?: boolean }): void {
		if (state.model !== undefined) {
			if (state.model !== this.info.model) {
				delete this.info.thinkingLevel;
				delete this.info.supportedThinkingLevels;
				delete this.info.fast;
				delete this.info.fastSupported;
			}
			this.info.model = state.model;
		}
		if (state.thinkingLevel !== undefined) this.info.thinkingLevel = state.thinkingLevel;
		if (state.supportedThinkingLevels !== undefined) this.info.supportedThinkingLevels = state.supportedThinkingLevels;
		if (state.fast !== undefined) this.info.fast = state.fast;
		if (state.fastSupported !== undefined) this.info.fastSupported = state.fastSupported;
		this.updateCaption();
	}

	private updateCaption(): void {
		const level = this.info.thinkingLevel;
		const levels = this.info.supportedThinkingLevels;
		const reasoning = level === undefined ? "reasoning unknown" : levels?.length === 0 ? "reasoning unavailable" : levels !== undefined && levels.length === 1
			? level === "off" ? "reasoning unsupported" : `reasoning ${level} (locked)`
			: `reasoning ${level}`;
		this.prompt.caption = promptCaption(this.info.model, this.info.toolMode, reasoning, this.info.fast === true && this.info.fastSupported !== false);
		this.prompt.invalidate();
		this.tui.requestRender();
	}

	private headerInfo(): HeaderInfo {
		const data = this.state.data;
		return {
			...(this.info.branch === undefined ? {} : { branch: this.info.branch }),
			cwd: data.agent.cwd ?? this.info.cwd,
			used: data.usage.contextTokens,
			...(this.info.contextWindow === undefined ? {} : { window: this.info.contextWindow }),
			thread: this.info.thread,
			welcome: this.welcome,
		};
	}

	private viewport(): Viewport {
		return { top: this.scroll.scrollTop, height: this.scroll.viewportHeight };
	}

	private clip(): { above: boolean; below: boolean } {
		return this.transcript.clipState(this.viewport());
	}

	private cornerOnGap(): boolean {
		return this.transcript.cornerOnGap && this.scroll.scrollTop === 0;
	}

	private pinnedId(): string | undefined {
		return this.welcome ? undefined : this.transcript.pinnedHeader(this.scroll.scrollTop)?.id;
	}

	/**
	 * A7: a live dock row is dropped only when its child already has a visible, expanded DAG node row that runs or
	 * settles in a running run. Children folded into summaries, and every child of a terminal run, keep their dock row;
	 * the roster's counts still cover every subagent. /agents lists them all.
	 */
	private dockHidden(): ReadonlySet<string> {
		const data = this.state.data;
		const dag = data.dag;
		const rows = this.dagPane.bodyRows();
		if (dag === null || dag.status !== "running" || rows < 1) return NO_HANDLES;
		const handles = new Set<string>();
		for (const item of foldRows(dag, rows, data)) {
			if (item.kind !== "node" || item.node.handle === undefined) continue;
			const state = displayState(dag, item.node, data);
			if (state === "running" || state === "settling") handles.add(item.node.handle);
		}
		return handles;
	}

	/**
	 * A8: rows the work deck and the dock may share so the prompt, the footer and a transcript of at least
	 * MIN_TRANSCRIPT_ROWS rows stay on screen. At rest the DAG pane is sized first, then the one-row caption, then the
	 * dock; a focused TODO/Plan pane is sized before the DAG body and may borrow the transcript's reserve down to one row.
	 */
	private paneRoom(): number {
		const width = this.tui.terminal.columns;
		const used = CHROME_ROWS + this.update.render(width).length + this.queue.render(width).length + this.prompt.render(width).length + this.status.render(width).length + this.pinned.render(width).length;
		return this.tui.terminal.rows - used - MIN_TRANSCRIPT_ROWS;
	}

	/** The dock's one-line summary is mandatory while any subagent exists, so the deck below leaves room for it. */
	private dockMinimum(): number {
		return this.state.data.subagents.size > 0 ? 1 : 0;
	}

	/** What the work deck leaves for the dock; below its full roster it compacts to the one-line summary. */
	private dockRoom(): number {
		const width = this.tui.terminal.columns;
		return this.paneRoom() - this.dagPane.render(width).length - this.todoPane.render(width).length;
	}

	/** Grok's context-sensitive shortcuts bar (shortcuts_bar.rs) with dinobot's keys where they differ. */
	private footerHints(): FooterHint[] {
		const transcript = this.takeover?.transcript ?? this.transcript;
		const thinking: FooterHint = ["Ctrl+e", this.viewState.thinking ? "collapse thinking" : "expand thinking"];
		const shortcuts: FooterHint = ["Ctrl+x", "shortcuts"];
		const details: FooterHint = ["Ctrl+o", this.toolsExpanded ? "compact tools" : "expand tools"];
		switch (this.mode) {
			case "takeover":
				return [["q/Esc", "back"], ["Enter", "open"], details, thinking, shortcuts];
			case "todo":
				return [...(this.todoPane.switchable() ? [["←/→", "plan / todo"] as FooterHint] : []), ["h", "hide done"], shortcuts];
			case "transcript": {
				const info = transcript.selectionInfo();
				const fold: FooterHint[] = info?.foldable ? [info.expanded ? ["←", "collapse"] : ["→", "expand"]] : [];
				return [...fold, ["Enter", "open"], details, thinking, shortcuts];
			}
			case "prompt":
				if (this.prompt.answer !== undefined) return [["Enter", "answer"], ["Esc", "cancel"], shortcuts];
				if (this.prompt.menuOpen) return [["↑/↓", "select"], ["Tab", "complete"], ["Enter", "accept"], ["Esc", "close"], shortcuts];
				const reasoning: FooterHint[] = this.reasoningUsable ? [["Shift+Tab", "reasoning"]] : [];
				if (this.prompt.getText() !== "") return [["Enter", this.state.data.run ? "steer" : "send"], ...reasoning, ["Shift+Enter", "newline"], ["Tab", "transcript"], shortcuts];
				if (this.queueKeys) return [["Enter", "send now"], ["↓", "edit queued"], ...reasoning, ["Tab", "transcript"], ...(this.state.data.run ? [["Esc", "cancel"] as FooterHint] : []), details, shortcuts];
				if (this.state.data.run) return [...reasoning, ["Tab", "transcript"], ["Esc", "cancel"], details, shortcuts];
				return [...reasoning, ["Tab", "transcript"], details, shortcuts];
		}
	}

	private footerKey(): string {
		const transcript = this.takeover?.transcript ?? this.transcript;
		const info = transcript.selectionInfo();
		return `${this.reasoningUsable}:${this.mode}:${this.prompt.getText() === ""}:${this.prompt.menuOpen}:${this.prompt.answer?.type}:${this.state.data.run !== undefined}:${this.welcome}:${this.modals.length}:${info?.foldable}:${info?.expanded}:${this.viewState.tools}:${this.viewState.thinking}:${this.viewState.shortcuts}:${this.mode === "todo" && this.todoPane.switchable()}:${this.queueKeys}`;
	}

	private footerText(): string {
		return renderFooter(this.footerHints(), 10_000).trimStart();
	}

	/** Grok hides the shortcuts bar while the cheatsheet or a modal is open and shows the version line on the welcome screen. */
	private footerLine(width: number): string {
		if (this.viewState.shortcuts || this.modals.length > 0) return "";
		if (this.welcome && this.mode === "prompt") {
			const text = color.gray(`dinobot  ${this.info.version}`);
			return `${" ".repeat(Math.max(0, width - spacing.margin - visibleWidth(text)))}${text}`;
		}
		return renderFooter(this.footerHints(), width);
	}

	/** Scrolls the selection box into view; an entry taller than the viewport keeps its top visible (Grok clips the rest with `┆` / `▼`). */
	private ensureVisible(range: { start: number; end: number } | undefined): void {
		if (!range) {
			this.scroll.scrollToEnd();
			return;
		}
		const viewport = this.scroll.viewportHeight;
		const top = this.scroll.scrollTop;
		if (range.start < top) this.scroll.scrollTo(range.start, { disableFollow: true });
		else if (range.end > top + viewport && range.end - range.start <= viewport) this.scroll.scrollTo(range.end - viewport, { disableFollow: true });
		else this.scroll.scrollTo(top, { disableFollow: true });
		this.tui.requestRender();
	}

	private onStateChange(): void {
		this.syncTicker();
		this.tui.requestRender();
	}

	private animated(): boolean {
		const data = this.state.data;
		const child = this.takeover?.source.state.data;
		return data.run !== undefined || runningSubagents(data).length > 0 || dagRunning(data) || (child !== undefined && (child.run !== undefined || runningSubagents(child).length > 0 || dagRunning(child))) || this.modals.some((entry) => entry.component.animating);
	}

	private syncTicker(): void {
		if (this.animated()) this.startTicker();
		else this.stopTicker();
	}

	private startTicker(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.tick += 4;
			this.transcript.animate(this.tick);
			this.takeover?.transcript.animate(this.tick);
			for (const entry of this.modals) entry.component.animate?.(this.tick);
			this.tui.requestRender();
		}, TICK_MS * 4);
	}

	private stopTicker(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}
}
