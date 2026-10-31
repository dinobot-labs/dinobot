import { fuzzyMatch, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CommandArgument, CommandInfo } from "../commands/types.ts";
import type { ResearchView } from "../core/ui-contract.ts";
import { formatBytes, formatReferenceValue, type WorkspaceEntry } from "./context-refs.ts";
import { bold, color, glyph, pad, paint, spacing } from "./theme.ts";

/** Untrusted mission/report text must never control the terminal. */
export const researchText = (text: string): string =>
	stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();

export function researchReportState(mission: ResearchView): string {
	const report = mission.report;
	return `${researchText(report.state)}${report.writtenRevision !== mission.revision ? " (lagging)" : ""}${report.error ? `: ${researchText(report.error)}` : ""}`;
}

/** Stable, namespaced picker IDs; lineage never masquerades as an execution dependency. */
export function researchPickerOptions(mission: ResearchView): Array<{ id: string; label: string; description: string; group: string }> {
	return [
		{ id: "research:mission", label: `Mission · ${researchText(mission.status)} · ${researchText(mission.question)}`, description: `Outcome: ${researchText(mission.judgment ?? "unknown")}`, group: "Research" },
		{ id: "research:report", label: `Report · ${researchReportState(mission)}`, description: researchText(mission.report.directory), group: "Research" },
		...mission.candidates.map((candidate) => ({
			id: `research:candidate:${candidate.id}`,
			label: `${researchText(candidate.id)} · ${researchText(candidate.state)} · ${researchText(candidate.hypothesis)}`,
			description: researchText(`Lineage: ${candidate.parentId ?? "root"} -> ${candidate.id} (${candidate.operation}) · ${candidate.validity ?? "unknown"} · ${candidate.verdict ?? "inconclusive"}`),
			group: "Candidate lineage (not execution edges)",
		})),
	];
}

export function researchDetails(mission: ResearchView, id: string): string | undefined {
	if (id === "research:mission") return [
		`Mission ${mission.id} · revision ${mission.revision}`, `Question: ${mission.question}`,
		`Status: ${mission.status} · Outcome: ${mission.judgment ?? "unknown"}`, `Stop reason: ${mission.stopReason ?? "none"}`,
		`Attempts ${mission.attempts.used}/${mission.attempts.limit} · rounds ${mission.rounds.used}/${mission.rounds.limit}`,
		`Candidates ${mission.candidateBudget.used}/${mission.candidateBudget.limit} · active ${mission.activeAttempts}/${mission.maxConcurrent} · confirmation reserved ${mission.confirmationReserved}`,
		`Incumbent: ${mission.incumbentId ?? "none"} · selected: ${mission.selectedId ?? "none"}`,
		`Report: ${mission.report.directory} · ${researchReportState(mission)}`,
	].map(researchText).join("\n");
	if (!id.startsWith("research:candidate:")) return undefined;
	const candidate = mission.candidates.find((entry) => `research:candidate:${entry.id}` === id);
	if (!candidate) return undefined;
	return [
		`Candidate ${candidate.id} · ${candidate.state}`, `Hypothesis: ${candidate.hypothesis}`,
		`Lineage: ${candidate.parentId ?? "root"} -> ${candidate.id} · operation ${candidate.operation}`,
		`Result: ${candidate.value ?? "unknown"} ${candidate.unit ?? ""} · delta ${candidate.delta ?? "unknown"}`,
		`Validity: ${candidate.validity ?? "unknown"} · verdict ${candidate.verdict ?? "inconclusive"}`,
		`Feedback: ${candidate.feedback || "none"}`, `Execution: run ${candidate.runId ?? "none"} · node ${candidate.nodeId ?? "none"}`,
	].map(researchText).join("\n");
}

export type ResearchReportContext = {
	channel: string;
	thread: string;
	client: { researchReport?(channel: string, thread: string, missionId: string, file?: string): Promise<string> };
};

/** Read through the contained API, never a shell command or file URI. */
export async function readResearchReport(context: ResearchReportContext, missionId: string): Promise<string> {
	if (!context.client.researchReport) throw new Error("Research report viewing is unavailable");
	const content = await context.client.researchReport(context.channel, context.thread, missionId, "report.md");
	return content.split(/\r?\n/).map(researchText).join("\n");
}

