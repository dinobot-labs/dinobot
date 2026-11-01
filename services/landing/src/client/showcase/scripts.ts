/**
 * Pure data: the four strength scenes (layout models) and every timeline script, including the demo's.
 * No DOM here, so test/showcase/scripts.test.ts can check that each script is well formed: sorted times, known
 * targets, known states and effects, label keys that exist, holds that point at buttons.
 *
 * Coordinates are stage pixels. Each strength scene is a STAGE_W x STAGE_H stage scaled to fit its host
 * (recommended host aspect ratio 4 / 3 for dag, memory, assignment and evolve; see index.ts).
 */
import type { LabelKey } from "./labels.ts";

export const STAGE_W = 440;
export const STAGE_H = 330;

export type SceneName = "dag" | "memory" | "assignment" | "evolve";
export const SCENE_NAMES: readonly SceneName[] = ["dag", "memory", "assignment", "evolve"];
export type Signal = "mint" | "teal" | "cyan" | "blue" | "indigo" | "red" | "ink";

/** One signal per screen (BRIEF / design-system 15): DAG mint, Memory teal, Assignment cyan, Self-improving blue, asks indigo. */
export const SCENE_SIGNAL: Readonly<Record<SceneName | "demo", Signal>> = {
	dag: "mint",
	memory: "teal",
	assignment: "cyan",
	evolve: "blue",
	demo: "ink",
};

/** Visual states. CSS styles each item type per state; transitions between them are WAAPI effects (transform/opacity). */
export const STATES = ["off", "on", "run", "wait", "done", "hot", "press", "dim"] as const;
export type State = (typeof STATES)[number];

/** Entrance and emphasis effects (engine.ts maps each to transform/opacity keyframes). */
export const EFFECTS = ["fade", "pop", "rise", "draw", "fly", "send", "tick", "fill", "bounce", "press", "out"] as const;
export type Fx = (typeof EFFECTS)[number];

export type GlyphName = "plan" | "memory" | "assign" | "learn" | "ask" | "check" | "chat" | "branch" | "lock" | "search";

export type ItemType =
	| "bubble" // chat message: `who` user initial or the bot mark
	| "node" // DAG step: kind line + label + status
	| "edge" // dotted connector between two items
	| "tag" // small mono label
	| "row" // flex row of child items (tags)
	| "btn" // choice button (a real <button> when `gate`)
	| "panel" // ask card holding a question; buttons are separate items placed on it
	| "card" // memory card / task card
	| "stack" // memory stack frame with header and plates
	| "track" // helper lane
	| "lead" // the orchestrator (mark + label)
	| "counter" // caption + number
	| "note" // a plain divider line of mono text
	| "result" // banner with a check
	| "station" // evolve loop station
	| "ring" // dotted circle
	| "arm" // orbiting token (rotates about its x,y)
	| "mascot" // mountMascot host
	| "badge" // a single signal dot
	| "pointer"; // the tap cursor

export interface Item {
	id: string;
	type: ItemType;
	x?: number;
	y?: number;
	w?: number;
	h?: number;
	label?: LabelKey;
	sub?: LabelKey;
	kind?: LabelKey;
	/** Literal, locale-neutral text (numbers, evidence ids, file names). */
	text?: string;
	glyph?: GlyphName;
	look?: "user" | "bot" | "plain" | "signal" | "solid" | "outline" | "primary";
	signal?: Signal;
	init?: State;
	/** edge endpoints and direction ("h": side to side, "v": bottom to top) */
	from?: string;
	to?: string;
	dir?: "h" | "v";
	/** ring / arm radius, ring dot count */
	r?: number;
	n?: number;
	/** pointer start position */
	xy?: readonly [number, number];
	children?: readonly Item[];
}

export interface Step {
	at: number;
	id: string;
	s?: State;
	fx?: Fx;
	/** effect duration override (ms) */
	dur?: number;
	/** fly: start offset relative to the final position */
	from?: readonly [number, number];
	/**
	 * send: a solid token travels these absolute stage points (its centre) through empty lanes, on top of everything,
	 * to the target item; the target then activates with its own step (BRIEF 12b.3: moving things never cross text).
	 */
	path?: readonly (readonly [number, number])[];
	/** pointer: move to this stage position */
	xy?: readonly [number, number];
	/** arm: rotate to this angle (deg) */
	rot?: number;
	/** replace the item's text with a literal */
	text?: string;
	/** replace the item's label */
	label?: LabelKey;
	/** mascot pose */
	pose?: "idle" | "happy" | "done" | "look-up";
	/** announce this label in the aria-live region (demo) */
	say?: LabelKey;
	/** wait here for a human tap on this button (at most `hold` ms; the pointer `tap` walks over and taps) */
	hold?: number;
	tap?: string;
}

