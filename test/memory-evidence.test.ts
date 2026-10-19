import { expect, test } from "bun:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { LOOP_RUN, MAX_FINDINGS, renderFindings, skillActionTokens, skillApplied, windowEvidence } from "../src/core/memory/evidence.ts";
import { renderRetroEvidencePrompt, RETRO_SYSTEM_PROMPT } from "../src/core/memory/retro.ts";

let nextId = 1;
function entry(...model: unknown[]): EntryRecord {
	return { id: nextId++, kind: "pi.message", model } as unknown as EntryRecord;
}
const user = (text: string) => entry({ role: "user", content: text });
const callAndResult = (id: string, name: string, args: unknown, output: string, isError: boolean) => [
	entry({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] }),
	entry({ role: "toolResult", toolCallId: id, toolName: name, isError, content: [{ type: "text", text: output }] }),
];
const refsOf = (text: string) => [...text.matchAll(/\[(e\d+|h\d+)\]/g)].map((match) => match[1]);
const kinds = (entries: EntryRecord[], harness: string[] = []) => windowEvidence(entries, harness).findings.map((finding) => finding.kind);

test("layers: overview counts, findings cite resolvable raw refs (E1) with evidence quotes, output is deterministic (E3)", () => {
	nextId = 1;
	const entries = [
		user("fix the build"),
		...callAndResult("c1", "read", { path: "missing.ts" }, "ENOENT: missing.ts", true),
		...callAndResult("c2", "read", { path: "missing.ts" }, "ENOENT: missing.ts", true),
		...callAndResult("c3", "read", { path: "a.ts" }, "contents", false),
		entry({ role: "assistant", content: [{ type: "text", text: "done" }] }),
	];
	const harness = [
		JSON.stringify({ work: "w1", state: "blocked", requirements: [], attempts: 2, repairs: [{ check: "t", rationale: "x" }], blockers: ["no runner"] }),
		JSON.stringify({ failedCheck: "tests", work: "w1", output: "1 fail" }),
	];
	const evidence = windowEvidence(entries, harness);
	expect(evidence.overview).toContain("user turns 1; tool calls 3 (read 3); tool errors 2 (read 2); failed checks 0");
	expect(evidence.overview).toContain("Harness lines 2; findings 5");
	expect(evidence.findings.map((finding) => finding.kind)).toEqual(["tool_error", "repeated_failure", "tool_error", "harness", "harness"]);
	const rendered = new Set(refsOf([evidence.excerpt, ...evidence.harness].join("\n")));
	for (const finding of evidence.findings) {
		expect(finding.refs.length).toBeGreaterThan(0);
		expect(finding.raw).toBeUndefined();
		expect(finding.evidence?.length).toBeGreaterThan(0);
		for (const ref of finding.refs) expect(rendered.has(ref)).toBe(true);
	}
	expect(evidence.findings[0]).toMatchObject({ refs: ["e2", "e3"], evidence: "ENOENT: missing.ts" });
	expect(renderFindings(evidence.findings)).toContain("- tool_error: read failed: ENOENT: missing.ts [e2, e3] — \"ENOENT: missing.ts\"");
	expect(windowEvidence(entries, harness)).toEqual(evidence);
});

test("F1: a failing verifier command is check_failed, not a tool error, and reruns are not repeated failures", () => {
	nextId = 1;
	const entries = [
		...callAndResult("t1", "bash", { command: "bun test" }, "3 fail", true),
		...callAndResult("e1", "edit", { path: "a.ts" }, "ok", false),
		...callAndResult("t2", "bash", { command: "bun test" }, "1 fail", true),
		...callAndResult("x1", "bash", { command: "curl -s https://example.invalid" }, "could not resolve host", true),
	];
	const evidence = windowEvidence(entries, []);
	expect(evidence.findings.map((finding) => [finding.kind, finding.summary])).toEqual([
		["check_failed", "test check failed: bun test"],
		["check_failed", "test check failed: bun test"],
		["tool_error", "bash failed: could not resolve host"],
	]);
	expect(evidence.overview).toContain("tool errors 1 (bash 1); failed checks 2");
});

test("loop: LOOP_RUN identical consecutive calls are a loop, failing or not; interleaved calls are not", () => {
	nextId = 1;
	const same = Array.from({ length: LOOP_RUN }, (_, index) => callAndResult(`r${index}`, "read", { path: "a.ts" }, "same", false)).flat();
	const loop = windowEvidence(same, []).findings;
	expect(loop).toHaveLength(1);
	expect(loop[0]).toMatchObject({ kind: "loop", summary: `read ran ${LOOP_RUN} times in a row with the same arguments`, evidence: "{\"path\":\"a.ts\"}" });
	expect(loop[0]!.refs).toHaveLength(LOOP_RUN);
	nextId = 1;
	const short = Array.from({ length: LOOP_RUN - 1 }, (_, index) => callAndResult(`r${index}`, "read", { path: "a.ts" }, "same", false)).flat();
	expect(kinds(short)).toEqual([]);
	nextId = 1;
	const interleaved = [0, 1, 2].flatMap((index) => [
		...callAndResult(`r${index}`, "read", { path: "a.ts" }, "same", false),
		...callAndResult(`w${index}`, "edit", { path: "a.ts", n: index }, "ok", false),
	]);
	expect(kinds(interleaved)).toEqual([]);
});

