import { expect, test } from "bun:test";
import {
	addAgreement, type AgreementsState, agreementId, editAgreement, forgetAgreement, MAX_AGREEMENT_CHARS, renderAgreements,
	retireAgreement, violateAgreement, visibleAgreements,
} from "../src/core/memory/agreements.ts";
import { DISABLED_MEMORY, memoryConfig } from "../src/core/memory/config.ts";
import type { Evidence, Work } from "../src/core/verification.ts";
import { harnessRecord, parseRetroOutput, renderRetroPrompt, retroTrigger } from "../src/core/memory/retro.ts";

const limits = { maxActivePerProject: 2, maxActiveTeam: 1, escalateAfterViolations: 2 };
const empty = (): AgreementsState => ({ revision: 0, items: [], forgotten: [] });
let clock = 0;
const add = (state: AgreementsState, text: string, extra: Partial<Parameters<typeof addAgreement>[1]> = {}) =>
	addAgreement(state, { kind: "preference", scope: "project", project: "/repo/a", text, origin: "retro", now: ++clock, ...extra }, limits);

test("ledger: content-addressed adds are idempotent, scoped and capped per scope", () => {
	const state = empty();
	const first = add(state, "Show the diff  before committing.", { evidence: { conversationId: 1, turn: 2 } });
	expect(first.status).toBe("added");
	expect(first.id).toBe(agreementId("project", "/repo/a", "show the diff before committing."));
	// Same normalized wording: one item that gains evidence, no new revision.
	expect(add(state, "show the diff before committing.", { evidence: { conversationId: 2, turn: 5 } })).toEqual({ id: first.id, status: "exists" });
	expect(state.revision).toBe(1);
	expect(state.items[0]!.evidence).toEqual([{ conversationId: 1, turn: 2 }, { conversationId: 2, turn: 5 }]);
	// The same wording in another project is a different item.
	expect(add(state, "Show the diff before committing.", { project: "/repo/b" }).status).toBe("added");
	expect(add(state, "Run bun test first.").status).toBe("added");
	expect(add(state, "A third project item.").status).toBe("full");
	expect(add(state, "Answer in Korean.", { scope: "team" }).status).toBe("added");
	expect(add(state, "Second team item.", { scope: "team" }).status).toBe("full");
	expect(add(state, "x".repeat(MAX_AGREEMENT_CHARS + 1)).status).toBe("invalid");
	expect(add(state, "   ").status).toBe("invalid");
	expect(add(state, "No project.", { project: undefined }).status).toBe("invalid");
	// Visibility: team items and this project's items only, team first, preferences before lessons.
	expect(visibleAgreements(state, "/repo/a").map((item) => item.text)).toEqual(["Answer in Korean.", "Show the diff before committing.", "Run bun test first."]);
	expect(visibleAgreements(state, "/repo/b").map((item) => item.text)).toEqual(["Answer in Korean.", "Show the diff before committing."]);
	expect(visibleAgreements(state, undefined).map((item) => item.text)).toEqual(["Answer in Korean."]);
});

test("ledger: violations reinforce retro items, escalate at the limit, and never reword human items", () => {
	const state = empty();
	const { id } = add(state, "Run tests before answering.");
	expect(violateAgreement(state, id, "/repo/a", "Always run bun test before you answer.", 5, limits).status).toBe("updated");
	expect(state.items[0]).toMatchObject({ text: "Always run bun test before you answer.", violations: 1, status: "active", revision: 2, updatedAt: 5 });
	violateAgreement(state, id, "/repo/a", undefined, 6, limits);
	expect(state.items[0]).toMatchObject({ violations: 2, status: "needs-human" });
	expect(renderAgreements(state, "/repo/a")).toContain(`- [${id}] Always run bun test before you answer. (project, missed 2x, needs review)`);
	// A person's rewrite takes ownership: active again, count reset, later violations only count.
	expect(editAgreement(state, id, "/repo/a", "Run bun test, then answer.", "lesson", 7).status).toBe("updated");
	expect(state.items[0]).toMatchObject({ origin: "human", status: "active", violations: 0, kind: "lesson", text: "Run bun test, then answer." });
	violateAgreement(state, id, "/repo/a", "Retro wording.", 8, limits);
	expect(state.items[0]).toMatchObject({ text: "Run bun test, then answer.", violations: 1 });
	expect(retireAgreement(state, id, "/repo/a").status).toBe("protected");
	// Another project cannot touch it.
	expect(violateAgreement(state, id, "/repo/b", undefined, 9, limits).status).toBe("missing");
	expect(forgetAgreement(state, id, "/repo/b").status).toBe("missing");
});

test("ledger: retire removes a retro item; a person's delete keeps a retro from re-adding the wording", () => {
	const state = empty();
	const retired = add(state, "Use npm.");
	expect(retireAgreement(state, retired.id, "/repo/a").status).toBe("updated");
	expect(add(state, "Use npm.").status).toBe("added");
	expect(forgetAgreement(state, retired.id, "/repo/a").status).toBe("updated");
	expect(state.forgotten).toEqual([retired.id]);
	expect(add(state, "use   npm.").status).toBe("forgotten");
	expect(state.items).toHaveLength(0);
	// A person may add it back, which clears the mark.
	expect(add(state, "Use npm.", { origin: "human" }).status).toBe("added");
	expect(state.forgotten).toEqual([]);
});