export interface Script {
	/** last step time; the loop rests `rest` ms after it */
	duration: number;
	rest: number;
	steps: readonly Step[];
}

export interface SceneModel {
	name: SceneName;
	signal: Signal;
	alt: LabelKey;
	items: readonly Item[];
	script: Script;
}

const NW = 84;
const NH = 44;

// ------------------------------------------------------------------ DAG (mint)
const dagItems: Item[] = [
	{ id: "req", type: "bubble", x: 16, y: 12, w: 340, h: 50, look: "user", label: "dag.request", sub: "dag.who" },
	{
		id: "checks",
		type: "row",
		x: 16,
		y: 72,
		w: 412,
		h: 22,
		init: "on",
		children: [
			{ id: "compiled", type: "tag", look: "solid", label: "dag.compiled" },
			{ id: "c1", type: "tag", look: "outline", label: "dag.check.acyclic", glyph: "check" },
			{ id: "c2", type: "tag", look: "outline", label: "dag.check.coverage", glyph: "check" },
			{ id: "c3", type: "tag", look: "outline", label: "dag.check.race", glyph: "check" },
			{ id: "c4", type: "tag", look: "outline", label: "dag.check.authority", glyph: "check" },
		],
	},
	{ id: "read", type: "node", x: 12, y: 176, w: NW, h: NH, kind: "kind.act", label: "dag.node.read" },
	{ id: "en", type: "node", x: 122, y: 128, w: NW, h: NH, kind: "kind.delegate", label: "dag.node.draftEn" },
	{ id: "ko", type: "node", x: 122, y: 224, w: NW, h: NH, kind: "kind.delegate", label: "dag.node.draftKo" },
	{ id: "check", type: "node", x: 232, y: 176, w: NW, h: NH, kind: "kind.verify", label: "dag.node.check" },
	{ id: "approve", type: "node", x: 344, y: 176, w: NW, h: NH, kind: "kind.ask", label: "dag.node.approve", signal: "indigo" },
	{ id: "publish", type: "node", x: 344, y: 238, w: NW, h: NH, kind: "kind.act", label: "dag.node.publish" },
	{ id: "irrev", type: "tag", x: 226, y: 250, look: "outline", label: "dag.irreversible", glyph: "lock" },
	{ id: "result", type: "result", x: 12, y: 284, w: 290, h: 36, label: "dag.result" },
	{ id: "e1", type: "edge", from: "read", to: "en", dir: "h" },
	{ id: "e2", type: "edge", from: "read", to: "ko", dir: "h" },
	{ id: "e3", type: "edge", from: "en", to: "check", dir: "h" },
	{ id: "e4", type: "edge", from: "ko", to: "check", dir: "h" },
	{ id: "e5", type: "edge", from: "check", to: "approve", dir: "h" },
	{ id: "e6", type: "edge", from: "approve", to: "publish", dir: "v" },
	{ id: "e7", type: "edge", from: "publish", to: "result", dir: "h" },
	{ id: "ask", type: "panel", x: 318, y: 100, w: 110, h: 70, label: "dag.askQ", sub: "dag.default", signal: "indigo" },
	{ id: "yes", type: "btn", x: 326, y: 126, w: 52, h: 24, label: "dag.approve", look: "primary", signal: "indigo" },
	{ id: "no", type: "btn", x: 382, y: 126, w: 38, h: 24, label: "dag.deny", signal: "indigo" },
	{ id: "ptr", type: "pointer", xy: [262, 258] },
];

