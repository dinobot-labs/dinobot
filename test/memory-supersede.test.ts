import { describe, expect, test } from "bun:test";
import {
	addAgreement, agreementCapacity, type AgreementsState, agreementId, editAgreement, forgetAgreement, mergeAgreements, violateAgreement,
} from "../src/core/memory/agreements.ts";
import { curatedItems, knownMemories, renderKnown } from "../src/core/memory/curator.ts";
import { noteText } from "../src/core/memory/recall.ts";
import { orderRetroOps, parseRetroOutput, renderRetroPrompt, type RetroOp } from "../src/core/memory/retro.ts";
import { addAuto, autoKey, find, MAX_MEMORY_EVIDENCE, type MemoryState, mutate, replaceAuto } from "../src/core/memory/store.ts";

const P = "/repo/a";
const DAY = Date.UTC(2026, 9, 1);
const empty = (): MemoryState => ({ entries: [], revision: 0 });
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const at = (now: number, conversationId = 1, turn = 2) => ({ now, evidence: { conversationId, turn } });

describe("provenance", () => {
	test("an extracted memory records when and from which window; a re-extraction only adds evidence", () => {
		const state = empty();
		const { key } = addAuto(state, P, "Deploys use GitHub Actions.", 10, at(DAY, 7, 4));
		expect(find(state, key, P)).toMatchObject({ origin: "auto", createdAt: DAY, updatedAt: DAY, evidence: [{ conversationId: 7, turn: 4 }], revision: 1 });
		expect(addAuto(state, P, "deploys use  github actions.", 10, at(DAY + 5, 9, 12)).status).toBe("exists");
		// Same window twice (a crashed attempt replayed) is one evidence item; content, times and revision stay.
		addAuto(state, P, "Deploys use GitHub Actions.", 10, at(DAY + 6, 9, 12));
		expect(find(state, key, P)).toMatchObject({ createdAt: DAY, updatedAt: DAY, revision: 1, evidence: [{ conversationId: 7, turn: 4 }, { conversationId: 9, turn: 12 }] });
		for (let turn = 20; turn < 40; turn++) addAuto(state, P, "Deploys use GitHub Actions.", 10, at(DAY, 9, turn));
		expect(find(state, key, P)!.evidence).toHaveLength(MAX_MEMORY_EVIDENCE);
		expect(find(state, key, P)!.evidence!.at(-1)).toEqual({ conversationId: 9, turn: 39 });
	});

	test("explicit writes keep the first time, stamp the update, and drop the automatic origin and evidence", () => {
		const state = empty();
		mutate(state, "deploy", P, "v1", 0, DAY);
		mutate(state, "deploy", P, "v2", 1, DAY + 10);
		expect(find(state, "deploy", P)).toMatchObject({ content: "v2", createdAt: DAY, updatedAt: DAY + 10 });
		const { key } = addAuto(state, P, "Extracted.", 10, at(DAY));
		mutate(state, key, P, "Edited by a person.", undefined, DAY + 20);
		const edited = find(state, key, P)!;
		expect(edited).toMatchObject({ createdAt: DAY, updatedAt: DAY + 20 });
		expect(edited.origin).toBeUndefined();
		expect(edited.evidence).toBeUndefined();
	});

	test("entries stored before provenance stay valid and gain times only when written again", () => {
		const legacy: MemoryState = { entries: [{ key: "old", content: "x", revision: 1, project: P }, { key: autoKey(P, "Old fact."), content: "Old fact.", revision: 2, project: P, origin: "auto" }], revision: 2 };
		expect(addAuto(legacy, P, "Old fact.", 10).status).toBe("exists");
		expect(find(legacy, autoKey(P, "Old fact."), P)!.evidence).toBeUndefined();
		mutate(legacy, "old", P, "y", 1, DAY);
		expect(find(legacy, "old", P)).toMatchObject({ createdAt: DAY, updatedAt: DAY });
		// Without provenance (old callers) nothing new is stamped.
		const plain = addAuto(legacy, P, "No provenance.", 10);
		expect(Object.keys(find(legacy, plain.key, P)!).sort()).toEqual(["content", "key", "origin", "project", "revision"]);
	});

	test("tools and recall show the saved date", () => {
		expect(noteText([{ key: "auto/1", content: "Fact.", savedAt: DAY }])).toContain("(memory key auto/1, scope project, saved 2026-10-01)");
		expect(noteText([{ key: "auto/1", content: "Fact." }])).toContain("(memory key auto/1, scope project)");
	});
});