/** Commands the TUI runs itself; they never reach the daemon but show in the dropdown and in /help. */
export const LOCAL_COMMANDS: readonly CommandInfo[] = [
	{ name: "agents", description: "Open a subagent's conversation", usage: "[id]" },
	{ name: "choose", description: "Answer the open question with choices" },
	{ name: "dag", description: "Show the DAG run's nodes" },
	{ name: "new", description: "Start a new thread", usage: "[name]" },
	{ name: "quit", description: "Quit dinobot" },
	{ name: "sessions", description: "Browse live sessions and attach a conversation" },
	{ name: "theme", description: "Pick a theme (dinosaur or DOS blue/black)", usage: "[name]" },
	{ name: "thread", description: "Switch to a thread", usage: "<name>" },
];

/** Grok's dropdown geometry (views/slash_dropdown.rs, slash/mod.rs MAX_VISIBLE_SUGGESTIONS). */
export const MAX_VISIBLE_ROWS = 8;
const LABEL_CAP = 40;
const LABEL_GAP = 2;
const PREFIX_WIDTH = 2;
const SCROLLBAR_WIDTH = 2;
const PANEL_INSET = 2;

export type DropdownRow = { readonly display: string; readonly description: string; readonly insert: string; readonly tag?: string; readonly indices: readonly number[]; readonly runnable?: boolean };
export type DropdownLayout = { readonly lines: string[]; readonly scroll: number; readonly visible: number };
export type PanelOptions = { readonly header?: readonly string[]; readonly count?: number; readonly maxRows?: number };

const margin = " ".repeat(spacing.margin);
/** pi-tui wraps its ellipsis in `\x1b[0m`, which would end the row's background band, so the resets go. */
const clip = (text: string, width: number): string => truncateToWidth(text, width, glyph.ellipsis).replaceAll("\x1b[0m", "");

function matchIndices(query: string, text: string): number[] {
	const haystack = text.toLowerCase();
	const indices: number[] = [];
	let from = 0;
	for (const char of query.toLowerCase()) {
		const at = haystack.indexOf(char, from);
		if (at === -1) return [];
		indices.push(at);
		from = at + 1;
	}
	return indices;
}

export type Hit<T> = { readonly item: T; readonly indices: readonly number[] };

/** pi-tui's fuzzy score (lower is better) on `textOf`, then on `fallbackOf` without highlights; an empty query keeps every item in order. */
export function rank<T>(items: readonly T[], query: string, textOf: (item: T) => string, fallbackOf?: (item: T) => string): Hit<T>[] {
	const trimmed = query.trim();
	if (trimmed === "") return items.map((item) => ({ item, indices: [] }));
	const hits: { item: T; indices: number[]; score: number; tier: number; text: string }[] = [];
	for (const item of items) {
		const text = textOf(item);
		let match = fuzzyMatch(trimmed, text);
		let tier = 0;
		if (!match.matches && fallbackOf !== undefined) {
			match = fuzzyMatch(trimmed, fallbackOf(item));
			tier = 1;
		}
		if (!match.matches) continue;
		hits.push({ item, indices: tier === 0 ? matchIndices(trimmed, text) : [], score: match.score, tier, text });
	}
	hits.sort((a, b) => a.score - b.score || a.tier - b.tier || a.text.localeCompare(b.text));
	return hits.map(({ item, indices }) => ({ item, indices }));
}

const tagOf = (row: DropdownRow): string => (row.tag === undefined ? "" : ` [${row.tag}]`);

/** Each name plus tag clamped at 40 columns, the widest wins, never past 60% of the row (compute_label_column_w). */
function labelColumnWidth(rows: readonly DropdownRow[], contentWidth: number): number {
	const budget = Math.min(Math.floor((contentWidth * 3) / 5), LABEL_CAP);
	let widest = 0;
	for (const row of rows) widest = Math.max(widest, Math.min(visibleWidth(row.display) + visibleWidth(tagOf(row)), LABEL_CAP));
	return Math.min(widest, budget);
}

/** `text` in text_primary with the fuzzy-matched characters at `indices` in the accent, both bold on a selected row. */
export function highlight(text: string, indices: readonly number[], selected: boolean): string {
	const plain = (run: string): string => (selected ? bold(color.textPrimary(run)) : color.textPrimary(run));
	const accent = (run: string): string => (selected ? bold(color.fuzzyAccent(run)) : color.fuzzyAccent(run));
	if (indices.length === 0) return plain(text);
	const hits = new Set(indices);
	let out = "";
	let run = "";
	let runHit = false;
	let at = 0;
	for (const char of text) {
		const hit = hits.has(at);
		if (hit !== runHit && run !== "") {
			out += runHit ? accent(run) : plain(run);
			run = "";
		}
		runHit = hit;
		run += char;
		at += char.length;
	}
	if (run !== "") out += runHit ? accent(run) : plain(run);
	return out;
}