const dagScript: Script = {
	duration: 8300,
	rest: 2400,
	steps: [
		{ at: 0, id: "req", s: "on", fx: "rise" },
		{ at: 650, id: "compiled", s: "on", fx: "pop" },
		{ at: 850, id: "c1", s: "done", fx: "pop" },
		{ at: 1000, id: "c2", s: "done", fx: "pop" },
		{ at: 1150, id: "c3", s: "done", fx: "pop" },
		{ at: 1300, id: "c4", s: "done", fx: "pop" },
		{ at: 1500, id: "read", s: "on", fx: "pop" },
		{ at: 1600, id: "e1", s: "on", fx: "draw" },
		{ at: 1600, id: "e2", s: "on", fx: "draw" },
		{ at: 1700, id: "en", s: "on", fx: "pop" },
		{ at: 1760, id: "ko", s: "on", fx: "pop" },
		{ at: 1850, id: "e3", s: "on", fx: "draw" },
		{ at: 1850, id: "e4", s: "on", fx: "draw" },
		{ at: 1950, id: "check", s: "on", fx: "pop" },
		{ at: 2050, id: "e5", s: "on", fx: "draw" },
		{ at: 2150, id: "approve", s: "on", fx: "pop" },
		{ at: 2250, id: "e6", s: "on", fx: "draw" },
		{ at: 2350, id: "publish", s: "on", fx: "pop" },
		{ at: 2450, id: "irrev", s: "on", fx: "fade" },
		{ at: 2700, id: "read", s: "run" },
		{ at: 3300, id: "read", s: "done", fx: "tick" },
		{ at: 3300, id: "e1", s: "done" },
		{ at: 3300, id: "e2", s: "done" },
		{ at: 3350, id: "en", s: "run" },
		{ at: 3350, id: "ko", s: "run" },
		{ at: 4700, id: "en", s: "done", fx: "tick" },
		{ at: 4700, id: "e3", s: "done" },
		{ at: 5000, id: "ko", s: "done", fx: "tick" },
		{ at: 5000, id: "e4", s: "done" },
		{ at: 5100, id: "check", s: "run" },
		{ at: 6000, id: "check", s: "done", fx: "tick" },
		{ at: 6000, id: "e5", s: "done" },
		{ at: 6100, id: "approve", s: "wait" },
		{ at: 6150, id: "ask", s: "on", fx: "pop" },
		{ at: 6200, id: "yes", s: "on", fx: "fade" },
		{ at: 6200, id: "no", s: "on", fx: "fade" },
		{ at: 6300, id: "ptr", s: "on", fx: "fade" },
		{ at: 6400, id: "yes", hold: 2000, tap: "ptr" },
		{ at: 6420, id: "yes", s: "press", fx: "press" },
		{ at: 6650, id: "ask", s: "done" },
		{ at: 6650, id: "no", s: "dim" },
		{ at: 6700, id: "approve", s: "done", fx: "tick" },
		{ at: 6700, id: "e6", s: "done" },
		{ at: 6800, id: "ptr", s: "off", fx: "out" },
		{ at: 6800, id: "publish", s: "run" },
		{ at: 7700, id: "publish", s: "done", fx: "tick" },
		{ at: 7750, id: "e7", s: "on", fx: "draw" },
		{ at: 7900, id: "e7", s: "done" },
		{ at: 8000, id: "result", s: "done", fx: "pop" },
		{ at: 8300, id: "result", fx: "tick" },
	],
};

// ------------------------------------------------------------------ Memory (teal)
const memItems: Item[] = [
	{ id: "day1", type: "note", x: 16, y: 10, w: 236, h: 16, label: "mem.day1" },
	{ id: "msg1", type: "bubble", x: 16, y: 30, w: 236, h: 72, look: "user", label: "mem.msg1" },
	{ id: "noted", type: "tag", x: 16, y: 110, look: "signal", label: "mem.noted", glyph: "memory" },
	{ id: "team", type: "stack", x: 268, y: 10, w: 156, h: 108, label: "mem.team", sub: "mem.teamSub", init: "on" },
	{ id: "proj", type: "stack", x: 268, y: 130, w: 156, h: 154, label: "mem.project", sub: "mem.projectSub", init: "on" },
	{ id: "f3", type: "card", x: 276, y: 44, w: 140, h: 40, label: "mem.f3", glyph: "memory" },
	{ id: "f1", type: "card", x: 276, y: 164, w: 140, h: 40, label: "mem.f1", glyph: "memory" },
	{ id: "f2", type: "card", x: 276, y: 210, w: 140, h: 40, label: "mem.f2", glyph: "memory" },
	{ id: "day2", type: "note", x: 16, y: 148, w: 236, h: 16, label: "mem.day2" },
	{ id: "msg2", type: "bubble", x: 16, y: 168, w: 236, h: 40, look: "user", label: "mem.msg2" },
	{ id: "recall", type: "tag", x: 16, y: 216, w: 200, look: "solid", label: "mem.recall", glyph: "memory" },
	{ id: "r1", type: "edge", from: "recall", to: "f1", dir: "h" },
	{ id: "r2", type: "edge", from: "recall", to: "f2", dir: "h" },
	{ id: "ans", type: "bubble", x: 16, y: 246, w: 236, h: 68, look: "bot", label: "mem.answer" },
];