describe("supersede (replaceAuto)", () => {
	test("a contradicting memory replaces the old one, which is forgotten; evidence carries over", () => {
		const state = empty();
		const old = addAuto(state, P, "Deploys use Jenkins.", 10, at(DAY, 1, 2)).key;
		const kept = addAuto(state, P, "Tests run with bun test.", 10, at(DAY, 1, 2)).key;
		const write = replaceAuto(state, P, "Deploys use GitHub Actions since October.", [old], 10, at(DAY + 1, 3, 8));
		expect(write).toMatchObject({ status: "added", replaced: [old] });
		expect(find(state, old, P)).toBeUndefined();
		expect(find(state, kept, P)).toBeDefined();
		expect(state.forgotten?.[P]).toEqual([old]);
		expect(find(state, write.key, P)).toMatchObject({ createdAt: DAY + 1, evidence: [{ conversationId: 1, turn: 2 }, { conversationId: 3, turn: 8 }] });
		// A later window extracting the superseded text again does not bring it back.
		expect(addAuto(state, P, "Deploys use Jenkins.", 10, at(DAY + 2)).status).toBe("forgotten");
	});

	test("idempotent: applying the same supersede twice equals applying it once", () => {
		const state = empty();
		const old = addAuto(state, P, "Port 3000.", 10, at(DAY)).key;
		replaceAuto(state, P, "Port 8080.", [old], 10, at(DAY + 1, 2, 4));
		const once = copy(state);
		replaceAuto(state, P, "Port 8080.", [old], 10, at(DAY + 1, 2, 4));
		expect(state).toEqual(once);
	});

	test("a memory a person wrote is protected: nothing changes", () => {
		const state = empty();
		mutate(state, "deploy", P, "Deploys use Jenkins (owner decision).", 0, DAY);
		const auto = addAuto(state, P, "Something automatic.", 10, at(DAY)).key;
		const before = copy(state);
		expect(replaceAuto(state, P, "Deploys use GitHub Actions.", ["deploy", auto], 10, at(DAY + 1))).toEqual({ key: autoKey(P, "Deploys use GitHub Actions."), status: "protected", replaced: [] });
		expect(state).toEqual(before);
		// An auto entry a person rewrote lost its origin, so it is protected as well.
		mutate(state, auto, P, "Rewritten by a person.", undefined, DAY + 2);
		const rewritten = copy(state);
		expect(replaceAuto(state, P, "Other.", [auto], 10, at(DAY + 3)).status).toBe("protected");
		expect(state).toEqual(rewritten);
	});

	test("unknown keys are ignored; a forgotten new text changes nothing; another project's key is not reachable", () => {
		const state = empty();
		const other = addAuto(state, "/repo/b", "Other project fact.", 10, at(DAY)).key;
		expect(replaceAuto(state, P, "Fresh fact.", ["auto/doesnotexist", other], 10, at(DAY))).toMatchObject({ status: "added", replaced: [] });
		expect(find(state, other, "/repo/b")).toBeDefined();
		const old = addAuto(state, P, "Old.", 10, at(DAY)).key;
		const gone = addAuto(state, P, "Deleted by a person.", 10, at(DAY)).key;
		mutate(state, gone, P, undefined);
		const before = copy(state);
		expect(replaceAuto(state, P, "Deleted by a person.", [old], 10, at(DAY)).status).toBe("forgotten");
		expect(state).toEqual(before);
	});

	test("merge at the cap: N similar memories become one; without replaces the cap still refuses", () => {
		const state = empty();
		const keys = ["Lint runs with biome.", "Biome checks formatting.", "Run biome before commit."].map((text) => addAuto(state, P, text, 3, at(DAY)).key);
		expect(addAuto(state, P, "A fourth fact.", 3, at(DAY)).status).toBe("full");
		const merged = replaceAuto(state, P, "Biome lints and formats; run it before committing.", keys.slice(0, 2), 3, at(DAY + 1));
		expect(merged).toMatchObject({ status: "added", replaced: keys.slice(0, 2) });
		expect(state.entries.filter((entry) => entry.origin === "auto")).toHaveLength(2);
		expect(addAuto(state, P, "A fourth fact.", 3, at(DAY)).status).toBe("added");
		// At the cap, replacing one with one still fits; replacing nothing does not.
		expect(replaceAuto(state, P, "Run biome before every commit.", [keys[2]!], 3, at(DAY)).status).toBe("added");
		expect(replaceAuto(state, P, "Yet another fact.", [], 3, at(DAY)).status).toBe("full");
	});

	test("superseding into a text that already exists keeps it and removes the old ones", () => {
		const state = empty();
		const target = addAuto(state, P, "Node 22.", 10, at(DAY, 1, 1)).key;
		const old = addAuto(state, P, "Node 18.", 10, at(DAY, 1, 2)).key;
		expect(replaceAuto(state, P, "Node 22.", [old, target], 10, at(DAY, 2, 3))).toMatchObject({ key: target, status: "exists", replaced: [old] });
		expect(state.entries.map((entry) => entry.key)).toEqual([target]);
		expect(find(state, target, P)!.evidence).toEqual([{ conversationId: 1, turn: 2 }, { conversationId: 1, turn: 1 }, { conversationId: 2, turn: 3 }]);
	});
});