function renderRow(row: DropdownRow, selected: boolean, labelWidth: number, rowWidth: number): string {
	const tag = truncateToWidth(tagOf(row), labelWidth, "");
	const tagWidth = visibleWidth(tag);
	const label = clip(row.display, Math.max(0, labelWidth - tagWidth));
	const padding = Math.max(0, labelWidth - visibleWidth(label) - tagWidth);
	const descriptionWidth = rowWidth - PREFIX_WIDTH - labelWidth - LABEL_GAP;
	const description = row.description !== "" && descriptionWidth > 0 ? `${" ".repeat(LABEL_GAP)}${color.gray(clip(row.description, descriptionWidth))}` : "";
	const prefix = selected ? bold(color.textPrimary(glyph.promptArrow)) : " ".repeat(PREFIX_WIDTH);
	const text = `${prefix}${highlight(label, row.indices, selected)}${" ".repeat(padding)}${tag === "" ? "" : color.accentSystem(tag)}${description}`;
	return (selected ? color.bgVisual : color.bgLight)(pad(text, rowWidth));
}

function scrollOffset(total: number, visible: number, selected: number): number {
	const half = Math.floor(visible / 2);
	if (total <= visible || selected < half) return 0;
	if (selected + half >= total) return total - visible;
	return selected - half;
}

function thumbRange(total: number, visible: number, scroll: number): { from: number; to: number } {
	const length = Math.max(1, Math.floor((visible * visible) / total));
	const top = Math.round((scroll * (visible - length)) / Math.max(1, total - visible));
	return { from: top, to: top + length };
}

/** The item rows alone, as Grok's render_dropdown draws them: selection kept centered, a 2-column scrollbar gutter past `maxRows`. */
export function renderDropdownRows(rows: readonly DropdownRow[], selected: number, width: number, maxRows = MAX_VISIBLE_ROWS): DropdownLayout {
	if (rows.length === 0 || width < 4) return { lines: [], scroll: 0, visible: 0 };
	const visible = Math.min(rows.length, maxRows);
	const scrollbar = rows.length > visible;
	const rowWidth = scrollbar ? width - SCROLLBAR_WIDTH : width;
	const labelWidth = labelColumnWidth(rows, rowWidth - PREFIX_WIDTH);
	const scroll = scrollOffset(rows.length, visible, selected);
	const thumb = scrollbar ? thumbRange(rows.length, visible, scroll) : undefined;
	const lines: string[] = [];
	for (let k = 0; k < visible; k++) {
		const row = rows[scroll + k];
		if (row === undefined) break;
		let line = renderRow(row, scroll + k === selected, labelWidth, rowWidth);
		if (thumb !== undefined) line += `${color.bgLight(" ")}${color.scrollbarTrackBg(k >= thumb.from && k < thumb.to ? color.grayDim("█") : " ")}`;
		lines.push(line);
	}
	return { lines, scroll, visible };
}

/** Grok's dropdown chrome: `─` borders inside the prompt margins with the match count on the top one, rows on bg_light inset by 2. */
export function renderDropdownPanel(rows: readonly DropdownRow[], selected: number, width: number, options: PanelOptions = {}): DropdownLayout {
	const panelWidth = width - spacing.margin * 2;
	if (panelWidth <= 4) return { lines: [], scroll: 0, visible: 0 };
	const itemsWidth = panelWidth - PANEL_INSET;
	const body = renderDropdownRows(rows, selected, itemsWidth, options.maxRows);
	const header = (options.header ?? []).flatMap((line) => wrapTextWithAnsi(line, itemsWidth)).map((line) => color.bgLight(pad(line, itemsWidth)));
	if (body.lines.length === 0 && header.length === 0) return { lines: [], scroll: 0, visible: 0 };
	const inset = color.bgLight(" ".repeat(PANEL_INSET));
	const hint = options.count === undefined ? "" : `${options.count}`;
	const top = hint === "" ? color.panelBorder("─".repeat(panelWidth)) : `${color.panelBorder("─".repeat(Math.max(0, panelWidth - hint.length - 1)))}${color.gray(hint)}${color.panelBorder("─")}`;
	const lines = [`${margin}${top}`, ...[...header, ...body.lines].map((line) => `${margin}${inset}${line}`), `${margin}${color.panelBorder("─".repeat(panelWidth))}`];
	return { lines: lines.map((line) => paint(line, width)), scroll: body.scroll, visible: body.visible };
}

export type SlashSource = {
	commands(): readonly CommandInfo[];
	/** Resolves to [] when a command has no completions; failures are reported by the source and resolve to []. */
	arguments(name: string): Promise<readonly CommandArgument[]>;
	/** `@` reference completion candidates; without it the `@` dropdown offers only the reference kinds. */
	files?(): Promise<readonly WorkspaceEntry[]>;
};

