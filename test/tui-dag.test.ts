import { expect, test } from "bun:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { RunStatus } from "../src/core/dag.ts";
import type { NodeKind } from "../src/core/plan.ts";
import type { DagNodeState, DagNodeView, DagView, ResearchView, SubagentProgress } from "../src/core/ui-contract.ts";
import { type DagDisplayState, type DagLive, DagPane, dagBudget, dagLines, dagTitle, displayState, type FoldItem, foldRows, researchSummary } from "../src/tui/panes/dag.ts";
import type { AskView } from "../src/tui/state.ts";
import { bold, brailleSpinner, color, spacing, type Style } from "../src/tui/theme.ts";

const NOW = 1_700_000_000_000;
const research = (overrides: Partial<ResearchView> = {}): ResearchView => ({
	id: "mission-1", revision: 3, question: "Reduce latency", status: "stopped", judgment: "not_achieved", deadlineAt: NOW + 60_000,
	attempts: { used: 3, limit: 5 }, rounds: { used: 1, limit: 2 }, candidateBudget: { used: 2, limit: 4 },
	activeAttempts: 0, maxConcurrent: 2, confirmationReserved: 1, incumbentId: "baseline",
	candidates: [
		{ id: "baseline", operation: "baseline", state: "measured", hypothesis: "reference", value: 10, unit: "ms", validity: "valid", verdict: "inconclusive", feedback: "" },
		{ id: "change", parentId: "baseline", operation: "mutate", state: "failed", hypothesis: "cache", value: 1, validity: "invalid", verdict: "inconclusive", feedback: "bad output" },
	],
	report: { directory: "/project/research/mission-1", state: "written", writtenRevision: 2 }, ...overrides,
});

test("research summary preserves negative/unknown results independently of verified execution at 80 and 140 columns", () => {
	for (const width of [80, 140]) {
		const fixture = view("verified", [node({ id: "check", state: "succeeded" })], { research: research() });
		const lines = dagLines(fixture, width, 8, live());
		const text = lines.map(plain).join("\n");
		for (const line of lines) expect(visibleWidth(line)).toBe(width);
		expect(text).toContain("verified");
		expect(text).toContain("outcome not_achieved");
		expect(text).toContain("Attempts 3/5");
		expect(text).toContain("rounds 1/2");
		expect(text).toContain("active 0/2");
		expect(text).toContain("Best baseline: 10 ms");
		expect(text).toContain("invalid 1");
		expect(text).toContain("inconclusive 2");
		expect(text).toContain("report written (lagging)");
		expect(text).not.toContain("Best change");
		expect(text).toContain("check");
	}
	const unknownMission = research({ incumbentId: "change" });
	delete unknownMission.judgment;
	const unknown = researchSummary(unknownMission, NOW).join("\n");
	expect(unknown).toContain("outcome unknown");
	expect(unknown).toContain("Best unknown (no comparable result)");
	const qualitative = research({ candidates: [{ id: "baseline", operation: "baseline", state: "evaluated", hypothesis: "reference", validity: "valid", verdict: "fail", feedback: "negative result" }] });
	expect(researchSummary(qualitative, NOW).join("\n")).toContain("Best baseline: fail");
	expect(researchSummary(qualitative, NOW + 120_000).join("\n")).toContain("left 0s");
});

test("candidate lineage changes do not change execution row order or edges", () => {
	const fixture = example("verified");
	const mission = research();
	const baseline = dagLines({ ...fixture, research: mission }, 140, 10, live()).slice(5);
	const changed = dagLines({
		...fixture, research: { ...mission, revision: 4, candidates: [...mission.candidates].reverse().map((candidate) => ({ ...candidate, parentId: "unrelated-candidate" })) },
	}, 140, 10, live()).slice(5);
	expect(changed).toEqual(baseline);
	expect(changed).toEqual(dagLines(fixture, 140, 6, live()).slice(1));
});

test("research text is terminal-safe and countdown advances without running DAG nodes", () => {
	const mission = research({ question: "safe\x1b[31m red\x00\x07\nquestion\u202e" });
	const fixture = view("verified", [node({ id: "check", state: "succeeded" })], { research: mission });
	let now = NOW;
	const pane = new DagPane(() => ({ dag: fixture, version: 1 }), () => 40, () => live({ now }));
	const before = pane.render(80);
	expect(before.map(plain).join("\n")).toContain("left 1m0s");
	now += 1_000;
	const after = pane.render(80);
	expect(after).not.toBe(before);
	expect(after.map(plain).join("\n")).toContain("left 59s");
	expect(after.map(plain).join("\n")).not.toMatch(/[\x00\x07\u202e]/);
	for (const width of [20, 80, 140]) {
		const lines = dagLines(fixture, width, 3, live());
		expect(lines.length).toBeLessThanOrEqual(4);
		for (const line of lines) expect(visibleWidth(line)).toBe(width);
	}
});
const plain = (line: string | undefined): string => stripTerminalSequences(line ?? "");
const SPINNER = new Set(brailleSpinner.frames);
const spins = (text: string): boolean => [...text].some((char) => SPINNER.has(char));
const margin = " ".repeat(spacing.margin);
const fill = (text: string, width: number): string => `${text}${" ".repeat(width - visibleWidth(text))}`;
const seg = (mark: string, word: string): string => `${mark} ${word.padEnd(8)}`;
const DISPLAY: readonly DagDisplayState[] = ["running", "settling", "waiting", "ready", "retry", "pending", "done", "failed", "skipped", "lastseen"];
const STATES: readonly DagNodeState[] = ["pending", "ready", "running", "waiting", "succeeded", "failed", "skipped"];
const RUNS: readonly RunStatus[] = ["compiling", "running", "verified", "blocked", "cancelled"];
const KINDS: readonly NodeKind[] = ["act", "delegate", "verify", "ask", "expand"];
const CHILD: readonly SubagentProgress["status"][] = ["running", "completed", "failed", "cancelled"];