describe("curator prompt and reply", () => {
	test("known memories show key, date and owner; near the cap every memory is shown and merging is asked for", () => {
		const state = empty();
		mutate(state, "deploy", P, "Deploys need approval.", 0, DAY);
		for (let index = 0; index < 70; index++) addAuto(state, P, `Fact number ${index}.`, 500, at(DAY));
		const normal = knownMemories(state.entries, P, 200);
		expect(normal.lines).toHaveLength(60);
		expect(normal.lines[0]).toMatch(/^- \[auto\/[0-9a-f]{16}\] \(2026-10-01\) Fact number 69\.$/);
		const rendered = renderKnown(normal);
		expect(rendered).toStartWith("Capacity: 70 of at most 200 automatic memories.\nKnown memories:\n");
		const near = knownMemories(state.entries, P, 75);
		expect(near.lines).toHaveLength(71);
		expect(near.lines.at(-1)).toBe("- [deploy] (2026-10-01) (written by a person) Deploys need approval.");
		expect(renderKnown(near)).toContain("(near the limit: merge overlapping ones)");
		expect(renderKnown(knownMemories(state.entries, P, 70))).toContain("(at the limit: new memories are only stored when they replace or merge known ones)");
		expect(renderKnown({ lines: [], auto: 0, max: 200 })).not.toContain("Known memories");
	});

	test("reply items: trimmed and bounded, superseding items first", () => {
		const items = curatedItems({ memories: [
			{ text: " plain " }, { text: "replacing", replaces: [" auto/a ", "auto/a", ""] }, { text: "" }, { text: "x".repeat(401) },
		] });
		expect(items).toEqual([{ text: "replacing", replaces: ["auto/a"] }, { text: "plain", replaces: [] }]);
	});
});

