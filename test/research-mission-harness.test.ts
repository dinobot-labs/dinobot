import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type TaskId, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { type Bot, openBot } from "../src/core/bot.ts";
import { type CommandSpec, type Contract, ResearchDoc } from "../src/core/research.ts";
import { AgentsDoc } from "../src/extensions/subagents.ts";
import { RunDoc, succeed } from "../src/core/dag.ts";
const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [], roots: string[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const startArgs = {
	contract: {
		question: "Is fixture K supported?",
		hypotheses: ["K supported"],
		requirements: [{ id: "K", mandatory: true }],
		scope: "fixture.txt",
		exclusions: [],
		mode: "evidence",
		baseline: { definition: "No established evidence" },
		policy: { kind: "qualitative", maxNoProgressRounds: 2, maxDebugChildren: 1, confirmation: "required-once" },
		reportAuthorityRef: "none",
	},
	budget: { maxAttempts: 6, maxRounds: 2, maxCandidates: 3, maxConcurrent: 1 },
};
function reviewer(pass: boolean) {
	return {
		validity: "valid",
		guardrails: true,
		comparison: pass ? "better" : "same",
		feedback: pass ? "Observed fixture explicitly supports K" : "Baseline lacks evidence for K",
		requirements: [{ id: "K", verdict: pass ? "pass" : "unknown", evidenceIds: pass ? ["evidence"] : [] }],
		evidence: pass
			? [{
				id: "evidence",
				claimIds: ["K"],
				sourceLocator: "fixture.txt",
				location: "line 1",
				version: "fixture-v1",
				sourceFamily: "fixture",
				observation: "K is supported",
				inference: "The observed fixture supports K only",
				assumptions: [],
				counterevidence: [],
				access: "observed",
				limitations: ["One source family"],
			}]
			: [],
	};
}
async function setup(
	mode: "direct" | "hybrid" | "codemode-only",
	review: (role: string, operation: string) => unknown = (role, operation) => reviewer(role === "confirm" || operation !== "baseline"),
) {
	const root = await mkdtemp(join(tmpdir(), "research-harness-"));
	roots.push(root);
	await writeFile(join(root, "fixture.txt"), "K is supported\n");
	const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const calls: string[] = [];
	const router: FauxResponseFactory = (t) => {
		const user = t.messages.findLast((m) => m.role === "user")?.content;
		const input = typeof user === "string" ? user : "";
		if (input.startsWith('{"researchRole"')) {
			const payload = JSON.parse(input);
			const results = t.messages.slice(t.messages.findLastIndex((m) => m.role === "user") + 1).filter((m) => m.role === "toolResult");
			if (payload.researchRole === "author") {
				calls.push("propose");
				return fauxAssistantMessage(JSON.stringify({ hypothesis: "Fixture supports K", evidence: ["fixture.txt"] }));
			}
			if (!results.length) return fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }), { stopReason: "toolUse" });
			calls.push(payload.attemptRole);
			return fauxAssistantMessage(JSON.stringify(review(payload.attemptRole, payload.candidate.operation)));
		}
		const results = t.messages.slice(t.messages.findLastIndex((m) => m.role === "user") + 1).filter((m) => m.role === "toolResult");
		if (results.length) return fauxAssistantMessage("Research started; status tracks the durable controller.");
		return fauxAssistantMessage(
			mode === "codemode-only"
				? fauxToolCall("codemode", { code: `return await tools.research_start(${JSON.stringify(startArgs)});` })
				: fauxToolCall("research_start", startArgs),
			{ stopReason: "toolUse" },
		);
	};
	faux.setResponses(Array.from({ length: 160 }, () => router));
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({
		storage: new MemoryStorage(),
		models,
		defaultModel: { provider: "faux", modelId: "m" },
		workspaceRoot: root,
		toolMode: mode,
		plugins: [],
		settings: { retry: { enabled: false } },
	}, context);
	bots.push(bot);
	const parent = await bot.conversation("test", mode, context);
	return { bot, parent, root, calls };
}
describe("self-driving research Harness", () => {
	test.each([
		["missing", undefined],
		["null", null],
		["object", {}],
		["number", 7],
		["boolean", true],
		["empty", ""],
		["whitespace", " \n "],
		["oversized", "x".repeat(4097)],
	])("otherwise-valid completed review rejects %s feedback without accepting evidence", async (_name, feedback) => {
		const { bot, parent } = await setup("direct", () => {
			const result: Record<string, unknown> = reviewer(true);
			if (feedback === undefined) delete result.feedback;
			else result.feedback = feedback;
			return result;
		});
		await (await parent.submit({ type: "input", content: "Start" }, context)).wait(context);
		const first = (await bot.harness.snapshot(ResearchDoc, parent.id, context))!.missions[0]!;
		await bot.harness.waitForTask(Number(first.controllerTaskId) as TaskId<string>, context);
		const m = (await bot.harness.snapshot(ResearchDoc, parent.id, context))!.missions[0]!;
		expect(m.ledger.attemptsAdmitted).toBe(1);
		expect(m.evaluations).toEqual([]);
		expect(m.status).toBe("blocked");
		expect(m.judgment).toBe("undetermined");
		expect(m.attempts[0]!.error).toContain("feedback must be a nonempty string");
	}, 30_000);

	test.each(["direct", "hybrid", "codemode-only"] as const)(
		"public %s start/status/cancel routes preserve a stable active mission and settle cancellation",
		async (mode) => {
			const root = await mkdtemp(join(tmpdir(), "research-lifecycle-"));
			roots.push(root);
			const entered = Promise.withResolvers<void>(), aborted = Promise.withResolvers<void>();
			const routed: string[] = [];
			let missionId = "";
			const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
			const router: FauxResponseFactory = (transcript, options) => {
				const user = String(transcript.messages.findLast((m) => m.role === "user")?.content);
				if (user.startsWith('{"researchRole"')) {
					return new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
						const signal = options?.signal;
						if (!signal) throw new Error("Reviewer request must be abort-aware");
						const finish = () => {
							aborted.resolve();
							resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
						};
						signal.addEventListener("abort", finish, { once: true });
						if (signal.aborted) finish();
						entered.resolve();
					});
				}
				const results = transcript.messages.slice(transcript.messages.findLastIndex((m) => m.role === "user") + 1).filter((m) =>
					m.role === "toolResult"
				);
				if (results.length) return fauxAssistantMessage("Lifecycle response received.");
				const name = user === "start" ? "research_start" : user === "status" ? "research_status" : "research_cancel";
				const args = name === "research_start"
					? startArgs
					: name === "research_status"
					? { missionId }
					: { missionId, reason: "public cancellation fixture" };
				routed.push(name);
				return fauxAssistantMessage(
					mode === "codemode-only"
						? fauxToolCall("codemode", { code: `return await tools.${name}(${JSON.stringify(args)});` })
						: fauxToolCall(name, args),
					{ stopReason: "toolUse" },
				);
			};
			faux.setResponses(Array.from({ length: 80 }, () => router));
			const models = createModels();
			models.setProvider(faux.provider);
			const bot = await openBot({
				storage: new MemoryStorage(),
				models,
				defaultModel: { provider: "faux", modelId: "m" },
				workspaceRoot: root,
				toolMode: mode,
				plugins: [],
				settings: { retry: { enabled: false } },
			}, context);
			bots.push(bot);
			const parent = await bot.conversation("test", `lifecycle-${mode}`, context);
			const invoke = async (content: string) => (await parent.submit({ type: "input", content }, context)).wait(context);
			await invoke("start");
			await entered.promise;
			const before = (await bot.harness.snapshot(ResearchDoc, parent.id, context))!;
			missionId = before.missions[0]!.id;
			expect(before.missions).toHaveLength(1);
			expect(before.missions[0]!.status).toBe("running");
			expect(before.missions[0]!.ledger.activeAttemptIds).toHaveLength(1);
			const refsBefore = (await bot.harness.snapshot(AgentsDoc, parent.id, context))!;
			await invoke("status");
			expect(await bot.harness.snapshot(ResearchDoc, parent.id, context)).toEqual(before);
			expect(await bot.harness.snapshot(AgentsDoc, parent.id, context)).toEqual(refsBefore);
			await invoke("cancel");
			await aborted.promise;
			await bot.harness.waitForTask(Number(before.missions[0]!.controllerTaskId) as TaskId<string>, context);
			for (const ref of refsBefore.agents) await bot.harness.waitForTask(ref.runnerId, context);
			const final = (await bot.harness.snapshot(ResearchDoc, parent.id, context))!;
			expect(final.missions).toHaveLength(1);
			expect(final.missions[0]!.status).toBe("cancelled");
			expect(final.missions[0]!.cancellationEpoch).toBe(1);
			expect(final.missions[0]!.ledger.attemptsAdmitted).toBe(1);
			expect(final.missions[0]!.ledger.activeAttemptIds).toEqual([]);
			expect(final.missions[0]!.evaluations).toEqual([]);
			expect(routed).toEqual(["research_start", "research_status", "research_cancel"]);
			const messages = (await parent.entries({}, 1000, undefined, context)).items.flatMap((e) => e.model ?? []);
			const results = messages.filter((m) => m.role === "toolResult");
			expect(results.some((m) => m.isError)).toBe(false);
			for (const name of mode === "codemode-only" ? ["codemode"] : routed) expect(results.some((m) => m.toolName === name)).toBe(true);
			expect(JSON.stringify(results)).toContain(missionId);
		},
		30_000,
	);

	test("scripted contradictory literature review binds real source reads and reports dependent counterevidence", async () => {
		const root = await mkdtemp(join(tmpdir(), "research-literature-"));
		roots.push(root);
		const positive = "Cohort A improved short-term symptoms.";
		const negative = "Follow-up of cohort A found no durable benefit.";
		await writeFile(join(root, "primary.txt"), `${positive}\n`);
		await writeFile(join(root, "followup.txt"), `${negative}\n`);
		const args = {
			...startArgs,
			contract: {
				...startArgs.contract,
				question: "Does cohort A support both short-term and durable benefit?",
				requirements: [{ id: "short", mandatory: true }, { id: "durable", mandatory: true }],
				scope: "primary.txt and dependent followup.txt",
				reportAuthorityRef: "user:literature-fixture",
				negativeConclusion: "all-fail-rejected-any-fail-mixed",
			},
		};
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const router: FauxResponseFactory = (transcript) => {
			const user = String(transcript.messages.findLast((m) => m.role === "user")?.content);
			const results = transcript.messages.slice(transcript.messages.findLastIndex((m) => m.role === "user") + 1).filter((m) =>
				m.role === "toolResult"
			);
			if (!user.startsWith('{"researchRole"')) {
				return results.length
					? fauxAssistantMessage("Started scripted fixture review, not a scientific-quality claim.")
					: fauxAssistantMessage(fauxToolCall("research_start", args), { stopReason: "toolUse" });
			}
			const payload = JSON.parse(user);
			if (payload.researchRole === "author") {
				return fauxAssistantMessage(
					JSON.stringify({
						hypothesis: "Short-term improvement does not establish durable benefit",
						evidence: ["primary.txt", "followup.txt"],
					}),
				);
			}
			if (results.length < 2) {
				return fauxAssistantMessage(fauxToolCall("read", { path: results.length ? "followup.txt" : "primary.txt" }), {
					stopReason: "toolUse",
				});
			}
			const evidence = [
				{ id: "primary", claimIds: ["short"], sourceLocator: "primary.txt", observation: positive, counterevidence: [negative] },
				{ id: "followup", claimIds: ["durable"], sourceLocator: "followup.txt", observation: negative, counterevidence: [positive] },
			].map((e) => ({
				...e,
				location: "line 1",
				version: "local-fixture-v1",
				sourceFamily: "cohort-A-dependent",
				inference: "Scripted fixture interpretation only",
				assumptions: ["Same cohort, not independent replication"],
				access: "observed",
				limitations: ["Dependent source family; no independent replication", "Local synthetic literature fixture"],
			}));
			return fauxAssistantMessage(JSON.stringify({
				validity: "valid",
				guardrails: true,
				comparison: "same",
				feedback: "Conflicting outcomes concern distinct required time horizons; preserve both observations.",
				requirements: [{ id: "short", verdict: "pass", evidenceIds: ["primary"] }, {
					id: "durable",
					verdict: "fail",
					evidenceIds: ["followup"],
				}],
				evidence,
			}));
		};
		faux.setResponses(Array.from({ length: 120 }, () => router));
		const models = createModels();
		models.setProvider(faux.provider);
		const bot = await openBot({
			storage: new MemoryStorage(),
			models,
			defaultModel: { provider: "faux", modelId: "m" },
			workspaceRoot: root,
			toolMode: "direct",
			plugins: [],
			settings: { retry: { enabled: false } },
		}, context);
		bots.push(bot);
		const parent = await bot.conversation("test", "contradictory-literature", context);
		await (await parent.submit({ type: "input", content: "Run scripted literature fixture" }, context)).wait(context);
		const first = (await bot.harness.snapshot(ResearchDoc, parent.id, context))!.missions[0]!;
		await bot.harness.waitForTask(Number(first.controllerTaskId) as TaskId<string>, context);
		const m = (await bot.harness.snapshot(ResearchDoc, parent.id, context))!.missions[0]!;
		expect(m.status).toBe("concluded");
		expect(m.judgment).toBe("mixed");
		expect(m.ledger.attemptsAdmitted).toBe(6);
		expect(m.policy.noProgressRounds).toBe(2);
		expect(m.report.state).toBe("current");
		expect(m.evaluations).toHaveLength(4);
		for (const evaluation of m.evaluations) {
			expect(evaluation.evidence.map((e) => e.observation)).toEqual([positive, negative]);
			expect(evaluation.evidence.every((e) => /^[a-f0-9]{64}$/.test(e.contentHash ?? ""))).toBe(true);
			expect(new Set(evaluation.evidence.map((e) => e.sourceFamily)).size).toBe(1);
			expect(evaluation.evidence[0]!.contentHash).not.toBe(evaluation.evidence[1]!.contentHash);
		}
		const report = await readFile(join(root, m.report.path!, "report.md"), "utf8");
		const evidence = await readFile(join(root, m.report.path!, "evidence.md"), "utf8");
		for (const text of [report, evidence]) {
			for (const expected of [positive, negative, "counterevidence", "cohort-A-dependent", "no independent replication"]) {
				expect(text).toContain(expected);
			}
		}
		expect(report).toContain("mixed");
		expect(report).toContain("maxAttempts");
		expect(report).toContain("attemptsAdmitted");
	}, 30_000);

	test("trusted code baseline/failure/debug/improve/confirm preserves original checkout", async () => {
		const root = await mkdtemp(join(tmpdir(), "research-code-"));
		roots.push(root);
		const git = async (...args: string[]) => {
			const p = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
			const out = await new Response(p.stdout).text();
			if (await p.exited) throw new Error(await new Response(p.stderr).text());
			return out.trim();
		};
		await git("init");
		await git("config", "user.email", "fixture@example.invalid");
		await git("config", "user.name", "Fixture");
		await writeFile(join(root, "candidate.json"), '{"latency":100}');
		await writeFile(
			join(root, "evaluator.cjs"),
			'const fs=require("node:fs"); const n=JSON.parse(fs.readFileSync("candidate.json","utf8")).latency;if(n<0)process.exit(1);console.log(JSON.stringify({samples:[n,n],metric:"latency",unit:"ms",guardrails:true,feedback:"actual fixed command samples"}));',
		);
		await git("add", "candidate.json", "evaluator.cjs");
		await git("commit", "-m", "fixture");
		const baseCommit = await git("rev-parse", "HEAD");
		await writeFile(join(root, "untracked.txt"), "preserve");
		const profile: CommandSpec = {
			executable: process.execPath,
			argv: ["evaluator.cjs"],
			baseCommit,
			permittedPaths: ["candidate.json"],
			timeoutMs: 5000,
			environmentAllowlist: [],
			cwdPolicy: "candidate",
			resultSchema: "research-numeric-v1",
		};
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		faux.setResponses(Array.from({ length: 30 }, () => (t: Parameters<FauxResponseFactory>[0]) => {
			const user = t.messages.findLast((m) => m.role === "user")?.content;
			const data = JSON.parse(String(user));
			const operation = data.candidate.operation;
			return fauxAssistantMessage(
				JSON.stringify({
					hypothesis: `${operation} actual latency`,
					edits: [{
						path: "candidate.json",
						content: JSON.stringify({ latency: operation === "draft" ? -1 : operation === "debug" ? 90 : 75 }),
					}],
				}),
			);
		}));
		const models = createModels();
		models.setProvider(faux.provider);
		const bot = await openBot({
			storage: new MemoryStorage(),
			models,
			defaultModel: { provider: "faux", modelId: "m" },
			workspaceRoot: root,
			researchCodeProfiles: { fixture: profile },
			toolMode: "direct",
			plugins: [],
			settings: { retry: { enabled: false } },
		}, context);
		bots.push(bot);
		const parent = await bot.conversation("test", "code", context);
		const c: Contract = {
			question: "Latency <=80?",
			hypotheses: ["Lower latency"],
			requirements: [{ id: "latency", mandatory: true }],
			scope: "candidate.json",
			exclusions: [],
			mode: "trusted-local-code",
			codeAuthorityRef: "host:fixture",
			command: profile,
			reportAuthorityRef: "user:fixture",
			baseline: { definition: "Explicit committed baseline", artifactHash: "host-replaces" },
			evaluator: { profile: "host", revision: "host", environmentFingerprint: "host", inputFingerprint: "host" },
			policy: {
				kind: "numeric",
				confirmation: "required-once",
				maxNoProgressRounds: 2,
				maxDebugChildren: 1,
				numeric: {
					metric: "latency",
					unit: "ms",
					direction: "min",
					repetitions: 2,
					aggregation: "mean",
					minimumEffect: 5,
					goalThreshold: 80,
				},
			},
		};
		const api = {
			conversationId: parent.id,
			taskId: 10001 as TaskId<string>,
			callId: "1",
			agent: parent.agent.bind(parent),
			env: undefined,
			commit: bot.harness.commit.bind(bot.harness),
		} as unknown as ToolExecutionApi;
		await expect(bot.research.start({ contract: { ...c, command: { ...profile, argv: ["evil.cjs"] } } }, api, context)).rejects.toThrow(
			"host-authorized",
		);
		await expect(bot.research.start({ contract: { ...c, reportAuthorityRef: "none" } }, api, context)).rejects.toThrow("project write");
		const first = await bot.research.start(
			{ contract: c, budget: { maxAttempts: 9, maxRounds: 3, maxCandidates: 4, maxConcurrent: 1 } },
			api,
			context,
		);
		await bot.harness.waitForTask(Number(first.mission!.controllerTaskId) as TaskId<string>, context);
		const m = (await bot.research.status(parent.id, context)).mission!;
		expect(
			[m.status, m.judgment, m.ledger.attemptsAdmitted],
			JSON.stringify({ reason: m.stopReason, errors: m.attempts.map((a) => a.error) }),
		).toEqual(["concluded", "supported", 8]);
		expect(m.candidates.map((c) => c.operation)).toEqual(["baseline", "draft", "debug", "improve"]);
		expect(m.candidates[2]!.parentId).toBe(m.candidates[1]!.id);
		expect(m.candidates[2]!.feedbackReceiptIds).toEqual(["e-a3"]);
		expect(await readFile(join(root, "candidate.json"), "utf8")).toBe('{"latency":100}');
		expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe("preserve");
		expect(await git("diff", "--", "candidate.json", "evaluator.cjs")).toBe("");
		expect(await bot.research.readReport(parent.id, m.id, "candidate.patch", context)).toContain("75");
	}, 30_000);
	test.each(["direct", "hybrid", "codemode-only"] as const)(
		"baseline -> draft -> evaluate -> confirmation through %s catalog",
		async (mode) => {
			const { bot, parent, calls } = await setup(mode);
			await (await parent.submit({ type: "input", content: "Start fixture research" }, context)).wait(context);
			const doc = await bot.harness.snapshot(ResearchDoc, parent.id, context);
			expect(doc?.missions).toHaveLength(1);
			const id = doc!.missions[0]!.id;
			await bot.harness.waitForTask(Number(doc!.missions[0]!.controllerTaskId) as TaskId<string>, context);
			const m = (await bot.research.status(parent.id, context, id)).mission!;
			expect(m.status, JSON.stringify({ reason: m.stopReason, errors: m.attempts.map((a) => a.error) })).toBe("concluded");
			expect(m.judgment).toBe("supported");
			expect(m.ledger.attemptsAdmitted).toBe(4);
			expect(calls).toEqual(["evaluate", "propose", "evaluate", "confirm"]);
			expect(m.candidates[1]!.feedbackReceiptIds).toEqual(["e-a1"]);
			expect(m.evaluations.every((e) => e.binding.runnerId && e.receiptHash)).toBe(true);
			const rounds = (await bot.harness.snapshot(RunDoc, parent.id, context))!.runs.filter((r) => r.owner?.missionId === m.id);
			const round = rounds.find((r) => r.plan.nodes.some((n) => n.id === "proposal"))!;
			expect(round.plan.edges).toEqual([["proposal", "evaluation"]]);
			expect(round.plan.nodes.map((n) => n.kind)).toEqual(["delegate", "verify"]);
			expect(m.attempts[1]!.binding?.runId).toBe(m.attempts[2]!.binding?.runId);
			expect(m.attempts[1]!.binding?.nodeId).toBe("proposal");
			expect(m.attempts[2]!.binding?.nodeId).toBe("evaluation");
			expect(m.candidates[1]!.summary).toBe("Fixture supports K");
			expect(() => succeed(structuredClone(round), "evaluation", "untrusted generic completion", Date.now())).toThrow("host-accepted");
			const refs = (await bot.harness.snapshot(AgentsDoc, parent.id, context))!.agents;
			expect(refs).toHaveLength(4);
			for (const ref of refs) {
				const child = (await bot.harness.conversation(ref.conversationId, context))!;
				const agent = await child.agent(context);
				expect(agent.extensions.map((extension) => extension.name)).toEqual(agent.tools.length ? ["coding-tools"] : []);
				expect(agent.tools.every((t) => ["read", "grep", "find", "ls"].includes(t.name))).toBe(true);
			}
		},
		30_000,
	);
	test("negative completed child executes successfully without claiming a supported goal", async () => {
		const { bot, parent } = await setup("direct", () => reviewer(false));
		await (await parent.submit({ type: "input", content: "Start" }, context)).wait(context);
		const first = (await bot.harness.snapshot(ResearchDoc, parent.id, context))!.missions[0]!;
		await bot.harness.waitForTask(Number(first.controllerTaskId) as TaskId<string>, context);
		const m = (await bot.research.status(parent.id, context)).mission!;
		expect(m.status).toBe("inconclusive");
		expect(m.judgment).toBe("undetermined");
		expect(m.ledger.attemptsAdmitted).toBe(6);
		expect(m.policy.noProgressRounds).toBe(2);
		const runs = (await bot.harness.snapshot(RunDoc, parent.id, context))!.runs.filter((r) => r.owner?.missionId === m.id);
		expect(runs.some((r) => r.status === "verified")).toBe(true);
		expect(m.evaluations.every((e) => e.verdict !== "pass")).toBe(true);
	}, 30_000);
	test("malformed reviewer output fails closed, charged and not certified", async () => {
		const { bot, parent } = await setup("direct", () => ({ score: 999, validity: "valid" }));
		await (await parent.submit({ type: "input", content: "Start" }, context)).wait(context);
		const first = (await bot.harness.snapshot(ResearchDoc, parent.id, context))!.missions[0]!;
		await bot.harness.waitForTask(Number(first.controllerTaskId) as TaskId<string>, context);
		const m = (await bot.research.status(parent.id, context)).mission!;
		expect(m.status).toBe("blocked");
		expect(m.evaluations).toHaveLength(0);
		expect(m.ledger.attemptsAdmitted).toBe(1);
		expect(m.judgment).toBe("undetermined");
	}, 30_000);
	test("forged observed locator without a matching successful read cannot conclude", async () => {
		const { bot, parent } = await setup("direct", () => {
			const e = reviewer(true);
			e.evidence[0]!.sourceLocator = "never-read.txt";
			return e;
		});
		await (await parent.submit({ type: "input", content: "Start" }, context)).wait(context);
		const first = (await bot.harness.snapshot(ResearchDoc, parent.id, context))!.missions[0]!;
		await bot.harness.waitForTask(Number(first.controllerTaskId) as TaskId<string>, context);
		const m = (await bot.research.status(parent.id, context)).mission!;
		expect(m.status).toBe("blocked");
		expect(m.judgment).toBe("undetermined");
		expect(m.evaluations).toHaveLength(0);
		expect(m.attempts[0]!.error).toContain("successful source read");
	}, 30_000);
});