const live = (overrides: Partial<DagLive> = {}): DagLive => ({ subagents: new Map(), asks: new Map(), tick: 0, now: NOW, ...overrides });
const node = (partial: Partial<DagNodeView> & { id: string }): DagNodeView => ({
	kind: "act", title: `Title of ${partial.id}`, state: "pending", level: 0, parents: [], directParents: partial.directParents ?? partial.parents ?? [],
	attempt: 0, maxAttempts: 3, covers: [], critical: false, ...partial,
});
const view = (status: RunStatus, nodes: DagNodeView[], partial: Partial<DagView> = {}): DagView => ({
	id: "dag-1", revision: 0, status, replanBudget: 8, requirements: [{ id: "R1", certified: false }],
	levels: nodes.length === 0 ? 0 : 1 + Math.max(...nodes.map((n) => n.level)), nodes, updatedAt: NOW, ...partial,
});
const progress = (taskId: string, status: SubagentProgress["status"] = "running", currentTool?: string): SubagentProgress => ({
	taskId, description: "dag-1:bot", subagentType: "general-purpose", background: true, conversationId: 7, status, startedAt: NOW - 62_000, toolCount: 3,
	...(status === "running" ? {} : { endedAt: NOW - 1_000 }),
	...(currentTool === undefined ? {} : { currentTool }),
});
const ask = (from: string, state = "open"): AskView => ({ id: `ask-${from}`, to: "main", kind: "decision", question: "Which DB?", from, state, default: "sqlite", deadlineAt: NOW + 60_000 });
const children = (...entries: SubagentProgress[]): Map<string, SubagentProgress> => new Map(entries.map((entry) => [entry.taskId, entry]));

/** survey, tokens (wave 1, done) -> bot (wave 2, running as sa-1) -> check (wave 3, pending). */
const example = (status: RunStatus = "running"): DagView =>
	view(status, [
		node({ id: "survey", title: "Survey the repo", state: "succeeded", startedAt: NOW - 20_000, endedAt: NOW - 8_000 }),
		node({ id: "tokens", title: "Collect tokens", state: "succeeded", startedAt: NOW - 20_000, endedAt: NOW - 12_000 }),
		node({ id: "bot", kind: "delegate", title: "Implement bot", state: "running", level: 1, parents: ["survey", "tokens"], handle: "sa-1", startedAt: NOW - 62_000 }),
		node({ id: "check", kind: "verify", title: "Verify bot", state: "pending", level: 2, parents: ["bot"] }),
	], { reason: "lint check failed" });
const exampleLive = live({ subagents: children(progress("sa-1", "running", "read")) });

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * A random run: parents among earlier nodes, longest-path levels, transitive-reduction `parents` beside the compiled
 * `directParents`, display order (level, index), random child progress and open asks for the bound handles.
 */
function randomFixture(seed: number): { view: DagView; live: DagLive } {
	const next = mulberry32(seed);
	const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
	const count = next() < 0.05 ? 0 : 1 + Math.floor(next() * 40);
	const parents: number[][] = [];
	const level: number[] = [];
	const ancestors: Set<number>[] = [];
	for (let i = 0; i < count; i++) {
		const chosen: number[] = [];
		if (i > 0 && next() < 0.75) {
			const pool = Array.from({ length: i }, (_, j) => j);
			const wanted = 1 + Math.floor(next() * Math.min(3, i));
			for (let k = 0; k < wanted; k++) chosen.push(pool.splice(Math.floor(next() * pool.length), 1)[0]!);
		}
		chosen.sort((a, b) => a - b);
		parents.push(chosen);
		level.push(chosen.length === 0 ? 0 : 1 + Math.max(...chosen.map((p) => level[p]!)));
		const above = new Set<number>();
		for (const p of chosen) {
			above.add(p);
			for (const a of ancestors[p]!) above.add(a);
		}
		ancestors.push(above);
	}
	const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => level[a]! - level[b]! || a - b);
	const position = new Map(order.map((i, index) => [i, index]));
	const byPosition = (a: number, b: number): number => position.get(a)! - position.get(b)!;
	const nodes = order.map((i): DagNodeView => {
		const direct = [...parents[i]!].sort(byPosition);
		const reduced = direct.filter((p) => !direct.some((q) => q !== p && ancestors[q]!.has(p)));
		const state = pick(STATES);
		const attempt = Math.floor(next() * 3);
		const kind = pick(KINDS);
		const made = node({
			id: `n${i}`, kind, title: next() < 0.1 ? "" : `Step ${i} of the plan`, state, level: level[i]!,
			parents: reduced.map((p) => `n${p}`), directParents: direct.map((p) => `n${p}`), attempt, critical: next() < 0.3,
		});
		if (state === "failed" || (attempt > 0 && next() < 0.6)) made.error = `error ${i} happened`;
		if (next() < 0.6) made.handle = kind === "ask" ? "orchestrator" : `sa-${i}`;
		if (next() < 0.7) made.startedAt = NOW - 60_000 * (1 + i);
		if (next() < 0.5) made.endedAt = NOW - 1_000 * i;
		return made;
	});
	const subagents = new Map<string, SubagentProgress>();
	const asks = new Map<string, AskView>();
	for (const n of nodes) {
		if (n.handle === undefined || n.handle === "orchestrator") continue;
		if (next() < 0.5) subagents.set(n.handle, progress(n.handle, pick(CHILD)));
		if (n.state === "waiting" && next() < 0.5) asks.set(`ask-${n.id}`, ask(n.handle));
	}
	const diagnostics = count === 0 && next() < 0.5 ? Array.from({ length: 1 + Math.floor(next() * 12) }, (_, k) => `diagnostic ${k}: something is off`) : undefined;
	const status = diagnostics ? "blocked" : pick(RUNS);
	const requirements = Array.from({ length: Math.floor(next() * 4) }, (_, k) => ({ id: `R${k + 1}`, certified: next() < 0.5 }));
	const fixture = view(status, nodes, {
		revision: Math.floor(next() * 3), requirements,
		...(next() < 0.5 ? { reason: "lint check failed on main" } : {}),
		...(diagnostics ? { diagnostics } : {}),
	});
	return { view: fixture, live: live({ subagents, asks }) };
}