type Phase =
	| { readonly mode: "command"; readonly query: string }
	| { readonly mode: "argument"; readonly name: string; readonly query: string }
	| { readonly mode: "reference"; readonly query: string };
type ArgumentFetch = { readonly name: string; items: readonly CommandArgument[] | undefined };
type FileFetch = { items: readonly WorkspaceEntry[] | undefined };

const REFERENCE_KINDS: readonly { name: string; description: string; insert: string }[] = [
	{ name: "diff", description: "Unstaged changes (git diff)", insert: "@diff " },
	{ name: "staged", description: "Staged changes (git diff --staged)", insert: "@staged " },
	{ name: "file:", description: "File contents, optionally :start-end", insert: "@file:" },
	{ name: "folder:", description: "Directory tree listing", insert: "@folder:" },
	{ name: "git:", description: "Last N commits with patches (max 10)", insert: "@git:" },
];
const MAX_REFERENCE_ROWS = 50;

/** The `@token` ending at the cursor, when it starts the line or follows whitespace (hermes' `(?<![\w/])@`). */
function analyzeReference(line: string, cursor: number): Phase | undefined {
	if (cursor < 0) return undefined;
	const match = /(?:^|\s)@(\S*)$/.exec(line.slice(0, cursor));
	return match === null ? undefined : { mode: "reference", query: match[1] ?? "" };
}

/** Grok's analyze_input: the query runs from `/` to the cursor; past the command token the cursor is in the arguments. */
function analyze(text: string, cursor: number): Phase | undefined {
	if (cursor < 0 || !text.startsWith("/")) return undefined;
	if (text.slice(1).trim() === "") return { mode: "command", query: "" };
	const at = Math.min(cursor, text.length);
	const space = text.search(/\s/);
	const commandEnd = space === -1 ? text.length : space;
	if (at <= commandEnd) return { mode: "command", query: text.slice(1, Math.max(1, at)) };
	let argsStart = commandEnd;
	while (argsStart < text.length && /\s/.test(text.charAt(argsStart))) argsStart++;
	return { mode: "argument", name: text.slice(1, commandEnd), query: text.slice(argsStart, Math.max(argsStart, at)) };
}

/**
 * The slash dropdown's state: command rows while the cursor is in the command token, that command's argument
 * completions (fetched once per open) after it; Esc closes it until the text changes.
 */
export class SlashMenu {
	private phase: Phase | undefined;
	private rows: DropdownRow[] = [];
	private selectedIndex = 0;
	private pinned = false;
	private text = "";
	private dismissedText: string | undefined;
	private fetch: ArgumentFetch | undefined;
	private files: FileFetch | undefined;

	constructor(
		private readonly source: SlashSource,
		private readonly onChange: () => void = () => {},
	) {}

	get open(): boolean {
		return this.rows.length > 0;
	}

	get matches(): readonly DropdownRow[] {
		return this.rows;
	}

	get selected(): number {
		return this.selectedIndex;
	}

	/**
	 * Recomputes from the prompt's first line and the cursor column on it (-1 when the cursor is elsewhere) for `/`,
	 * and from the cursor's own line for an `@` reference token.
	 */
	refresh(text: string, cursor: number, line = text, lineCursor = cursor): void {
		const key = `${text}\0${line}\0${lineCursor}`;
		this.text = key;
		if (this.dismissedText !== undefined && this.dismissedText !== key) this.dismissedText = undefined;
		this.phase = this.dismissedText === key ? undefined : (analyze(text, cursor) ?? analyzeReference(line, lineCursor));
		if (this.phase?.mode !== "argument" || this.fetch?.name !== this.phase.name) this.fetch = undefined;
		if (this.phase?.mode !== "reference") this.files = undefined;
		this.rebuild();
	}

	dismiss(): void {
		this.dismissedText = this.text;
		this.phase = undefined;
		this.fetch = undefined;
		this.files = undefined;
		this.rebuild();
	}

	move(delta: 1 | -1): void {
		if (this.rows.length === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + this.rows.length) % this.rows.length;
		this.pinned = true;
	}

	select(index: number): void {
		if (index < 0 || index >= this.rows.length) return;
		this.selectedIndex = index;
		this.pinned = true;
	}