test("truncated: output-limit and provider-error endings are early truncation; a user abort is not (F2)", () => {
	nextId = 1;
	const entries = [
		entry({ role: "assistant", content: [{ type: "text", text: "partial answer" }], stopReason: "length" }),
		entry({ role: "assistant", content: [], stopReason: "error", errorMessage: "overloaded" }),
		entry({ role: "assistant", content: [{ type: "text", text: "stopped" }], stopReason: "aborted" }),
		entry({ role: "assistant", content: [{ type: "text", text: "fine" }], stopReason: "stop" }),
	];
	const findings = windowEvidence(entries, []).findings;
	expect(findings.map((finding) => [finding.kind, finding.refs, finding.evidence])).toEqual([
		["truncated", ["e1"], "partial answer"],
		["truncated", ["e2"], "overloaded"],
	]);
});

test("skills: a failed load is skill_unavailable; a loaded skill whose commands never appear later is skill_unapplied", () => {
	const body = "# Deploy\n\nRun `script/deploy.sh --env prod` and then check `logs/deploy.txt`.\n\n```bash\n$ bun run release:smoke\n```\n";
	expect(skillActionTokens(body)).toEqual(["bun run release:smoke", "script/deploy.sh --env prod", "logs/deploy.txt"]);
	const load = (id: string) => callAndResult(id, "skills_load", { name: "deploy" }, JSON.stringify({ name: "deploy", body, files: [] }), false);
	nextId = 1;
	const unapplied = [...load("l1"), ...callAndResult("b1", "bash", { command: "./other.sh" }, "ok", false)];
	expect(windowEvidence(unapplied, []).findings).toEqual([{
		kind: "skill_unapplied", summary: "skill deploy was loaded but no later call uses its commands, paths or code", refs: ["e1"],
		evidence: "bun run release:smoke | script/deploy.sh --env prod | logs/deploy.txt",
	}]);
	nextId = 1;
	expect(kinds([...load("l1"), ...callAndResult("b1", "bash", { command: "script/deploy.sh --env prod" }, "ok", false)])).toEqual([]);
	nextId = 1;
	expect(kinds([...load("l1"), ...callAndResult("f1", "skills_read_file", { name: "deploy", version: "v", path: "ref.md" }, "x", false)])).toEqual([]);
	// F3: pure guidance (no actionable tokens) and loads whose body is unknown (codemode) are never flagged.
	expect(skillApplied("programming", "Reuse before writing. Close the change set.", ["{}"])).toBeUndefined();
	nextId = 1;
	const codemode = callAndResult("m1", "codemode", { code: "await tools.skills_load({ name: \"deploy\" })" }, "loaded", false);
	expect(kinds([...codemode, ...callAndResult("b1", "bash", { command: "./other.sh" }, "ok", false)])).toEqual([]);
	nextId = 1;
	const failed = callAndResult("l1", "skills_load", { name: "ghost" }, "Unknown skill", true);
	expect(windowEvidence(failed, []).findings).toEqual([{ kind: "skill_unavailable", summary: "skills_load ghost failed", refs: ["e1", "e2"], evidence: "Unknown skill" }]);
});

test("bounded excerpt keeps whole newest messages (E2) and flags findings whose raw entry fell out (E1)", () => {
	nextId = 1;
	const entries = [
		...callAndResult("old", "edit", { path: "x" }, "old failure", true),
		...Array.from({ length: 60 }, (_, index) => user(`message ${index} ${"x".repeat(1500)}`)),
	];
	const evidence = windowEvidence(entries, []);
	expect(evidence.excerpt.length).toBeLessThanOrEqual(60_000 + 3);
	expect(evidence.excerpt).toStartWith("…");
	expect(evidence.excerpt).toContain("message 59");
	expect(evidence.excerpt).not.toContain("old failure");
	for (const chunk of evidence.excerpt.split("\n\n").slice(1)) expect(chunk).toMatch(/^\[e\d+\] user: message \d+ x{1500}$/);
	expect(evidence.findings).toEqual([{ kind: "tool_error", summary: "edit failed: old failure", refs: ["e1", "e2"], evidence: "old failure", raw: "omitted" }]);
	expect(renderFindings(evidence.findings)).toContain("(raw omitted)");
	expect(evidence.overview).toContain("older messages outside the excerpt");
});

test("findings are capped to the newest MAX_FINDINGS and the cap is reported", () => {
	nextId = 1;
	const entries = Array.from({ length: MAX_FINDINGS + 5 }, (_, index) => callAndResult(`c${index}`, "edit", { path: `f${index}` }, `boom ${index}`, true)).flat();
	const evidence = windowEvidence(entries, []);
	expect(evidence.findings).toHaveLength(MAX_FINDINGS);
	expect(evidence.findings.at(-1)!.summary).toContain(`boom ${MAX_FINDINGS + 4}`);
	expect(evidence.overview).toContain(`findings ${MAX_FINDINGS + 5} (newest ${MAX_FINDINGS} shown)`);
});

test("the retro prompt is layered overview -> findings -> labelled raw, and the system prompt says to verify refs", () => {
	nextId = 1;
	const entries = [user("please use pnpm"), ...callAndResult("c1", "bash", { command: "npm i" }, "npm: not allowed", true)];
	const prompt = renderRetroEvidencePrompt([], [JSON.stringify({ failedCheck: "lint", work: "w9", output: "x" })], entries);
	const order = ["Current agreements:", "Evidence overview:", "Findings (refs point to labelled lines below):", "Harness record:\n[h1]", "Conversation excerpt:\n[e1] user: please use pnpm"]
		.map((heading) => prompt.indexOf(heading));
	for (const index of order) expect(index).toBeGreaterThanOrEqual(0);
	expect([...order].sort((a, b) => a - b)).toEqual(order);
	expect(prompt).toContain("- tool_error: bash failed: npm: not allowed [e2, e3]");
	expect(prompt).toContain("[e3] tool bash (error): npm: not allowed");
	expect(RETRO_SYSTEM_PROMPT).toContain("check each one in the labelled lines it cites");
	expect(RETRO_SYSTEM_PROMPT).toContain("check_failed");
});