type Case = { seed: number; view: DagView; live: DagLive; budget: number; width: number; items: FoldItem[]; lines: string[] };
const SEEDS = 240;
const cases: Case[] = [];
for (let seed = 1; seed <= SEEDS; seed++) {
	const fixture = randomFixture(seed);
	const next = mulberry32(seed * 7919);
	for (let budget = 3; budget <= 10; budget++) {
		for (const width of [20, 200, 20 + Math.floor(next() * 181)]) {
			const caseLive = { ...fixture.live, tick: Math.floor(next() * 40) };
			cases.push({ seed, view: fixture.view, live: caseLive, budget, width, items: foldRows(fixture.view, budget, caseLive), lines: dagLines(fixture.view, width, budget, caseLive) });
		}
	}
}
const nodesOf = (item: FoldItem): DagNodeView[] => (item.kind === "node" ? [item.node] : item.nodes);
const tally = (fixture: DagView, nodes: readonly DagNodeView[], current: DagLive): Record<DagDisplayState, number> => {
	const counts = Object.fromEntries(DISPLAY.map((state) => [state, 0])) as Record<DagDisplayState, number>;
	for (const n of nodes) counts[displayState(fixture, n, current)]++;
	return counts;
};

test("fit theorem: body rows <= budget and lines <= budget + 1 over 240 random runs x budgets 3..10 x widths 20..200", () => {
	expect(cases.length).toBeGreaterThanOrEqual(200 * 8 * 3);
	expect(new Set(cases.map((c) => c.view.status)).size).toBe(RUNS.length);
	expect(cases.some((c) => c.items.some((item) => nodesOf(item).some((n) => displayState(c.view, n, c.live) === "settling")))).toBe(true);
	expect(cases.some((c) => c.view.nodes.length === 0 && (c.view.diagnostics?.length ?? 0) > c.budget)).toBe(true);
	for (const c of cases) {
		expect(c.items.length).toBeLessThanOrEqual(c.budget);
		expect(c.lines.length).toBeLessThanOrEqual(c.budget + 1);
		if (c.view.nodes.length > 0) expect(c.lines.length).toBe(c.items.length + 1);
		else if ((c.view.diagnostics?.length ?? 0) === 0) expect(c.lines).toHaveLength(1);
		if (c.view.nodes.length <= c.budget) expect(c.items.every((item) => item.kind === "node")).toBe(true);
	}
});

test("conservation theorem: every node is counted exactly once, counts match per state, a remainder ends an unexpanded list", () => {
	for (const c of cases) {
		const seen = c.items.flatMap(nodesOf);
		expect(seen.map((n) => n.id).sort()).toEqual(c.view.nodes.map((n) => n.id).sort());
		expect(tally(c.view, seen, c.live)).toEqual(tally(c.view, c.view.nodes, c.live));
		for (const item of c.items) {
			if (item.kind === "wave" || item.kind === "more") expect(item.nodes.every((n) => n.level === item.level)).toBe(true);
			if (item.kind === "group") {
				expect(item.from).toBeLessThan(item.to);
				expect(item.nodes.every((n) => n.level >= item.from && n.level <= item.to)).toBe(true);
			}
			if (item.kind === "rest") {
				expect(c.items.indexOf(item)).toBe(c.items.length - 1);
				expect(c.items.every((other) => other.kind === "wave" || other.kind === "group" || other.kind === "rest")).toBe(true);
			}
		}
	}
});

test("rendered conservation: from 40 columns every folded row still accounts for each of its nodes in its counts or one +N more", () => {
	const counted = (line: string): number => {
		const text = plain(line);
		let sum = 0;
		for (const match of text.matchAll(/(\d+) (running|settling|waiting|failed|retry|ready|last seen|done|pending|skipped)\b/g)) sum += Number(match[1]);
		for (const match of text.matchAll(/\+(\d+) more\b/g)) sum += Number(match[1]);
		return sum;
	};
	let checked = 0;
	for (const c of cases) {
		if (c.view.nodes.length === 0) continue;
		for (const width of [40, 50, c.width]) {
			if (width < 40) continue;
			const lines = dagLines(c.view, width, c.budget, c.live).slice(1);
			for (const [index, item] of c.items.entries()) {
				if (item.kind === "node") continue;
				expect(counted(lines[index]!)).toBe(item.nodes.length);
				checked++;
			}
		}
	}
	expect(checked).toBeGreaterThan(1000);
});

test("every rendered row is exactly the pane width and carries no color reset", () => {
	for (const c of cases) {
		for (const line of c.lines) {
			expect(visibleWidth(line)).toBe(c.width);
			expect(line).not.toContain("\x1b[0m");
			expect(plain(line).startsWith(margin)).toBe(true);
		}
	}
});

test("motion: spinner frames only on rows with a running node of a running run; settling, last seen and the title never spin", () => {
	for (const c of cases) {
		const [title, ...body] = c.lines.map(plain);
		expect(spins(title ?? "")).toBe(false);
		if (c.view.nodes.length === 0) {
			expect(body.some(spins)).toBe(false);
			continue;
		}
		body.forEach((row, index) => {
			const item = c.items[index]!;
			const running = nodesOf(item).some((n) => displayState(c.view, n, c.live) === "running");
			if (spins(row)) {
				expect(running).toBe(true);
				expect(c.view.status).toBe("running");
			}
			if (item.kind === "node" || c.width >= 60) expect(spins(row)).toBe(running);
		});
	}
});

test("the title says verified only for a verified run", () => {
	for (const c of cases) {
		const title = plain(c.lines[0]);
		if (title.includes("verified")) expect(c.view.status).toBe("verified");
		if (c.width >= 30) expect(title.includes("verified")).toBe(c.view.status === "verified");
		for (const line of c.lines.slice(1)) if (plain(line).includes("verified")) expect(c.view.status).toBe("verified");
	}
});