/** Token route from the "noted" tag to a memory slot centred at y: the free row y=120, then the gutter x=260. */
const MEM_LANE = (y: number): [number, number][] => [
	[124, 120],
	[260, 120],
	[260, y],
	[284, y],
];

const memScript: Script = {
	duration: 5600,
	rest: 2800,
	steps: [
		{ at: 0, id: "day1", s: "on", fx: "fade" },
		{ at: 250, id: "msg1", s: "on", fx: "rise" },
		{ at: 1250, id: "noted", s: "on", fx: "pop" },
		// Each fact leaves the "noted" tag as a token: right along the empty row under msg1, up or down the gutter
		// between the columns, into its slot. The card then pops from its ghost.
		{ at: 1400, id: "f3", fx: "send", dur: 520, path: MEM_LANE(64) },
		{ at: 1600, id: "f1", fx: "send", dur: 560, path: MEM_LANE(184) },
		{ at: 1800, id: "f2", fx: "send", dur: 600, path: MEM_LANE(230) },
		{ at: 1880, id: "f3", s: "on", fx: "pop" },
		{ at: 2120, id: "f1", s: "on", fx: "pop" },
		{ at: 2360, id: "f2", s: "on", fx: "pop" },
		{ at: 2900, id: "day2", s: "on", fx: "fade" },
		{ at: 3150, id: "msg2", s: "on", fx: "rise" },
		{ at: 3900, id: "r1", s: "on", fx: "draw" },
		{ at: 3900, id: "r2", s: "on", fx: "draw" },
		{ at: 4000, id: "f1", s: "hot", fx: "tick" },
		{ at: 4100, id: "f2", s: "hot", fx: "tick" },
		{ at: 4200, id: "recall", s: "on", fx: "pop" },
		{ at: 4300, id: "r1", s: "done" },
		{ at: 4300, id: "r2", s: "done" },
		{ at: 5000, id: "ans", s: "on", fx: "rise" },
		{ at: 5600, id: "noted", s: "dim" },
	],
};

// ------------------------------------------------------------------ Assignment (cyan)
const TRACK_Y = [74, 122, 170] as const;
const asgItems: Item[] = [
	{ id: "req", type: "bubble", x: 16, y: 10, w: 408, h: 50, look: "user", label: "asg.request" },
	{ id: "lead", type: "lead", x: 16, y: 98, w: 96, h: 80, label: "asg.lead" },
	{ id: "tA", type: "track", x: 132, y: TRACK_Y[0], w: 292, h: 40, label: "asg.helperA", kind: "kind.verify" },
	{ id: "tB", type: "track", x: 132, y: TRACK_Y[1], w: 292, h: 40, label: "asg.helperB", kind: "kind.verify" },
	{ id: "tC", type: "track", x: 132, y: TRACK_Y[2], w: 292, h: 40, label: "asg.helperC", kind: "kind.verify" },
	{ id: "eA", type: "edge", from: "lead", to: "tA", dir: "h" },
	{ id: "eB", type: "edge", from: "lead", to: "tB", dir: "h" },
	{ id: "eC", type: "edge", from: "lead", to: "tC", dir: "h" },
	{ id: "kA", type: "card", x: 212, y: TRACK_Y[0] + 6, w: 120, h: 28, label: "asg.taskA", glyph: "assign" },
	{ id: "kB", type: "card", x: 212, y: TRACK_Y[1] + 6, w: 120, h: 28, label: "asg.taskB", glyph: "assign" },
	{ id: "kC", type: "card", x: 212, y: TRACK_Y[2] + 6, w: 120, h: 28, label: "asg.taskC", glyph: "assign" },
	{ id: "nA", type: "counter", x: 340, y: TRACK_Y[0] + 10, w: 56, h: 20, label: "asg.tools", text: "0" },
	{ id: "nB", type: "counter", x: 340, y: TRACK_Y[1] + 10, w: 56, h: 20, label: "asg.tools", text: "0" },
	{ id: "nC", type: "counter", x: 340, y: TRACK_Y[2] + 10, w: 56, h: 20, label: "asg.tools", text: "0" },
	{ id: "ask", type: "panel", x: 16, y: 188, w: 106, h: 132, label: "asg.askQ", signal: "indigo" },
	{ id: "oA", type: "btn", x: 24, y: 262, w: 90, h: 24, label: "asg.optA", signal: "indigo" },
	{ id: "oB", type: "btn", x: 24, y: 290, w: 90, h: 24, label: "asg.optB", look: "primary", signal: "indigo" },
	{
		id: "claim",
		type: "row",
		x: 132,
		y: 222,
		w: 292,
		h: 22,
		children: [
			{ id: "file", type: "tag", look: "outline", text: "emails/b.md", glyph: "lock" },
			{ id: "claimed", type: "tag", look: "signal", label: "asg.claimed" },
		],
	},
	{ id: "thB", type: "tag", x: 300, y: 252, w: 124, look: "outline", label: "asg.threadB", sub: "asg.waits", glyph: "branch" },
	{ id: "merged", type: "result", x: 132, y: 286, w: 256, h: 34, label: "asg.merged" },
	{ id: "ptr", type: "pointer", xy: [136, 326] },
];

