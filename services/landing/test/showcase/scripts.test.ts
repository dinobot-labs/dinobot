import { describe, expect, test } from "bun:test";
import { edgeDots, rectOf } from "../../src/client/showcase/geometry.ts";
import { LABELS } from "../../src/client/showcase/labels.ts";
import {
	DEMO_CHAPTERS,
	DEMO_IDS,
	DEMO_REQUESTS,
	DEMO_SCRIPT,
	DEMO_SLOTS,
	EFFECTS,
	type Item,
	SCENE_NAMES,
	SCENE_SIGNAL,
	SCENES,
	STAGE_H,
	STAGE_W,
	STATES,
	type Script,
	demoKey,
	findItem,
	itemIds,
} from "../../src/client/showcase/scripts.ts";

const labelKeys = new Set(Object.keys(LABELS.en));
const states = new Set<string>(STATES);
const effects = new Set<string>(EFFECTS);

function allItems(items: readonly Item[]): Item[] {
	return items.flatMap((i) => [i, ...allItems(i.children ?? [])]);
}

/** Checks shared by every script; `typeOf` resolves a target id to its item type (or "demo" for demo ids). */
function checkScript(name: string, script: Script, ids: Set<string>, typeOf: (id: string) => string | undefined) {
	expect(script.duration, name).toBeGreaterThan(0);
	expect(script.rest, name).toBeGreaterThanOrEqual(0);
	let prev = -1;
	let last = 0;
	for (const [n, step] of script.steps.entries()) {
		const where = `${name} step ${n} (${step.id} @${step.at})`;
		expect(Number.isFinite(step.at), where).toBe(true);
		expect(step.at, where).toBeGreaterThanOrEqual(0);
		expect(step.at, `${where}: authored in time order`).toBeGreaterThanOrEqual(prev);
		prev = step.at;
		last = Math.max(last, step.at);
		expect(ids.has(step.id), `${where}: unknown target`).toBe(true);
		if (step.s !== undefined) expect(states.has(step.s), where).toBe(true);
		if (step.fx !== undefined) expect(effects.has(step.fx), where).toBe(true);
		if (step.fx === "fly") expect(step.from?.length, `${where}: fly needs from`).toBe(2);
		if (step.fx === "send") {
			expect(step.path?.length ?? 0, `${where}: send needs a path`).toBeGreaterThanOrEqual(2);
			for (const p of step.path ?? []) expect(p.length, where).toBe(2);
		}
		if (step.fx === "fill") expect(step.dur, `${where}: fill needs dur`).toBeGreaterThan(0);
		if (step.label !== undefined) expect(labelKeys.has(step.label), where).toBe(true);
		if (step.say !== undefined) expect(labelKeys.has(step.say), where).toBe(true);
		if (step.dur !== undefined) expect(step.dur, where).toBeGreaterThan(0);
		const type = typeOf(step.id);
		if (step.rot !== undefined) expect(type, `${where}: rot only on arms`).toBe("arm");
		if (step.xy !== undefined) expect(type, `${where}: xy only on pointers`).toBe("pointer");
		if (step.pose !== undefined) expect(type, `${where}: pose only on the mascot`).toBe("mascot");
		if (step.text !== undefined) expect(type === "counter" || type === "demo", `${where}: text only on counters`).toBe(true);
		if (step.hold !== undefined) {
			expect(step.hold, where).toBeGreaterThan(0);
			expect(type, `${where}: holds wait on a button`).toBe("btn");
			expect(step.tap && typeOf(step.tap), `${where}: tap names a pointer`).toBe("pointer");
			// the pointer is visible before it walks to the button
			expect(script.steps.some((s) => s.id === step.tap && s.s === "on" && s.at <= step.at)).toBe(true);
		}
	}
	expect(last, `${name}: duration covers every step`).toBeLessThanOrEqual(script.duration);
	expect(last, `${name}: duration is the last step time`).toBe(script.duration);
}