test("A3 state table: in-flight nodes settle with their child or are last seen once the run ends; a failed attempt reads retry even in the frontier", () => {
	for (const status of RUNS) {
		const flight = status === "running";
		const expected: Record<DagNodeState, DagDisplayState> = {
			running: flight ? "running" : "lastseen", waiting: flight ? "waiting" : "lastseen",
			ready: "ready", pending: "pending", succeeded: "done", failed: "failed", skipped: "skipped",
		};
		for (const state of STATES) {
			const n = node({ id: "x", state, handle: "sa-1" });
			expect(displayState(view(status, [n]), n)).toBe(expected[state]);
			expect(displayState(view(status, [n]), n, live({ subagents: children(progress("sa-1", "running")) }))).toBe(expected[state]);
			for (const child of ["completed", "failed", "cancelled"] as const) {
				const settled = flight && (state === "running" || state === "waiting") ? "settling" : expected[state];
				expect(displayState(view(status, [n]), n, live({ subagents: children(progress("sa-1", child)) }))).toBe(settled);
			}
		}
	}
	const orphan = node({ id: "x", state: "running" });
	expect(displayState(view("running", [orphan]), orphan, live({ subagents: children(progress("sa-1", "completed")) }))).toBe("running");
	for (const state of ["pending", "ready"] as const) {
		const retry = node({ id: "x", state, attempt: 1, error: "boom" });
		expect(displayState(view("running", [retry]), retry)).toBe("retry");
		const clean = node({ id: "x", state, attempt: 1 });
		expect(displayState(view("running", [clean]), clean)).toBe(state);
	}
});

test("state rows: mark and word in the role color, the word padded to eight columns before the purpose icon", () => {
	const settled = live({ subagents: children(progress("sa-1", "completed")) });
	const rows: [DagNodeView, RunStatus, DagLive, string, Style][] = [
		[node({ id: "x", state: "running" }), "running", live(), seg("⠋", "running"), color.accentRunning],
		[node({ id: "x", state: "running", handle: "sa-1" }), "running", settled, seg("○", "settling"), color.textSecondary],
		[node({ id: "x", state: "waiting" }), "running", live(), seg("○", "waiting"), color.warning],
		[node({ id: "x", state: "ready" }), "running", live(), seg("○", "ready"), color.textPrimary],
		[node({ id: "x", state: "pending", attempt: 2, error: "boom" }), "running", live(), seg("○", "retry"), color.warning],
		[node({ id: "x", state: "pending" }), "running", live(), seg("○", "pending"), color.gray],
		[node({ id: "x", state: "succeeded" }), "running", live(), seg("✓", "done"), color.accentSuccess],
		[node({ id: "x", state: "failed", error: "exit 2" }), "running", live(), seg("!", "failed"), color.accentError],
		[node({ id: "x", state: "skipped" }), "running", live(), seg("–", "skipped"), color.warning],
		[node({ id: "x", state: "running" }), "cancelled", live(), seg("○", "running"), color.warning],
	];
	expect(rows.map(([n, status, current]) => displayState(view(status, [n]), n, current))).toEqual([...DISPLAY]);
	for (const [n, status, current, text, style] of rows) {
		const line = dagLines(view(status, [n]), 100, 10, current)[1]!;
		expect(plain(line).startsWith(`${margin}1 +  ${text}  @  x  Title of x`)).toBe(true);
		expect(line).toContain(style(text));
		expect(spins(plain(line))).toBe(text.startsWith("⠋"));
	}
	const icons = [["act", "@"], ["delegate", "@"], ["expand", "@"], ["verify", "☐"], ["ask", "⋯"]] as const;
	for (const [kind, icon] of icons) expect(plain(dagLines(view("running", [node({ id: "x", kind })]), 100, 10, live())[1])).toContain(`${seg("○", "pending")}  ${icon}  x`);
});

test("example at 100 columns: title with meta and /dag hint, spine with wave colors, deps barrier, activity and elapsed", () => {
	const lines = dagLines(example(), 100, 10, exampleLive);
	expect(lines.map(plain)).toEqual([
		`${fill(`${margin}DAG  ○ running - wave 2/3 - 2/4 done - reqs 0/1`, 100 - spacing.margin - 4)}/dag${margin}`,
		`${fill(`${margin}1 +  ✓ done      @  survey  Survey the repo`, 100 - spacing.margin - 3)}12s${margin}`,
		`${fill(`${margin}  |  ✓ done      @  tokens  Collect tokens`, 100 - spacing.margin - 2)}8s${margin}`,
		`${fill(`${margin}2 +  ⠋ running   @  bot     Implement bot  <- wave 1`, 100 - spacing.margin - 20)}Running: read - 1m2s${margin}`,
		fill(`${margin}3 +  ○ pending   ☐  check   Verify bot  <- bot`, 100),
	]);
	expect(lines[0]).toContain(color.grayBright("DAG  "));
	expect(lines[0]).toContain(color.accentRunning("○ running"));
	expect(lines[0]).toContain(color.gray(" - wave 2/3"));
	expect(lines[0]).toContain(color.gray("/dag"));
	expect(lines[1]).toContain(color.accentSuccess("1"));
	expect(lines[1]).toContain(color.grayDim("+"));
	expect(lines[1]).toContain(color.accentSuccess(seg("✓", "done")));
	expect(lines[2]).toContain(color.grayDim("|"));
	expect(lines[3]).toContain(color.accentRunning("2"));
	expect(lines[3]).toContain(bold(color.textPrimary("bot")));
	expect(lines[3]).toContain(color.gray("<- wave 1"));
	expect(lines[3]).toContain(color.gray("Running: read - 1m2s"));
	expect(lines[4]).toContain(color.gray("3"));
	expect(lines[4]).toContain(color.textPrimary("check"));
	for (const width of [20, 24, 40, 50, 60, 100, 160]) for (const line of dagLines(example(), width, 10, exampleLive)) expect(visibleWidth(line)).toBe(width);
});