/** Token route from the lead's right edge to a helper track at y: the gutter x=122 between them. */
const ASG_LANE = (y: number): [number, number][] => [
	[114, 138],
	[122, 138],
	[122, y + 20],
	[132, y + 20],
];

const asgScript: Script = {
	duration: 7800,
	rest: 2800,
	steps: [
		{ at: 0, id: "req", s: "on", fx: "rise" },
		{ at: 650, id: "lead", s: "on", fx: "pop" },
		{ at: 1050, id: "tA", s: "on", fx: "rise" },
		{ at: 1050, id: "eA", s: "on", fx: "draw" },
		{ at: 1150, id: "tB", s: "on", fx: "rise" },
		{ at: 1150, id: "eB", s: "on", fx: "draw" },
		{ at: 1250, id: "tC", s: "on", fx: "rise" },
		{ at: 1250, id: "eC", s: "on", fx: "draw" },
		// The lead hands each task out as a token down the empty gutter between the lead and the helpers (x=122);
		// the helper's task chip pops in its own slot when the token lands.
		{ at: 1500, id: "kA", fx: "send", dur: 380, path: ASG_LANE(TRACK_Y[0]) },
		{ at: 1600, id: "eA", s: "done" },
		{ at: 1650, id: "kB", fx: "send", dur: 300, path: ASG_LANE(TRACK_Y[1]) },
		{ at: 1750, id: "eB", s: "done" },
		{ at: 1830, id: "kA", s: "on", fx: "pop" },
		{ at: 1900, id: "eC", s: "done" },
		{ at: 1900, id: "kB", s: "on", fx: "pop" },
		{ at: 1950, id: "kC", fx: "send", dur: 360, path: ASG_LANE(TRACK_Y[2]) },
		{ at: 2260, id: "kC", s: "on", fx: "pop" },
		{ at: 2350, id: "tA", s: "run" },
		{ at: 2350, id: "tB", s: "run" },
		{ at: 2350, id: "tC", s: "run" },
		{ at: 2350, id: "nA", s: "on", fx: "fade" },
		{ at: 2350, id: "nB", s: "on", fx: "fade" },
		{ at: 2350, id: "nC", s: "on", fx: "fade" },
		{ at: 2650, id: "nA", text: "1", fx: "tick" },
		{ at: 2850, id: "nB", text: "1", fx: "tick" },
		{ at: 3000, id: "nC", text: "1", fx: "tick" },
		{ at: 3250, id: "nA", text: "2", fx: "tick" },
		{ at: 3400, id: "nB", text: "2", fx: "tick" },
		{ at: 3600, id: "nC", text: "2", fx: "tick" },
		{ at: 3850, id: "nB", text: "3", fx: "tick" },
		{ at: 3950, id: "nA", text: "3", fx: "tick" },
		{ at: 4200, id: "tA", s: "done", fx: "tick" },
		{ at: 4350, id: "nB", text: "4", fx: "tick" },
		{ at: 4400, id: "tC", s: "done", fx: "tick" },
		{ at: 4700, id: "tB", s: "done", fx: "tick" },
		{ at: 4900, id: "ask", s: "on", fx: "pop" },
		{ at: 4950, id: "oA", s: "on", fx: "fade" },
		{ at: 4950, id: "oB", s: "on", fx: "fade" },
		{ at: 5000, id: "ptr", s: "on", fx: "fade" },
		{ at: 5100, id: "oB", hold: 1800, tap: "ptr" },
		{ at: 5120, id: "oB", s: "press", fx: "press" },
		{ at: 5350, id: "ask", s: "done" },
		{ at: 5350, id: "oA", s: "dim" },
		{ at: 5450, id: "ptr", s: "off", fx: "out" },
		{ at: 5500, id: "kB", label: "asg.taskRewrite", fx: "tick" },
		{ at: 5500, id: "tB", s: "run" },
		{ at: 5500, id: "nB", text: "0" },
		{ at: 5700, id: "claim", s: "on" },
		{ at: 5700, id: "file", s: "on", fx: "pop" },
		{ at: 5850, id: "claimed", s: "on", fx: "pop" },
		{ at: 6000, id: "nB", text: "1", fx: "tick" },
		{ at: 6250, id: "thB", s: "on", fx: "fly", from: [70, 0] },
		{ at: 6800, id: "thB", s: "wait", fx: "bounce" },
		{ at: 6900, id: "nB", text: "2", fx: "tick" },
		{ at: 7500, id: "tB", s: "done", fx: "tick" },
		{ at: 7800, id: "merged", s: "done", fx: "pop" },
	],
};