describe("strength scene models", () => {
	test("all four scenes exist with their signal", () => {
		expect(SCENE_NAMES).toEqual(["dag", "memory", "assignment", "evolve"]);
		expect(SCENE_SIGNAL).toEqual({ dag: "mint", memory: "teal", assignment: "cyan", evolve: "blue", demo: "ink" });
		for (const name of SCENE_NAMES) expect(SCENES[name].signal).toBe(SCENE_SIGNAL[name]);
	});

	for (const name of SCENE_NAMES) {
		describe(name, () => {
			const model = SCENES[name];
			const items = allItems(model.items);
			const ids = itemIds(model.items);
			const idSet = new Set(ids);

			test("pure data (JSON round trip)", () => {
				expect(JSON.parse(JSON.stringify(model))).toEqual(model as never);
			});

			test("unique ids, known label keys, items inside the stage", () => {
				expect(idSet.size).toBe(ids.length);
				expect(labelKeys.has(model.alt)).toBe(true);
				for (const item of items) {
					for (const k of [item.label, item.sub, item.kind]) if (k !== undefined) expect(labelKeys.has(k), `${item.id}: ${k}`).toBe(true);
					if (item.init !== undefined) expect(states.has(item.init), item.id).toBe(true);
					if (item.x !== undefined && item.w !== undefined && item.type !== "ring" && item.type !== "arm") {
						expect(item.x, item.id).toBeGreaterThanOrEqual(0);
						expect(item.y!, item.id).toBeGreaterThanOrEqual(0);
						expect(item.x + item.w, `${item.id} right edge`).toBeLessThanOrEqual(STAGE_W);
						expect(item.y! + (item.h ?? 22), `${item.id} bottom edge`).toBeLessThanOrEqual(STAGE_H);
					}
					if (item.type === "ring" || item.type === "arm") {
						const r = item.r ?? 0;
						expect(item.x! - r).toBeGreaterThanOrEqual(0);
						expect(item.x! + r).toBeLessThanOrEqual(STAGE_W);
					}
				}
			});

			test("edges join existing items with a dotted curve inside the stage", () => {
				for (const edge of items.filter((i) => i.type === "edge")) {
					const a = findItem(model.items, edge.from!);
					const b = findItem(model.items, edge.to!);
					expect(a, `${edge.id}.from`).toBeDefined();
					expect(b, `${edge.id}.to`).toBeDefined();
					const dots = edgeDots(rectOf(a!), rectOf(b!), edge.dir ?? "h");
					expect(dots.length, edge.id).toBeGreaterThanOrEqual(2);
					for (const [x, y] of dots) {
						expect(x >= 0 && x <= STAGE_W && y >= 0 && y <= STAGE_H, `${edge.id} ${x},${y}`).toBe(true);
					}
				}
			});

			test("timeline is well formed", () => {
				checkScript(name, model.script, idSet, (id) => findItem(model.items, id)?.type);
			});

			test("everything hidden at the start is revealed by some step", () => {
				for (const item of items) {
					if ((item.init ?? "off") !== "off") continue;
					const shown = model.script.steps.some((s) => s.id === item.id && s.s !== undefined && s.s !== "off");
					expect(shown, `${name}.${item.id} never shown`).toBe(true);
				}
			});

			test("loop length stays in a calm range", () => {
				const total = model.script.duration + model.script.rest;
				expect(total).toBeGreaterThanOrEqual(6000);
				expect(total).toBeLessThanOrEqual(14000);
			});
		});
	}

	test("the DAG plan has 6 to 8 steps, parallel drafts, a verify and an ask before the irreversible publish", () => {
		const nodes = SCENES.dag.items.filter((i) => i.type === "node");
		expect(nodes.length).toBeGreaterThanOrEqual(6);
		expect(nodes.length).toBeLessThanOrEqual(8);
		const kinds = nodes.map((n) => n.kind);
		expect(kinds).toContain("kind.verify");
		expect(kinds).toContain("kind.ask");
		const steps = SCENES.dag.script.steps;
		const runAt = (id: string) => steps.find((s) => s.id === id && s.s === "run")!.at;
		const doneAt = (id: string) => steps.find((s) => s.id === id && s.s === "done")!.at;
		expect(runAt("en")).toBe(runAt("ko")); // independent branches run in parallel
		expect(doneAt("check")).toBeLessThan(runAt("publish"));
		expect(doneAt("approve")).toBeLessThan(runAt("publish"));
		expect(steps.some((s) => s.hold && s.id === "yes")).toBe(true); // waits for a human tap
	});

	test("assignment runs three helpers in parallel and sends one decision to a person", () => {
		const steps = SCENES.assignment.script.steps;
		const runs = steps.filter((s) => s.s === "run" && ["tA", "tB", "tC"].includes(s.id));
		expect(new Set(runs.slice(0, 3).map((s) => s.at)).size).toBe(1);
		expect(steps.filter((s) => s.hold).length).toBe(1);
		expect(steps.some((s) => s.id === "thB" && s.fx === "bounce")).toBe(true); // the claim stops thread B
	});
});

describe("demo script", () => {
	const ids = new Set<string>(DEMO_IDS);

	test("pure data and well formed", () => {
		expect(JSON.parse(JSON.stringify(DEMO_SCRIPT))).toEqual(DEMO_SCRIPT as never);
		checkScript("demo", DEMO_SCRIPT, ids, () => "demo");
		expect(DEMO_SCRIPT.steps.some((s) => s.hold)).toBe(false);
	});

	test("about ten seconds, chapters contiguous and covering the run", () => {
		expect(DEMO_SCRIPT.duration).toBeGreaterThanOrEqual(9000);
		expect(DEMO_SCRIPT.duration).toBeLessThanOrEqual(11000);
		expect(DEMO_CHAPTERS[0]!.at).toBe(0);
		for (let i = 1; i < DEMO_CHAPTERS.length; i++) expect<number>(DEMO_CHAPTERS[i]!.at).toBe(DEMO_CHAPTERS[i - 1]!.end);
		expect<number>(DEMO_CHAPTERS.at(-1)!.end).toBe(DEMO_SCRIPT.duration);
		for (const c of DEMO_CHAPTERS) expect(labelKeys.has(c.label)).toBe(true);
	});

	test("order of the story: plan, helpers, memory recall, checks, answer, learned", () => {
		const first = (id: string) => DEMO_SCRIPT.steps.find((s) => s.id === id && s.s === "on")!.at;
		const order = ["p1", "h1", "mem", "c1", "ans", "learn"].map(first);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	test("every demo id is used and every request has all of its labels", () => {
		for (const id of DEMO_IDS) expect(DEMO_SCRIPT.steps.some((s) => s.id === id), id).toBe(true);
		for (const r of DEMO_REQUESTS) for (const slot of DEMO_SLOTS) expect(labelKeys.has(demoKey(r, slot)), demoKey(r, slot)).toBe(true);
	});

	test("narration covers each chapter and the learned agreement", () => {
		const said = DEMO_SCRIPT.steps.filter((s) => s.say).map((s) => s.say);
		expect(said).toEqual(["demo.say.plan", "demo.say.assign", "demo.say.remember", "demo.say.verify", "demo.say.answer", "demo.say.learn"]);
	});
});