test("narrow widths: meta drops first, then deps, then the title is cut, then the id; the state survives", () => {
	const bot = (width: number): string => plain(dagLines(example(), width, 10, exampleLive)[3]).trimEnd();
	expect(bot(54)).toBe(`${margin}2 +  ⠋ running   @  bot     Implement bot  <- wave 1`);
	expect(bot(44)).toBe(`${margin}2 +  ⠋ running   @  bot     Implement bot`);
	expect(bot(34)).toBe(`${margin}2 +  ⠋ running   @  bot     Imp...`);
	expect(bot(24)).toBe(`${margin}2 +  ⠋ running   @  bot`);
	expect(bot(22)).toBe(`${margin}2 +  ⠋ running   @`);
	expect(bot(18)).toBe(`${margin}2 +  ⠋ running   @`);
	expect(bot(16)).toBe(`${margin}2 +  ⠋ running`);
	expect(bot(14)).toBe(`${margin}2 +  ⠋ running`);
	expect(plain(dagTitle(example(), 14))).toBe(`${margin}DAG  ○ running`);
	expect(plain(dagTitle(example(), 18))).toBe(`${margin}DAG  ○ running...`);
	expect(plain(dagTitle(example(), 30))).toBe(`${margin}DAG  ○ running - wave 2/3...`);
	expect(plain(dagTitle(example(), 32))).toBe(`${margin}DAG  ○ running - wave 2/3 - 2...`);
	expect(plain(dagTitle(example(), 38))).toBe(`${margin}DAG  ○ running - wave 2/3 - 2/4 done`);
});

test("2.2 deps: reduced parents in order, a full previous wave of >= 2 nodes reads as a barrier, long lists fold into +k", () => {
	const sources = ["alpha", "beta", "gamma", "delta", "eps"].map((id) => node({ id, state: "succeeded" }));
	const some = node({ id: "some", level: 1, parents: ["alpha", "beta", "gamma", "delta"], state: "ready" });
	const all = node({ id: "all", level: 1, parents: ["alpha", "beta", "gamma", "delta", "eps"], state: "ready" });
	const one = node({ id: "one", level: 2, parents: ["all"], state: "pending" });
	const fixture = view("running", [...sources, some, all, one]);
	const wide = dagLines(fixture, 200, 10, live()).map(plain);
	expect(wide[1]!.trimEnd()).toBe(`${margin}1 +  ✓ done      @  alpha  Title of alpha`);
	expect(wide[6]!.trimEnd()).toBe(`${margin}2 +  ○ ready     @  some   Title of some  <- alpha, beta, gamma, delta`);
	expect(wide[7]!.trimEnd()).toBe(`${margin}  |  ○ ready     @  all    Title of all  <- wave 1`);
	expect(wide[8]!.trimEnd()).toBe(`${margin}3 +  ○ pending   @  one    Title of one  <- all`);
	const body = visibleWidth(wide[6]!.trimEnd());
	const folded = plain(dagLines(fixture, body + spacing.margin - 1, 10, live())[6]).trimEnd();
	expect(folded).toBe(`${margin}2 +  ○ ready     @  some   Title of some  <- alpha, beta, gamma +1`);
	const tighter = plain(dagLines(fixture, body + spacing.margin - 8, 10, live())[6]).trimEnd();
	expect(tighter).toBe(`${margin}2 +  ○ ready     @  some   Title of some  <- alpha, beta +2`);
	const pair = view("running", [node({ id: "a", state: "succeeded" }), node({ id: "b", level: 1, parents: ["a"] })]);
	expect(plain(dagLines(pair, 100, 10, live())[2])).toContain("<- a");
	expect(plain(dagLines(pair, 100, 10, live())[2])).not.toContain("wave");
});

test("A2 blocked by: a direct parent hidden by the reduction that has not succeeded is named after the deps while the node is not done", () => {
	const a = node({ id: "a", state: "pending" });
	const b = node({ id: "b", level: 1, parents: ["a"], state: "succeeded" });
	const c = node({ id: "c", level: 2, parents: ["b"], directParents: ["a", "b"], state: "ready" });
	const d = node({ id: "d", level: 2, parents: ["b"], directParents: ["a", "b"], state: "succeeded" });
	const lines = dagLines(view("running", [a, b, c, d]), 100, 10, live());
	expect(plain(lines[3]).trimEnd()).toBe(`${margin}3 +  ○ ready     @  c  Title of c  <- b  blocked by a`);
	expect(lines[3]).toContain(color.warning("blocked by a"));
	expect(plain(lines[4]).trimEnd()).toBe(`${margin}  |  ✓ done      @  d  Title of d  <- b`);
	const sound = view("running", [{ ...a, state: "succeeded" }, b, c, d]);
	expect(plain(dagLines(sound, 100, 10, live())[3]).trimEnd()).toBe(`${margin}3 +  ○ ready     @  c  Title of c  <- b`);
	const ps = ["p1", "p2", "p3"].map((id) => node({ id, state: "pending" }));
	const q = node({ id: "q", level: 1, parents: ["p1", "p2", "p3"], state: "succeeded" });
	const r = node({ id: "r", level: 2, parents: ["q"], directParents: ["p1", "p2", "p3", "q"], state: "ready" });
	const many = view("running", [...ps, q, r]);
	const full = plain(dagLines(many, 200, 10, live())[5]).trimEnd();
	expect(full).toBe(`${margin}3 +  ○ ready     @  r   Title of r  <- q  blocked by p1, p2, p3`);
	const width = visibleWidth(full);
	expect(plain(dagLines(many, width + spacing.margin - 1, 10, live())[5]).trimEnd()).toBe(`${margin}3 +  ○ ready     @  r   Title of r  <- q  blocked by p1, p2 +1`);
	expect(plain(dagLines(many, width + spacing.margin - 4, 10, live())[5]).trimEnd()).toBe(`${margin}3 +  ○ ready     @  r   Title of r  <- q  blocked by p1 +2`);
	expect(plain(dagLines(many, width + spacing.margin - 6, 10, live())[5]).trimEnd()).toBe(`${margin}3 +  ○ ready     @  r   Title of r  <- q  blocked by +3`);
	// The blocker count outranks the title and deps: narrow rows cut those first and still say what holds the node.
	for (const cols of [44, 50, 60, 70]) {
		const row = plain(dagLines(many, cols, 10, live())[5]).trimEnd();
		expect(row).toMatch(/blocked by (p1(, p2(, p3| \+1)| \+2)|\+3)$/);
		expect(visibleWidth(row)).toBeLessThanOrEqual(cols);
	}
});