// ------------------------------------------------------------------ Self-improving harness (blue)
const CX = 220;
const CY = 168;
const RING_R = 112;
const SW = 128;
const SH = 44;
// The bottom station holds the longest label ("Agreements & skills"), so it is wider to keep the text inside
// its card; it still clears the lesson card (x <= 144) and the applied result (x >= 300).
const SW_WIDE = 140;
const evoItems: Item[] = [
	{ id: "ring", type: "ring", x: CX, y: CY, r: RING_R, n: 44, init: "on" },
	{ id: "sWork", type: "station", x: CX - SW / 2, y: CY - RING_R - SH / 2, w: SW, h: SH, label: "evo.work", sub: "evo.workSub", glyph: "chat", init: "on" },
	{ id: "sRetro", type: "station", x: CX + RING_R - SW / 2, y: CY - SH / 2, w: SW, h: SH, label: "evo.retro", sub: "evo.retroSub", glyph: "search", init: "on" },
	{ id: "sRules", type: "station", x: CX - SW_WIDE / 2, y: CY + RING_R - SH / 2, w: SW_WIDE, h: SH, label: "evo.rules", sub: "evo.rulesSub", glyph: "learn", init: "on" },
	{ id: "sNext", type: "station", x: CX - RING_R - SW / 2, y: CY - SH / 2, w: SW, h: SH, label: "evo.next", sub: "evo.nextSub", glyph: "branch", init: "on" },
	{ id: "arm", type: "arm", x: CX, y: CY, r: RING_R, init: "on" },
	{ id: "mascot", type: "mascot", x: CX - 48, y: CY - 30, w: 96, h: 58, init: "on" },
	{ id: "badge", type: "badge", x: CX + 34, y: CY - 44, w: 16, h: 16, label: "evo.badge" },
	{ id: "corr", type: "bubble", x: 12, y: 10, w: 142, h: 70, look: "user", label: "evo.correction" },
	{ id: "nAgr", type: "counter", x: 304, y: 12, w: 124, h: 22, label: "evo.agreements", text: "2", init: "on" },
	{ id: "nSkl", type: "counter", x: 304, y: 38, w: 124, h: 22, label: "evo.skills", text: "4", init: "on" },
	{
		id: "ev",
		type: "row",
		x: 296,
		y: 198,
		w: 134,
		h: 22,
		children: [
			{ id: "ev0", type: "tag", look: "plain", label: "evo.evidence" },
			{ id: "ev1", type: "tag", look: "outline", text: "e12" },
			{ id: "ev2", type: "tag", look: "outline", text: "h3" },
		],
	},
	{ id: "lesson", type: "card", x: 12, y: 266, w: 132, h: 44, label: "evo.lesson", glyph: "learn" },
	{ id: "applied", type: "result", x: 300, y: 230, w: 128, h: 40, label: "evo.applied" },
];

