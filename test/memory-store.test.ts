import { describe, expect, test } from "bun:test";
import {
	addAuto, AUTO_HEADROOM, autoKey, find, MAX_ENTRIES, MemoryConflictError, type MemoryState, mutate, normalizeMemoryText, visible,
} from "../src/core/memory/store.ts";

const P = "/repo/a";
const Q = "/repo/b";
const empty = (): MemoryState => ({ entries: [], revision: 0 });
const copy = (state: MemoryState): MemoryState => JSON.parse(JSON.stringify(state));

describe("scoped entries", () => {
	test("one key exists once per scope and each scope is addressed separately", () => {
		const state = empty();
		mutate(state, "runtime", undefined, "team: Bun", 0);
		mutate(state, "runtime", P, "project a: Bun 1.4", 0);
		mutate(state, "runtime", Q, "project b: Node", 0);
		expect(find(state, "runtime", undefined)?.content).toBe("team: Bun");
		expect(find(state, "runtime", P)?.content).toBe("project a: Bun 1.4");
		expect(find(state, "runtime", Q)?.content).toBe("project b: Node");
		expect(state.entries.map((entry) => entry.revision)).toEqual([1, 2, 3]);
	});

	test("visibility is team ∪ own project; another project's entries are never visible", () => {
		const state = empty();
		mutate(state, "t", undefined, "team");
		mutate(state, "a", P, "a");
		mutate(state, "b", Q, "b");
		const keys = (project: string | undefined, scope: "all" | "team" | "project") => visible(state, project, scope).map((entry) => entry.key).sort();
		expect(keys(P, "all")).toEqual(["a", "t"]);
		expect(keys(P, "team")).toEqual(["t"]);
		expect(keys(P, "project")).toEqual(["a"]);
		expect(keys(Q, "all")).toEqual(["b", "t"]);
		expect(keys(undefined, "all")).toEqual(["t"]);
		expect(keys(undefined, "project")).toEqual([]);
	});

	test("compare-and-set is per scope and a conflict leaves the state unchanged", () => {
		const state = empty();
		mutate(state, "k", P, "one", 0);
		const before = copy(state);
		expect(() => mutate(state, "k", P, "two", 0)).toThrow(MemoryConflictError);
		expect(state).toEqual(before);
		// The team key of the same name is absent, so expected 0 succeeds there.
		expect(mutate(state, "k", undefined, "team", 0).revision).toBe(2);
	});

	test("delete removes only the addressed scope", () => {
		const state = empty();
		mutate(state, "k", undefined, "team");
		mutate(state, "k", P, "project");
		expect(mutate(state, "k", P, undefined).deleted).toBe(true);
		expect(find(state, "k", P)).toBeUndefined();
		expect(find(state, "k", undefined)?.content).toBe("team");
		expect(mutate(state, "k", P, undefined).deleted).toBe(false);
	});
});

describe("automatic entries", () => {
	test("normalization and content keys: equal texts of one project share a key, projects do not", () => {
		expect(normalizeMemoryText("  Uses   BUN\n")).toBe("uses bun");
		expect(normalizeMemoryText("cafe\u0301")).toBe(normalizeMemoryText("café"));
		expect(autoKey(P, "Uses bun")).toBe(autoKey(P, "  uses   BUN "));
		expect(autoKey(P, "Uses bun")).not.toBe(autoKey(Q, "Uses bun"));
		expect(autoKey(P, "x")).toMatch(/^auto\/[0-9a-f]{16}$/);
	});

	test("addAuto is idempotent: apply(apply(S, t), t) = apply(S, t)", () => {
		const texts = ["Uses bun", "uses BUN", "Deploy via CI", "deploy  via ci", "Tests live in test/"];
		for (let order = 0; order < 20; order++) {
			const once = empty();
			const twice = empty();
			const shuffled = [...texts].sort(() => Math.sin(order * 7 + texts.length) - 0.5);
			for (const text of shuffled) addAuto(once, P, text, 50);
			for (const text of shuffled) { addAuto(twice, P, text, 50); addAuto(twice, P, text, 50); }
			expect(twice).toEqual(once);
			expect(once.entries.length).toBe(3);
			expect(once.entries.every((entry) => entry.origin === "auto" && entry.project === P)).toBe(true);
		}
	});

	test("a deleted automatic entry stays forgotten until an explicit write of its key", () => {
		const state = empty();
		const { key } = addAuto(state, P, "Uses bun", 50);
		mutate(state, key, P, undefined);
		expect(addAuto(state, P, "uses BUN", 50)).toEqual({ key, status: "forgotten" });
		expect(find(state, key, P)).toBeUndefined();
		mutate(state, key, P, "Uses bun 1.4 (corrected)");
		expect(find(state, key, P)?.origin).toBeUndefined();
		expect(state.forgotten?.[P]).toEqual([]);
		expect(addAuto(state, P, "Uses bun", 50).status).toBe("exists");
		// Deleting a team or a non-auto key records nothing.
		mutate(state, "manual", P, "x");
		mutate(state, "manual", P, undefined);
		expect(state.forgotten?.[P]).toEqual([]);
	});

	test("an explicitly rewritten automatic entry is kept and never overwritten by extraction", () => {
		const state = empty();
		const { key } = addAuto(state, P, "Uses bun", 50);
		mutate(state, key, P, "Uses bun 1.4");
		expect(addAuto(state, P, "Uses bun", 50).status).toBe("exists");
		expect(find(state, key, P)?.content).toBe("Uses bun 1.4");
	});

	test("caps: per project, and headroom below the store limit for explicit writes", () => {
		const state = empty();
		for (let i = 0; i < 5; i++) expect(addAuto(state, P, `fact ${i}`, 3).status).toBe(i < 3 ? "added" : "full");
		expect(addAuto(state, Q, "fact 0", 3).status).toBe("added");
		const full = empty();
		for (let i = 0; i < MAX_ENTRIES - AUTO_HEADROOM; i++) full.entries.push({ key: `k${i}`, content: "x", revision: i + 1 });
		full.revision = full.entries.length;
		expect(addAuto(full, P, "one more", 1000).status).toBe("full");
		// Explicit writes still have the headroom.
		expect(mutate(full, "explicit", undefined, "fits").revision).toBe(full.revision);
	});
});