test("waiting meta: the open ask of the node's handle, the ask/answer hint for the orchestrator, otherwise waiting for an answer", () => {
	const bot = node({ id: "bot", kind: "delegate", state: "waiting", handle: "sa-1" });
	const open = plain(dagLines(view("running", [bot]), 100, 10, live({ asks: new Map([["a", ask("sa-1")]]) }))[1]).trimEnd();
	expect(open.startsWith(`${margin}1 +  ○ waiting   @  bot`)).toBe(true);
	expect(open.endsWith('asks "Which DB?"')).toBe(true);
	const settled = plain(dagLines(view("running", [bot]), 100, 10, live({ asks: new Map([["a", ask("sa-1", "answered")], ["b", ask("sa-9")]]) }))[1]).trimEnd();
	expect(settled).toBe(`${fill(`${margin}1 +  ○ waiting   @  bot  Title of bot`, 100 - spacing.margin - "waiting for an answer".length)}waiting for an answer`);
	const question = node({ id: "q", kind: "ask", state: "waiting", handle: "orchestrator" });
	const hint = plain(dagLines(view("running", [question]), 100, 10, live())[1]).trimEnd();
	expect(hint.startsWith(`${margin}1 +  ○ waiting   ⋯  q`)).toBe(true);
	expect(hint.endsWith("answer with ask/answer")).toBe(true);
	const relayed = plain(dagLines(view("running", [question]), 100, 10, live({ asks: new Map([["a", ask("orchestrator")]]) }))[1]).trimEnd();
	expect(relayed.endsWith('asks "Which DB?"')).toBe(true);
});

test("settling: a running node whose child settled stays static in textSecondary and says what it awaits", () => {
	for (const status of ["completed", "failed", "cancelled"] as const) {
		const lines = dagLines(example(), 100, 10, live({ subagents: children(progress("sa-1", status)), tick: 7 }));
		const meta = `child ${status} - awaiting dag_step`;
		expect(plain(lines[3])).toBe(`${fill(`${margin}2 +  ○ settling  @  bot     Implement bot  <- wave 1`, 100 - spacing.margin - meta.length)}${meta}${margin}`);
		expect(lines[3]).toContain(color.textSecondary(seg("○", "settling")));
		expect(lines[3]).toContain(color.accentRunning("2"));
		expect(lines[3]).toContain(color.gray(meta));
		for (const line of lines) expect(spins(plain(line))).toBe(false);
	}
});

test("retry and failed meta: the failed attempt over the budget, then the error", () => {
	const retry = node({ id: "lint", kind: "verify", state: "pending", attempt: 1, error: "exit code 2\nsecond line" });
	const row = plain(dagLines(view("running", [retry]), 100, 10, live())[1]).trimEnd();
	expect(row.startsWith(`${margin}1 +  ○ retry     ☐  lint`)).toBe(true);
	expect(row.endsWith("attempt 1/3 failed: exit code 2 second line")).toBe(true);
	const failed = node({ id: "lint", kind: "verify", state: "failed", attempt: 3, error: "\x1b[31mtsc\x1b[0m failed" });
	const line = dagLines(view("blocked", [failed], { reason: "lint failed" }), 100, 10, live())[1]!;
	expect(plain(line)).toBe(`${fill(`${margin}1 +  ! failed    ☐  lint  Title of lint`, 100 - spacing.margin - 10)}tsc failed${margin}`);
	expect(line).toContain(color.accentError(seg("!", "failed")));
	expect(line).not.toContain("\x1b[0m");
});

test("last seen: a terminal run keeps the recorded word under the unknown mark, frozen at the view time, with no motion", () => {
	for (const status of ["cancelled", "blocked", "verified", "compiling"] as const) {
		const lines = dagLines(example(status), 100, 10, { ...exampleLive, tick: 5 });
		const meta = "last seen - child running - 1m2s";
		expect(plain(lines[3])).toBe(`${fill(`${margin}2 +  ○ running   @  bot     Implement bot  <- wave 1`, 100 - spacing.margin - meta.length)}${meta}${margin}`);
		expect(lines[3]).toContain(color.warning(seg("○", "running")));
		expect(lines[3]).toContain(color.warning("2"));
		for (const line of lines) expect(spins(plain(line))).toBe(false);
	}
	expect(plain(dagLines(example("cancelled"), 100, 10, live())[3]).trimEnd().endsWith("last seen - 1m2s")).toBe(true);
	const waiting = view("blocked", [node({ id: "w", state: "waiting", handle: "sa-1" })]);
	expect(plain(dagLines(waiting, 100, 10, live())[1]).trimEnd()).toBe(`${fill(`${margin}1 +  ○ waiting   @  w  Title of w`, 100 - spacing.margin - 9)}last seen`);
	const cancelled = plain(dagLines(example("cancelled"), 120, 10, live())[0]);
	expect(cancelled.startsWith(`${margin}DAG  – cancelled - wave 2/3 - 2/4 done - reqs 0/1 - lint check failed`)).toBe(true);
	const blocked = dagLines(example("blocked"), 120, 10, live())[0]!;
	expect(plain(blocked)).toContain("DAG  ! blocked - wave 2/3 - 2/4 done - reqs 0/1 - lint check failed");
	expect(blocked).toContain(color.accentError("! blocked"));
	expect(plain(dagLines(example("running"), 120, 10, live())[0])).not.toContain("lint check failed");
});

