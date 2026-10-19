import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ConversationId, TaskId } from "@earendil-works/pi-durable";
import { type Bot, openBot } from "../../src/core/bot.ts";
import { ResearchDoc } from "../../src/core/research.ts";
import { RunDoc } from "../../src/core/dag.ts";
import { AgentsDoc, MissionSpawnDoc } from "../../src/extensions/subagents.ts";

const [mode, cut, root] = process.argv.slice(2);
if (!root || !["start", "reopen"].includes(mode ?? "") || !["reserve", "spawn-bind", "receipt", "report"].includes(cut ?? "")) {
	throw new Error("Expected start|reopen reserve|spawn-bind|receipt|report root");
}
const logPath = join(root, "invocations.jsonl");
const startArgs = {
	contract: {
		question: "Does the actual local source support K?",
		hypotheses: ["K supported"],
		requirements: [{ id: "K", mandatory: true }],
		scope: "source.txt",
		exclusions: [],
		mode: "evidence",
		baseline: { definition: "Evaluate the actual controlled local source" },
		policy: { kind: "qualitative", maxNoProgressRounds: 1, maxDebugChildren: 1, confirmation: "required-once" },
		reportAuthorityRef: "user:controlled-boundary-fixture",
	},
	budget: { maxAttempts: 4, maxRounds: 1, maxCandidates: 2, maxConcurrent: 1, deadlineMs: 180_000, attemptTimeoutMs: 120_000 },
};
let bot: Bot | undefined;
let parentId: ConversationId | undefined;
const ready = Promise.withResolvers<void>();
const router: FauxResponseFactory = async (transcript) => {
	await ready.promise;
	const index = transcript.messages.findLastIndex((message) => message.role === "user");
	const user = transcript.messages[index];
	const input = user?.role === "user" && typeof user.content === "string" ? user.content : "";
	const results = transcript.messages.slice(index + 1).filter((message) => message.role === "toolResult");
	if (input.startsWith('{"researchRole"')) {
		const payload = JSON.parse(input) as { researchRole: string; attemptRole: string; candidate: { id: string; operation: string } };
		const doc = bot && parentId ? await bot.harness.snapshot(ResearchDoc, parentId, context) : undefined;
		const mission = doc?.missions[0];
		const attempt = mission?.attempts.findLast((a) => a.candidateId === payload.candidate.id && a.role === payload.attemptRole);
		// These are actual provider invocations, not admissions. Replayed model calls may
		// share one attempt/runner and must not be counted as additional charged work.
		await appendFile(
			logPath,
			JSON.stringify({
				kind: "model",
				mode,
				pid: process.pid,
				missionId: mission?.id,
				attemptId: attempt?.id,
				runnerId: attempt?.binding?.runnerId,
				role: payload.attemptRole,
				operation: payload.candidate.operation,
				phase: results.length ? "interpret" : "request-read",
			}) + "\n",
		);
		if (payload.researchRole !== "reviewer") throw new Error("Passing baseline must not create an author attempt");
		if (!results.length) return fauxAssistantMessage(fauxToolCall("read", { path: "source.txt" }), { stopReason: "toolUse" });
		const read = results.find((result) => result.toolName === "read" && !result.isError);
		const observed = JSON.stringify(read?.content ?? []);
		await appendFile(
			logPath,
			JSON.stringify({ kind: "source-result", mode, attemptId: attempt?.id, runnerId: attempt?.binding?.runnerId, observed }) + "\n",
		);
		if (!read || !observed.includes("K is supported")) throw new Error("Reviewer did not actually read the controlled source");
		return fauxAssistantMessage(JSON.stringify({
			validity: "valid",
			guardrails: true,
			comparison: "same",
			feedback: "Actual source supports K; one source family only",
			requirements: [{ id: "K", verdict: "pass", evidenceIds: ["e1"] }],
			evidence: [{
				id: "e1",
				claimIds: ["K"],
				sourceLocator: "source.txt",
				location: "line 1",
				version: "fixture-v1",
				sourceFamily: "controlled-local-source",
				observation: "K is supported",
				inference: "Local fixture supports K only",
				assumptions: [],
				counterevidence: [],
				access: "observed",
				limitations: ["One source family; faux interpretation"],
			}],
		}));
	}
	await appendFile(logPath, JSON.stringify({ kind: "parent-model", mode, phase: results.length ? "answer" : "start" }) + "\n");
	if (results.length) return fauxAssistantMessage("Mission admitted; durable controller owns execution.");
	if (mode === "reopen") throw new Error("Recovery attempted a new start instead of resuming the existing lifecycle");
	return fauxAssistantMessage(fauxToolCall("research_start", startArgs), { stopReason: "toolUse" });
};
const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
faux.setResponses(Array.from({ length: 120 }, () => router));
const models = createModels();
models.setProvider(faux.provider);
bot = await openBot({
	storage: await openNodeSqliteStorage(join(root, "bot.sqlite")),
	models,
	defaultModel: { provider: "faux", modelId: "m" },
	workspaceRoot: root,
	toolMode: "direct",
	plugins: [],
	settings: { retry: { enabled: false }, compaction: { enabled: false } },
}, context);
const activeBot = bot;
try {
	const parent = await activeBot.conversation("test", "research-boundaries", context);
	parentId = parent.id;
	ready.resolve();
	const originalCommit = activeBot.harness.commit.bind(activeBot.harness);
	if (mode === "start") {
		// Serialize only this instance's host commits so no later host mutation can
		// overtake a detected cut. The original atomic transaction remains indivisible.
		let queue: Promise<unknown> = Promise.resolve();
		const wrapped: typeof activeBot.harness.commit = (change, ctx) => {
			const work = queue.then(async () => {
				const result = await originalCommit(change, ctx);
				// Observation uses snapshots, never this wrapper or another commit.
				const research = await activeBot.harness.snapshot(ResearchDoc, parent.id, context);
				const mission = research?.missions[0];
				const baseline = mission?.attempts.find((a) =>
					a.role === "evaluate" && mission.candidates.find((c) => c.id === a.candidateId)?.operation === "baseline"
				);
				if (!mission || !baseline) return result;
				const runs = await activeBot.harness.snapshot(RunDoc, parent.id, context);
				const agents = await activeBot.harness.snapshot(AgentsDoc, parent.id, context);
				const spawn = await activeBot.harness.snapshot(MissionSpawnDoc, parent.id, JSON.stringify([mission.id, baseline.id]), context);
				const evaluation = mission.evaluations.find((e) => e.attemptId === baseline.id && e.acceptedAt !== undefined);
				const node = runs?.runs.find((r) => r.id === baseline.binding?.runId)?.nodes[baseline.binding?.nodeId ?? ""];
				const match = cut === "reserve"
					? baseline.state === "reserved" && !baseline.binding && !spawn?.ref
					: cut === "spawn-bind"
					? !!baseline.binding && !!spawn?.ref && String(spawn.ref.runnerId) === baseline.binding.runnerId &&
						node?.handle === spawn.ref.taskId
					: cut === "receipt"
					? !!evaluation && !!node?.receipt && baseline.state === "succeeded"
					: mission.status === "concluded" && mission.report.state === "current" && mission.report.writtenRevision === mission.revision;
				if (match) {
					await writeFile(
						join(root, "cut.json"),
						JSON.stringify({
							cut,
							mission,
							runs,
							agents,
							spawn,
							missionId: mission.id,
							attemptId: baseline.id,
							runnerId: baseline.binding?.runnerId,
							evaluationId: evaluation?.id,
						}),
					);
					await new Promise<never>(() => {});
				}
				return result;
			});
			queue = work.then(() => undefined, () => undefined);
			return work;
		};
		activeBot.harness.commit = wrapped;
		await (await parent.submit({
			type: "input",
			content: "Start evidence research with required confirmation and authorized project reports.",
		}, context)).wait(context);
	}
	// Reopen submits nothing. openBot recovery + Harness.resume own all continuation.
	const mission = (await activeBot.research.status(parent.id, context)).mission;
	if (!mission) throw new Error("Missing original mission on recovery");
	const taskOutcome = await activeBot.harness.waitForTask(Number(mission.controllerTaskId) as TaskId<string>, context);
	const research = await activeBot.harness.snapshot(ResearchDoc, parent.id, context);
	const final = (await activeBot.research.status(parent.id, context)).mission!;
	const agents = await activeBot.harness.snapshot(AgentsDoc, parent.id, context);
	const runs = await activeBot.harness.snapshot(RunDoc, parent.id, context);
	const bindings = await Promise.all(
		final.attempts.map(async (a) => ({
			attemptId: a.id,
			record: await activeBot.harness.snapshot(MissionSpawnDoc, parent.id, JSON.stringify([final.id, a.id]), context),
		})),
	);
	await writeFile(
		join(root, "summary.json"),
		JSON.stringify({
			mission: final,
			missionCount: research?.missions.length,
			agents,
			runs,
			bindings,
			taskOutcome,
			controllerWaitCompleted: true,
		}),
	);
} finally {
	await activeBot.close(context);
}