	/**
	 * Tab completes; Enter also submits a chosen argument, a command without arguments, or a fully typed command whose
	 * argument is optional. An `@` reference never submits: `replace` is how many characters before the cursor its
	 * text replaces.
	 */
	accept(enter: boolean): { text: string; submit: boolean; replace?: number } | undefined {
		const row = this.rows[this.selectedIndex];
		if (row === undefined || this.phase === undefined) return undefined;
		if (this.phase.mode === "reference") return { text: row.insert, submit: false, replace: this.phase.query.length + 1 };
		if (this.phase.mode === "argument") return { text: row.insert, submit: enter };
		if (enter && row.runnable === true) return { text: row.insert.trimEnd(), submit: true };
		return { text: row.insert, submit: false };
	}

	render(width: number): DropdownLayout {
		return this.open ? renderDropdownPanel(this.rows, this.selectedIndex, width, { count: this.rows.length }) : { lines: [], scroll: 0, visible: 0 };
	}

	/** A selection the user moved follows its row through re-ranking (Grok's carry_selection); otherwise the best match is selected. */
	private rebuild(): void {
		const previous = this.pinned ? this.rows[this.selectedIndex]?.insert : undefined;
		const phase = this.phase;
		this.rows = phase === undefined ? [] : phase.mode === "command" ? this.commandRows(phase.query) : phase.mode === "argument" ? this.argumentRows(phase.name, phase.query) : this.referenceRows(phase.query);
		const carried = previous === undefined ? -1 : this.rows.findIndex((row) => row.insert === previous);
		this.selectedIndex = carried >= 0 ? carried : 0;
		this.pinned = carried >= 0;
	}

	private commandRows(query: string): DropdownRow[] {
		return rank(this.source.commands(), query, (command) => command.name).map(({ item, indices }) => ({
			display: `/${item.name}`,
			description: item.description,
			insert: `/${item.name}${item.usage === undefined ? "" : " "}`,
			indices: indices.map((index) => index + 1),
			runnable: item.usage === undefined || (query === item.name && !item.usage.startsWith("<")),
		}));
	}

	private argumentRows(name: string, query: string): DropdownRow[] {
		const command = this.source.commands().find((entry) => entry.name === name);
		if (command?.usage === undefined) return [];
		if (this.fetch?.name !== name) this.startFetch(name);
		return rank(this.fetch?.items ?? [], query, (item) => item.label, (item) => item.value).map(({ item, indices }) => {
			const tag = item.badge ?? (item.current ? "current" : undefined);
			return {
				display: item.label,
				description: item.description ?? item.group ?? "",
				insert: `/${name} ${item.value}`,
				...(tag === undefined ? {} : { tag }),
				indices,
			};
		});
	}

	/** Kinds and workspace paths for a bare `@query`; files only after `@file:`, folders only after `@folder:`. */
	private referenceRows(query: string): DropdownRow[] {
		if (query.startsWith("git:")) return [];
		const only = query.startsWith("file:") ? "file" : query.startsWith("folder:") ? "folder" : undefined;
		const path = only === undefined ? query : query.slice(only.length + 1);
		const kinds = only === undefined
			? rank(REFERENCE_KINDS, query, (kind) => kind.name).map(({ item, indices }): DropdownRow => ({ display: `@${item.name}`, description: item.description, insert: item.insert, indices: indices.map((index) => index + 1) }))
			: [];
		if (this.source.files === undefined) return kinds;
		if (this.files === undefined) this.startFileFetch();
		const entries = (this.files?.items ?? []).filter((entry) => (only === undefined ? true : only === "folder" ? entry.dir : !entry.dir));
		const paths = rank(entries, path, (entry) => entry.path).slice(0, MAX_REFERENCE_ROWS - kinds.length).map(({ item, indices }): DropdownRow => ({
			display: item.dir ? `${item.path}/` : item.path,
			description: item.dir ? "folder" : item.size === undefined ? "" : formatBytes(item.size),
			insert: `@${item.dir ? "folder" : "file"}:${formatReferenceValue(item.path)} `,
			indices,
		}));
		return [...kinds, ...paths];
	}

	private startFileFetch(): void {
		const fetch: FileFetch = { items: undefined };
		this.files = fetch;
		const settle = (items: readonly WorkspaceEntry[]): void => {
			if (this.files !== fetch) return;
			fetch.items = items;
			this.rebuild();
			this.onChange();
		};
		this.source.files?.().then(settle, () => settle([]));
	}

	private startFetch(name: string): void {
		const fetch: ArgumentFetch = { name, items: undefined };
		this.fetch = fetch;
		const settle = (items: readonly CommandArgument[]): void => {
			if (this.fetch !== fetch) return;
			fetch.items = items;
			this.rebuild();
			this.onChange();
		};
		this.source.arguments(name).then(settle, () => settle([]));
	}
}