test("title: verified only from the host status, wave omitted once all succeeded, rev only after a replan, no body for an empty plan", () => {
	const done = view("verified", [node({ id: "a", state: "succeeded" }), node({ id: "b", state: "succeeded", level: 1, parents: ["a"] })], { requirements: [{ id: "R1", certified: true }] });
	const title = dagTitle(done, 80);
	expect(plain(title)).toBe(`${fill(`${margin}DAG  ✓ verified - 2/2 done - reqs 1/1`, 80 - spacing.margin - 4)}/dag`);
	expect(title).toContain(color.accentSuccess("✓ verified"));
	expect(plain(dagTitle({ ...done, status: "running" }, 80))).toContain("DAG  ○ running - 2/2 done - reqs 1/1");
	expect(plain(dagTitle({ ...done, revision: 2 }, 80))).toContain(" - reqs 1/1 - rev 2");
	expect(plain(dagTitle({ ...done, requirements: [] }, 80))).toContain("DAG  ✓ verified - 2/2 done   ");
	const compiling = dagLines(view("compiling", []), 60, 10, live());
	expect(compiling.map(plain)).toEqual([`${fill(`${margin}DAG  ○ compiling - 0/0 done - reqs 0/1`, 60 - spacing.margin - 4)}/dag${margin}`]);
	expect(compiling[0]).toContain(color.accentRunning("○ compiling"));
	for (const status of RUNS) expect(plain(dagTitle(view(status, [node({ id: "a" })]), 80)).includes("verified")).toBe(status === "verified");
});

test("A4 uncompiled run: blocked header with plan does not compile, diagnostics as body rows within the budget", () => {
	const diagnostics = ["cycle: a -> b -> a", "node x: unknown parent y", "goal: no requirements", "node z: empty description", "node w: unknown kind"];
	for (const status of ["blocked", "compiling"] as const) {
		const lines = dagLines(view(status, [], { diagnostics: diagnostics.slice(0, 2), reason: "plan rejected" }), 60, 10, live());
		expect(lines.map(plain)).toEqual([
			`${fill(`${margin}DAG  ! blocked - plan does not compile`, 60 - spacing.margin - 4)}/dag${margin}`,
			fill(`${margin}cycle: a -> b -> a`, 60),
			fill(`${margin}node x: unknown parent y`, 60),
		]);
		expect(lines[0]).toContain(color.accentError("! blocked"));
		expect(lines[1]).toContain(color.gray("cycle: a -> b -> a"));
	}
	const cut = dagLines(view("blocked", [], { diagnostics }), 60, 3, live()).map(plain);
	expect(cut).toEqual([
		`${fill(`${margin}DAG  ! blocked - plan does not compile`, 60 - spacing.margin - 4)}/dag${margin}`,
		fill(`${margin}cycle: a -> b -> a`, 60),
		fill(`${margin}node x: unknown parent y`, 60),
		fill(`${margin}+ 3 more`, 60),
	]);
	expect(plain(dagLines(view("blocked", [], { diagnostics }), 30, 3, live())[1])).toBe(fill(`${margin}cycle: a -> b -> a`, 30));
	expect(plain(dagLines(view("blocked", [], { diagnostics: ["a very long diagnostic message that overflows"] }), 30, 3, live())[1])).toBe(`${margin}a very long diagnostic mess...${margin}`);
	expect(foldRows(view("blocked", [], { diagnostics }), 3)).toEqual([]);
});

test("dagBudget: a fifth of the terminal clamped to 3..10", () => {
	expect([5, 10, 15, 20, 30, 45, 50, 80].map(dagBudget)).toEqual([3, 3, 3, 4, 6, 9, 10, 10]);
});

test("A5 one huge active wave: the most urgent nodes get rows in display order above a +more summary owning the rest", () => {
	const state = (i: number): DagNodeState => ([7, 15, 29].includes(i) || i === 3 ? "running" : i === 11 ? "waiting" : "pending");
	const big = view("running", Array.from({ length: 30 }, (_, i) => node({ id: `n${i}`, state: state(i), startedAt: NOW - 1_000, ...(i === 3 ? { handle: "sa-3" } : {}) })));
	const current = live({ subagents: children(progress("sa-3", "completed")), tick: 4 });
	const label = (item: FoldItem): string => (item.kind === "node" ? item.node.id : `${item.kind}:${nodesOf(item).length}`);
	expect(foldRows(big, 5, current).map(label)).toEqual(["n3", "n7", "n15", "n29", "more:26"]);
	expect(foldRows(big, 6, current).map(label)).toEqual(["n3", "n7", "n11", "n15", "n29", "more:25"]);
	expect(foldRows(big, 3, current).map(label)).toEqual(["n7", "n15", "more:28"]);
	expect(foldRows(big, 30, current).every((item) => item.kind === "node")).toBe(true);
	const lines = dagLines(big, 100, 5, current);
	expect(lines).toHaveLength(6);
	expect(lines.slice(1, 6).map((line) => spins(plain(line)))).toEqual([false, true, true, true, false]);
	expect(plain(lines[1]).startsWith(`${margin}1 +  ○ settling  @  n3`)).toBe(true);
	expect(plain(lines[2]).startsWith(`${margin}  |  ⠙ running   @  n7`)).toBe(true);
	expect(plain(lines[5]).trimEnd()).toBe(`${margin}  |  + 26 more - ○ 1 waiting - ○ 25 pending`);
});

