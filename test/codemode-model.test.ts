import { expect, test } from "bun:test";
import { CellLifecycle } from "../src/core/codemode/lifecycle.ts";

test("exhaustive protocol exploration: bounded admission, unique IDs, terminal absorption and single settlement", () => {
	const actions = ["a1", "a2", "a3", "s1", "s2", "s3", "finish"] as const;
	let traces = 0;
	// Every trace through six transitions, including malformed/duplicate/reordered IDs and late settlements.
	const explore = (trace: string[]) => {
		const state = new CellLifecycle(2, 2);
		const admissions = new Set<number>();
		const settlements = new Set<number>();
		let terminals = 0,
			stopped = false,
			previousCount = 0;
		for (const action of trace) {
			const id = Number(action.slice(1));
			if (action.startsWith("a")) {
				const accepted = state.admit(id);
				if (accepted) {
					if (stopped || admissions.has(id)) throw new Error(`invalid admission: ${trace}`);
					admissions.add(id);
				}
			} else if (action.startsWith("s")) {
				const accepted = state.settle(id);
				if (accepted) {
					if (stopped || !admissions.has(id) || settlements.has(id)) throw new Error(`invalid settlement: ${trace}`);
					settlements.add(id);
				}
			} else if (state.finish()) {
				terminals++;
				stopped = true;
			}
			if (
				state.admitted < previousCount ||
				state.admitted !== admissions.size ||
				state.active !== admissions.size - settlements.size ||
				state.active > 2 ||
				state.admitted > 2 ||
				terminals > 1 ||
				state.terminal !== stopped
			)
				throw new Error(`invariant failed: ${trace}`);
			previousCount = state.admitted;
		}
		traces++;
		if (trace.length < 6) for (const action of actions) explore([...trace, action]);
	};
	explore([]);
	expect(traces).toBe(137257);
});

test("capacity released by completion permits only the next ordinal", () => {
	const s = new CellLifecycle(3, 1);
	expect(s.admit(1)).toBe(true);
	expect(s.admit(2)).toBe(false);
	expect(s.settle(1)).toBe(true);
	expect(s.admit(2)).toBe(true);
	expect(s.settle(1)).toBe(false);
	expect(s.settle(2)).toBe(true);
	expect(s.admit(3)).toBe(true);
	expect(s.settle(3)).toBe(true);
	expect(s.admit(4)).toBe(false);
});