const evoScript: Script = {
	duration: 8300,
	rest: 1700,
	steps: [
		{ at: 0, id: "sWork", s: "hot", fx: "tick" },
		{ at: 150, id: "corr", s: "on", fx: "rise" },
		{ at: 1000, id: "arm", rot: 90, dur: 900 },
		{ at: 1000, id: "sWork", s: "done" },
		{ at: 1900, id: "sRetro", s: "hot", fx: "tick" },
		{ at: 2000, id: "ev", s: "on" },
		{ at: 2000, id: "ev0", s: "on", fx: "fade" },
		{ at: 2150, id: "ev1", s: "on", fx: "pop" },
		{ at: 2300, id: "ev2", s: "on", fx: "pop" },
		{ at: 3000, id: "arm", rot: 180, dur: 900 },
		{ at: 3000, id: "sRetro", s: "done" },
		{ at: 3900, id: "sRules", s: "hot", fx: "tick" },
		{ at: 4000, id: "lesson", s: "on", fx: "rise" },
		{ at: 4300, id: "nAgr", text: "3", s: "hot", fx: "tick" },
		{ at: 4600, id: "nSkl", text: "5", s: "hot", fx: "tick" },
		{ at: 5100, id: "arm", rot: 270, dur: 900 },
		{ at: 5100, id: "sRules", s: "done" },
		{ at: 6000, id: "sNext", s: "hot", fx: "tick" },
		{ at: 6150, id: "applied", s: "done", fx: "pop" },
		{ at: 6700, id: "badge", s: "on", fx: "pop" },
		{ at: 6700, id: "mascot", pose: "happy" },
		{ at: 7400, id: "arm", rot: 360, dur: 900 },
		{ at: 7400, id: "sNext", s: "done" },
		{ at: 8300, id: "sWork", s: "hot", fx: "tick" },
	],
};

export const SCENES: Readonly<Record<SceneName, SceneModel>> = {
	dag: { name: "dag", signal: SCENE_SIGNAL.dag, alt: "dag.alt", items: dagItems, script: dagScript },
	memory: { name: "memory", signal: SCENE_SIGNAL.memory, alt: "mem.alt", items: memItems, script: memScript },
	assignment: { name: "assignment", signal: SCENE_SIGNAL.assignment, alt: "asg.alt", items: asgItems, script: asgScript },
	evolve: { name: "evolve", signal: SCENE_SIGNAL.evolve, alt: "evo.alt", items: evoItems, script: evoScript },
};

/** Every item id in a model, children included. */
export function itemIds(items: readonly Item[]): string[] {
	const out: string[] = [];
	for (const item of items) {
		out.push(item.id);
		if (item.children) out.push(...itemIds(item.children));
	}
	return out;
}

export function findItem(items: readonly Item[], id: string): Item | undefined {
	for (const item of items) {
		if (item.id === id) return item;
		const hit = item.children && findItem(item.children, id);
		if (hit) return hit;
	}
	return undefined;
}

// ------------------------------------------------------------------ Demo ("Watch it work")
export const DEMO_REQUESTS = ["r1", "r2", "r3"] as const;
export type DemoRequest = (typeof DEMO_REQUESTS)[number];

/** Per-request label keys (all three requests share one timeline). */
export const DEMO_SLOTS = ["chip", "request", "p1", "p2", "p3", "p4", "p5", "h1", "h2", "h3", "mem", "c1", "c2", "c3", "answer", "learn"] as const;
export type DemoSlot = (typeof DEMO_SLOTS)[number];
export function demoKey(request: DemoRequest, slot: DemoSlot): LabelKey {
	return `demo.${request}.${slot}` as LabelKey;
}

/** The chapters of the step bar, Tasklet-style (C13): start and end times on the demo timeline. */
export const DEMO_CHAPTERS = [
	{ id: "plan", label: "demo.step.plan", at: 0, end: 2400 },
	{ id: "assign", label: "demo.step.assign", at: 2400, end: 5200 },
	{ id: "remember", label: "demo.step.remember", at: 5200, end: 6600 },
	{ id: "verify", label: "demo.step.verify", at: 6600, end: 8400 },
	{ id: "answer", label: "demo.step.answer", at: 8400, end: 10400 },
] as const satisfies readonly { id: string; label: LabelKey; at: number; end: number }[];

/** Ids the demo DOM registers (demo.ts); the demo script may only target these. */
export const DEMO_IDS = [
	"status",
	"req",
	"typing",
	"card",
	"planHead",
	"p1",
	"p2",
	"p3",
	"p4",
	"p5",
	"helpersHead",
	"h1",
	"h2",
	"h3",
	"h1f",
	"h2f",
	"h3f",
	"memHead",
	"mem",
	"checksHead",
	"c1",
	"c2",
	"c3",
	"ans",
	"learn",
	"bar1",
	"bar2",
	"bar3",
	"bar4",
	"bar5",
] as const;