test("A5 waves: zero spare keeps everything collapsed, far non-active pairs merge, singleton done waves expand for free", () => {
	const wave = (count: number, level: number, state: DagNodeState, from: number): DagNodeView[] =>
		Array.from({ length: count }, (_, k) => node({ id: `n${from + k}`, level, state, startedAt: NOW - 5_000, ...(state === "succeeded" ? { endedAt: NOW - 1_000 } : {}) }));
	const chain = view("running", [...wave(2, 0, "succeeded", 0), ...wave(2, 1, "succeeded", 2), ...wave(2, 2, "succeeded", 4), ...wave(2, 3, "succeeded", 6), ...wave(2, 4, "succeeded", 8), ...wave(2, 5, "running", 10)]);
	const items = foldRows(chain, 3);
	expect(items.map((item) => item.kind)).toEqual(["group", "wave", "wave"]);
	expect(items[0]).toMatchObject({ kind: "group", from: 0, to: 3 });
	expect(nodesOf(items[0]!)).toHaveLength(8);
	const lines = dagLines(chain, 100, 3, live()).map(plain);
	expect(lines[1]!.trimEnd()).toBe(`${margin}  +  waves 1-4 - ✓ 8 done`);
	expect(lines[2]!.trimEnd()).toBe(`${margin}5 +  ✓ 2 done  n8, n9`);
	expect(lines[3]!.trimEnd()).toBe(`${margin}6 +  ⠋ 2 running  n10, n11`);
	expect(foldRows(chain, 6).map((item) => item.kind)).toEqual(["wave", "wave", "wave", "wave", "wave", "wave"]);
	expect(foldRows(chain, 7).map((item) => item.kind)).toEqual(["wave", "wave", "wave", "wave", "wave", "node", "node"]);
	const zeroSpare = view("running", [...wave(2, 0, "succeeded", 0), ...wave(2, 1, "succeeded", 2), ...wave(2, 2, "running", 4), ...wave(2, 3, "pending", 6), ...wave(2, 4, "pending", 8)]);
	expect(foldRows(zeroSpare, 5).map((item) => item.kind)).toEqual(["wave", "wave", "wave", "wave", "wave"]);
	const quiet = view("verified", Array.from({ length: 6 }, (_, i) => node({ id: `n${i}`, level: i, state: "succeeded" })));
	const idle = foldRows(quiet, 3);
	expect(idle.map((item) => item.kind)).toEqual(["node", "node", "group"]);
	expect(idle[2]).toMatchObject({ kind: "group", from: 2, to: 5 });
	expect(dagLines(quiet, 100, 3, live()).map(plain).map((line) => line.trimEnd())).toEqual([
		`${fill(`${margin}DAG  ✓ verified - 6/6 done - reqs 0/1`, 100 - spacing.margin - 4)}/dag`,
		`${margin}1 +  ✓ done      @  n0  Title of n0`,
		`${margin}2 +  ✓ done      @  n1  Title of n1`,
		`${margin}  +  waves 3-6 - ✓ 4 done`,
	]);
	const mixed = view("running", [...wave(2, 0, "succeeded", 0), ...wave(2, 1, "running", 2), ...wave(2, 2, "succeeded", 4), ...wave(2, 3, "pending", 6), ...wave(2, 4, "pending", 8), ...wave(2, 5, "succeeded", 10)]);
	const grouped = foldRows(mixed, 3);
	expect(grouped.map((item) => item.kind)).toEqual(["wave", "wave", "group"]);
	expect(grouped[2]).toMatchObject({ kind: "group", from: 2, to: 5 });
	expect(plain(dagLines(mixed, 100, 3, live())[3]).trimEnd()).toBe(`${margin}  +  waves 3-6 - ✓ 4 done - ○ 4 pending`);
	expect(plain(dagLines(mixed, 100, 4, live())[4]).trimEnd()).toBe(`${margin}  +  waves 4-6 - ✓ 2 done - ○ 4 pending`);
});

test("A5 suffix remainder: when every adjacent pair has an active wave the first budget-1 items stay and one row owns the rest, unexpanded", () => {
	const ladder = view("running", Array.from({ length: 8 }, (_, i) => node({ id: `r${i}`, level: i, state: "ready" })));
	const cut = foldRows(ladder, 3);
	expect(cut.map((item) => item.kind)).toEqual(["wave", "wave", "rest"]);
	expect(nodesOf(cut[2]!).map((n) => n.id)).toEqual(["r2", "r3", "r4", "r5", "r6", "r7"]);
	const rows = dagLines(ladder, 100, 3, live()).map(plain);
	expect(rows[1]!.trimEnd()).toBe(`${margin}1 +  ○ 1 ready  r0`);
	expect(rows[3]!.trimEnd()).toBe(`${margin}  v  6 more nodes - ○ 6 ready`);
	const alternating = view("running", Array.from({ length: 10 }, (_, i) => node({ id: `a${i}`, level: i, state: i % 2 === 0 ? "ready" : "succeeded" })));
	const kept = foldRows(alternating, 4);
	expect(kept.map((item) => item.kind)).toEqual(["wave", "wave", "wave", "rest"]);
	expect(nodesOf(kept[3]!)).toHaveLength(7);
	expect(foldRows(alternating, 10).every((item) => item.kind === "node")).toBe(true);
});

test("DagPane: visible iff a run exists; lines cached per version, width and budget, per tick while running, per child status while in flight", () => {
	let dag: DagView | null = null;
	let version = 1;
	let tick = 0;
	const subagents = children(progress("sa-1", "running", "read"));
	const pane = new DagPane(() => ({ dag, version }), () => 40, () => live({ subagents, tick }));
	expect(pane.visible).toBe(false);
	expect(pane.render(100)).toEqual([]);
	dag = example();
	version = 2;
	expect(pane.visible).toBe(true);
	const first = pane.render(100);
	expect(first).toHaveLength(5);
	expect(pane.render(100)).toBe(first);
	tick = 4;
	const spun = pane.render(100);
	expect(spun).not.toBe(first);
	expect(plain(spun[3])).toContain("⠙ running");
	expect(pane.render(80)).toHaveLength(5);
	expect(pane.render(80).every((line) => visibleWidth(line) === 80)).toBe(true);
	subagents.set("sa-1", progress("sa-1", "completed"));
	const settling = pane.render(100);
	expect(plain(settling[3])).toContain("○ settling  @  bot");
	expect(plain(settling[3])).toContain("child completed - awaiting dag_step");
	tick = 8;
	expect(pane.render(100)).toBe(settling);
	dag = example("verified");
	version = 3;
	const settled = pane.render(100);
	expect(plain(settled[3])).toContain("○ running   @  bot");
	expect(plain(settled[3])).toContain("last seen - child completed - 1m2s");
	tick = 12;
	expect(pane.render(100)).toBe(settled);
	pane.invalidate();
	const again = pane.render(100);
	expect(again).not.toBe(settled);
	expect(again).toEqual(settled);
	dag = null;
	expect(pane.visible).toBe(false);
	expect(pane.render(100)).toEqual([]);
});