describe("agreement merge", () => {
	const limits = { maxActivePerProject: 3, maxActiveTeam: 2, escalateAfterViolations: 2 };
	const empty = (): AgreementsState => ({ revision: 0, items: [], forgotten: [] });
	const add = (state: AgreementsState, text: string, now: number, extra: Partial<Parameters<typeof addAgreement>[1]> = {}) =>
		addAgreement(state, { kind: "lesson", scope: "project", project: P, text, origin: "retro", now, evidence: { conversationId: now, turn: 1 }, ...extra }, limits).id;

	test("retro items of one scope fold into one; a full scope can learn again", () => {
		const state = empty();
		const a = add(state, "Run bun test before pushing.", 1);
		const b = add(state, "Run the full test suite before a PR.", 2);
		violateAgreement(state, b, P, undefined, 3, limits, { conversationId: 3, turn: 4 });
		add(state, "Answer in Korean.", 4);
		expect(addAgreement(state, { kind: "lesson", scope: "project", project: P, text: "New lesson.", origin: "retro", now: 5 }, limits).status).toBe("full");
		const merged = mergeAgreements(state, [a, b], P, { text: "Run the full bun test suite before pushing or opening a PR." }, 6, limits, { conversationId: 6, turn: 9 });
		expect(merged).toEqual({ id: agreementId("project", P, "Run the full bun test suite before pushing or opening a PR."), status: "merged", merged: [a, b] });
		const item = state.items.find((entry) => entry.id === merged.id)!;
		expect(item).toMatchObject({ kind: "lesson", origin: "retro", violations: 1, status: "active", createdAt: 1, updatedAt: 6 });
		expect(item.evidence).toEqual([{ conversationId: 1, turn: 1 }, { conversationId: 2, turn: 1 }, { conversationId: 3, turn: 4 }, { conversationId: 6, turn: 9 }]);
		expect(state.items.map((entry) => entry.id)).not.toContain(a);
		expect(state.forgotten).toEqual([]);
		expect(addAgreement(state, { kind: "lesson", scope: "project", project: P, text: "New lesson.", origin: "retro", now: 7 }, limits).status).toBe("added");
		expect(agreementCapacity(state, P, limits)).toEqual({ project: { used: 3, max: 3 }, team: { used: 0, max: 2 } });
	});

	test("all or nothing: a person's item, a missing id, mixed scopes, a single id or a deleted wording change nothing", () => {
		const state = empty();
		const a = add(state, "One.", 1);
		const b = add(state, "Two.", 2);
		const team = add(state, "Team one.", 3, { scope: "team" });
		const human = add(state, "Human.", 4);
		editAgreement(state, human, P, "Written by a person.", undefined, 5);
		// A person deleted this wording earlier (forgetAgreement records its id).
		forgetAgreement(state, add(state, "Deleted team wording.", 6, { scope: "team" }), P);
		state.forgotten.push(agreementId("project", P, "Deleted wording."));
		const before = copy(state);
		expect(mergeAgreements(state, [a, human], P, { text: "x" }, 9, limits).status).toBe("protected");
		expect(mergeAgreements(state, [a, "nope"], P, { text: "x" }, 9, limits).status).toBe("missing");
		expect(mergeAgreements(state, [a, team], P, { text: "x" }, 9, limits).status).toBe("invalid");
		expect(mergeAgreements(state, [a, a], P, { text: "x" }, 9, limits).status).toBe("invalid");
		expect(mergeAgreements(state, [a, b], P, { text: " " }, 9, limits).status).toBe("invalid");
		expect(mergeAgreements(state, [a, b], P, { text: "Deleted wording." }, 9, limits).status).toBe("forgotten");
		expect(state).toEqual(before);
	});

	test("the larger violation count and its review flag survive a merge; a merge into an existing wording keeps that item", () => {
		const state = empty();
		const a = add(state, "One.", 1);
		const b = add(state, "Two.", 2);
		const c = add(state, "Three.", 3);
		violateAgreement(state, a, P, undefined, 4, limits);
		violateAgreement(state, a, P, undefined, 5, limits);
		const merged = mergeAgreements(state, [a, b], P, { text: "One and two." }, 6, limits);
		expect(state.items.find((item) => item.id === merged.id)).toMatchObject({ violations: 2, status: "needs-human" });
		expect(mergeAgreements(state, [merged.id, c], P, { text: "Three." }, 7, limits)).toMatchObject({ id: c, status: "merged" });
		expect(state.items.map((item) => item.id)).toEqual([c]);
	});

	test("retro reply: merge parses, needs two ids; room-making ops run first; the prompt shows capacity", () => {
		expect(parseRetroOutput(JSON.stringify({ agreements: [{ op: "merge", ids: ["a", "b"], text: "ab" }] }))).toEqual([{ op: "merge", ids: ["a", "b"], text: "ab" }]);
		expect(parseRetroOutput(JSON.stringify({ agreements: [{ op: "merge", ids: ["a"], text: "ab" }] }))).toBeUndefined();
		const ops: RetroOp[] = [
			{ op: "add", kind: "lesson", text: "1" }, { op: "violated", id: "v" }, { op: "merge", ids: ["a", "b"], text: "m" },
			{ op: "add", kind: "lesson", text: "2" }, { op: "retire", id: "r" },
		];
		expect(orderRetroOps(ops).map((op) => op.op === "add" ? `add${op.text}` : op.op)).toEqual(["retire", "merge", "violated", "add1", "add2"]);
		const prompt = renderRetroPrompt([], [], "excerpt", { project: { used: 3, max: 3 }, team: { used: 0, max: 10 } });
		expect(prompt).toContain("Capacity: project 3 of 3 (full), team 0 of 10.");
		expect(renderRetroPrompt([], [], "excerpt", { project: { used: 18, max: 20 }, team: { used: 1, max: 10 } })).toContain("project 18 of 20 (nearly full)");
	});
});