test("section: absent without agreements, grouped by kind otherwise", () => {
	const state = empty();
	expect(renderAgreements(state, "/repo/a")).toBeUndefined();
	add(state, "Report results in Korean.", { scope: "team" });
	add(state, "Check the lockfile before bun install.", { kind: "lesson" });
	const text = renderAgreements(state, "/repo/a")!;
	expect(text.split("\n").slice(1)).toEqual([
		"Preferences:", `- [${state.items[0]!.id}] Report results in Korean. (team)`,
		"Lessons:", `- [${state.items[1]!.id}] Check the lockfile before bun install. (project)`,
	]);
});

test("triggers: outcome first, then K turns; idle needs Harness activity or two turns; nothing without a new turn", () => {
	const base = { turn: 3, cursor: 2, everyTurns: 6, outcomes: 0, idle: false, harnessChanged: false };
	expect(retroTrigger(base)).toBeUndefined();
	expect(retroTrigger({ ...base, outcomes: 1 })).toBe("outcome");
	expect(retroTrigger({ ...base, turn: 8 })).toBe("turns");
	expect(retroTrigger({ ...base, turn: 7 })).toBeUndefined();
	expect(retroTrigger({ ...base, idle: true })).toBeUndefined();
	expect(retroTrigger({ ...base, idle: true, harnessChanged: true })).toBe("idle");
	expect(retroTrigger({ ...base, turn: 4, idle: true })).toBe("idle");
	expect(retroTrigger({ ...base, turn: 2, outcomes: 3, idle: true, harnessChanged: true })).toBeUndefined();
});

test("Harness record: new works and failed checks become lines; seen keys are skipped", () => {
	const work = {
		id: "w1", version: 1, state: "blocked", blockers: ["tests could not run"], costs: { attempts: 2, repairs: 1, seconds: 0, coaching: 0, slots: [] },
		contract: { requirements: [{ id: "r", assertion: "adds numbers", checkIds: ["a"], scenarioIds: [] }], scenarios: [], checks: [] },
		methods: { a: [{ revision: 1, rationale: "Initial declared method" }, { revision: 2, rationale: "Wrong test path; use ./add.test.ts" }] },
	} as unknown as Work;
	const failed = { id: "e1", checkId: "a", workId: "w1", status: "failed", observation: { output: `${"x".repeat(700)}END` } } as unknown as Evidence;
	const passed = { ...failed, id: "e2", status: "passed" } as Evidence;
	const record = harnessRecord([work], [failed, passed], []);
	expect(record.fresh).toBe(true);
	expect(record.keys).toEqual(["work:w1:1:blocked:1:1", "evidence:e1"]);
	expect(JSON.parse(record.lines[0]!)).toEqual({ work: "w1", state: "blocked", requirements: ["adds numbers"], attempts: 2, repairs: [{ check: "a", rationale: "Wrong test path; use ./add.test.ts" }], blockers: ["tests could not run"] });
	expect(JSON.parse(record.lines[1]!).output).toMatch(/^….*END$/);
	expect(JSON.parse(record.lines[1]!).output.length).toBe(601);
	expect(harnessRecord([work], [failed], record.keys)).toEqual({ lines: [], keys: record.keys, fresh: false });
	expect(renderRetroPrompt([], [], "user: hi")).toBe("Current agreements:\n(none)\n\nHarness record:\n(no work activity)\n\nConversation excerpt:\nuser: hi");
});

test("retro output: fenced JSON is accepted, invalid shapes are rejected, ops are capped", () => {
	expect(parseRetroOutput("```json\n{\"agreements\":[{\"op\":\"add\",\"kind\":\"lesson\",\"text\":\"t\"}]}\n```")).toEqual([{ op: "add", kind: "lesson", text: "t" }]);
	expect(parseRetroOutput("{\"agreements\":[{\"op\":\"add\",\"kind\":\"fact\",\"text\":\"t\"}]}")).toBeUndefined();
	expect(parseRetroOutput("no json")).toBeUndefined();
	const many = { agreements: Array.from({ length: 12 }, (_, i) => ({ op: "retire", id: `i${i}` })) };
	expect(parseRetroOutput(JSON.stringify(many))).toHaveLength(8);
});

test("config: retrospectives are on by default and validated", () => {
	const { config, problems } = memoryConfig({});
	expect(problems).toEqual([]);
	expect(config.retro).toEqual({ ...DISABLED_MEMORY.retro, enabled: true });
	expect(config.retro.idleMs).toBe(15 * 60_000);
	const custom = memoryConfig({ retro: { enabled: false, idleMinutes: 2, model: "openai/gpt-x", everyTurns: 3 } });
	expect(custom.config.retro).toMatchObject({ enabled: false, idleMs: 120_000, model: { provider: "openai", modelId: "gpt-x" }, everyTurns: 3 });
	expect(memoryConfig({ retro: { model: "bad" } }).problems).toEqual(["memory.retro.model: expected inherit or provider/modelId, got \"bad\""]);
	expect(memoryConfig({ retro: { leaseMs: 10_000, timeoutMs: 10_000 } }).problems).toEqual(["memory.retro.leaseMs must exceed twice memory.retro.timeoutMs"]);
});