const chapterSteps: Step[] = DEMO_CHAPTERS.flatMap((c, i) => [
	{ at: c.at, id: `bar${i + 1}`, s: "run" as const, fx: "fill" as const, dur: c.end - c.at },
	{ at: c.end, id: `bar${i + 1}`, s: "done" as const },
]);

export const DEMO_SCRIPT: Script = {
	duration: 10400,
	rest: 0,
	steps: sortedSteps([
		...chapterSteps,
		{ at: 0, id: "status", s: "run" },
		{ at: 0, id: "req", s: "on", fx: "rise", say: "demo.say.plan" },
		{ at: 350, id: "typing", s: "on", fx: "fade" },
		{ at: 900, id: "typing", s: "off" },
		{ at: 900, id: "card", s: "on", fx: "rise" },
		{ at: 1000, id: "planHead", s: "on", fx: "fade" },
		{ at: 1100, id: "p1", s: "on", fx: "pop" },
		{ at: 1250, id: "p2", s: "on", fx: "pop" },
		{ at: 1400, id: "p3", s: "on", fx: "pop" },
		{ at: 1550, id: "p4", s: "on", fx: "pop" },
		{ at: 1700, id: "p5", s: "on", fx: "pop" },
		{ at: 1900, id: "p1", s: "run" },
		{ at: 2300, id: "p1", s: "done", fx: "tick" },
		{ at: 2400, id: "p2", s: "run", say: "demo.say.assign" },
		{ at: 2400, id: "helpersHead", s: "on", fx: "fade" },
		{ at: 2450, id: "h1", s: "on", fx: "rise" },
		{ at: 2550, id: "h2", s: "on", fx: "rise" },
		{ at: 2650, id: "h3", s: "on", fx: "rise" },
		{ at: 2800, id: "p2", s: "done", fx: "tick" },
		{ at: 2800, id: "p3", s: "run" },
		{ at: 2800, id: "h1", s: "run" },
		{ at: 2800, id: "h2", s: "run" },
		{ at: 2800, id: "h3", s: "run" },
		{ at: 2800, id: "h1f", s: "run", fx: "fill", dur: 1700 },
		{ at: 2800, id: "h2f", s: "run", fx: "fill", dur: 2100 },
		{ at: 2800, id: "h3f", s: "run", fx: "fill", dur: 1400 },
		{ at: 4200, id: "h3", s: "done", fx: "tick" },
		{ at: 4200, id: "h3f", s: "done" },
		{ at: 4500, id: "h1", s: "done", fx: "tick" },
		{ at: 4500, id: "h1f", s: "done" },
		{ at: 4900, id: "h2", s: "done", fx: "tick" },
		{ at: 4900, id: "h2f", s: "done" },
		{ at: 5000, id: "p3", s: "done", fx: "tick" },
		{ at: 5200, id: "memHead", s: "on", fx: "fade", say: "demo.say.remember" },
		{ at: 5300, id: "mem", s: "on", fx: "pop" },
		{ at: 5800, id: "mem", s: "hot", fx: "tick" },
		{ at: 6600, id: "p4", s: "run" },
		{ at: 6600, id: "checksHead", s: "on", fx: "fade" },
		{ at: 6700, id: "c1", s: "on", fx: "rise" },
		{ at: 6950, id: "c2", s: "on", fx: "rise" },
		{ at: 7200, id: "c3", s: "on", fx: "rise" },
		{ at: 7150, id: "c1", s: "done", fx: "tick" },
		{ at: 7550, id: "c2", s: "done", fx: "tick" },
		{ at: 7950, id: "c3", s: "done", fx: "tick", say: "demo.say.verify" },
		{ at: 8100, id: "p4", s: "done", fx: "tick" },
		{ at: 8400, id: "p5", s: "run" },
		{ at: 8600, id: "ans", s: "on", fx: "rise", say: "demo.say.answer" },
		{ at: 8900, id: "p5", s: "done", fx: "tick" },
		{ at: 9600, id: "learn", s: "on", fx: "pop", say: "demo.say.learn" },
		{ at: 10400, id: "status", s: "done" },
	]),
};

/** Stable sort by time; scripts are authored mostly in order, and the engine relies on ascending `at`. */
export function sortedSteps(steps: readonly Step[]): Step[] {
	return steps.map((s, i) => [s, i] as const).sort((a, b) => a[0].at - b[0].at || a[1] - b[1]).map(([s]) => s);
}
