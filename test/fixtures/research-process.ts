import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { TaskId } from "@earendil-works/pi-durable";
import { openBot } from "../../src/core/bot.ts";
import { ResearchDoc, type CommandSpec, type Contract } from "../../src/core/research.ts";

const [mode, root, database, baseCommit, marker, summary] = process.argv.slice(2);
if (!mode || !root || !database || !baseCommit || !marker || !summary) throw new Error("Missing research process fixture arguments");
const profile: CommandSpec = {
	executable: process.execPath, argv: ["evaluator.ts", marker], baseCommit,
	permittedPaths: ["candidate.txt"], timeoutMs: 120_000, environmentAllowlist: [],
	cwdPolicy: "candidate", resultSchema: "research-numeric-v1",
};
const contract: Contract = {
	question: "Does fixture latency improve?", hypotheses: ["Lower latency"],
	requirements: [{ id: "latency", mandatory: true }], scope: "candidate.txt", exclusions: [],
	mode: "trusted-local-code", codeAuthorityRef: "host:fixture", command: profile,
	reportAuthorityRef: "user:controlled-fixture", baseline: { definition: "Committed fixture baseline", artifactHash: "host-replaces" },
	evaluator: { profile: "host", revision: "host", environmentFingerprint: "host", inputFingerprint: "host" },
	policy: { kind: "numeric", confirmation: "required-once", maxNoProgressRounds: 1, maxDebugChildren: 1,
		numeric: { metric: "latency", unit: "ms", direction: "min", repetitions: 2, aggregation: "mean", minimumEffect: 5, goalThreshold: 80 } },
};
const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
let providerCalls = 0;
faux.setResponses(Array.from({ length: 20 }, () => () => {
	providerCalls++;
	if (mode === "reopen") throw new Error("Recovery must not issue a new model request");
	return providerCalls === 1
		? fauxAssistantMessage(fauxToolCall("research_start", { contract, budget: { maxAttempts: 4, maxRounds: 1, maxCandidates: 2, maxConcurrent: 1 } }), { stopReason: "toolUse" })
		: fauxAssistantMessage("Research started.");
}));
const models = createModels(); models.setProvider(faux.provider);
const bot = await openBot({ storage: await openNodeSqliteStorage(database), models,
	defaultModel: { provider: "faux", modelId: "m" }, workspaceRoot: root,
	researchCodeProfiles: { fixture: profile }, toolMode: "direct", plugins: [],
	settings: { retry: { enabled: false }, compaction: { enabled: false } },
}, context);
try {
	const parent = await bot.conversation("test", "process-recovery", context);
	if (mode !== "reopen") await (await parent.submit({ type: "input", content: "Start explicitly authorized controlled fixture research." }, context)).wait(context);
	if (!(await bot.research.status(parent.id, context)).mission) throw new Error("Research lifecycle invocation did not admit a mission");
	if (mode === "start" || mode === "cancel") {
		const deadline = Date.now() + 20_000;
		for (;;) {
			try { if ((await readFile(marker, "utf8")).trim()) break; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			if (Date.now() >= deadline) throw new Error("Evaluator did not reach external-effect marker");
			await Bun.sleep(40);
		}
		const before = (await bot.research.status(parent.id, context)).mission!;
		await writeFile(join(root, "before.json"), JSON.stringify(before));
		if (mode === "start") {
			// Parent kills this process while the real evaluator is still awaiting completion.
			await new Promise<void>(() => {});
		} else await bot.research.cancelActive(parent.id, "fixture cancellation", context);
	}
	// openBot calls recover and resumes the real durable harness. No start is submitted on reopen.
	const mission = (await bot.research.status(parent.id, context)).mission;
	if (!mission?.controllerTaskId) throw new Error("Missing durable controller task");
	const taskOutcome = await bot.harness.waitForTask(Number(mission.controllerTaskId) as TaskId<string>, context);
	const doc = await bot.harness.snapshot(ResearchDoc, parent.id, context);
	const final = (await bot.research.status(parent.id, context)).mission!;
	await writeFile(summary, JSON.stringify({ mission: final, missionCount: doc?.missions.length, taskOutcome, controllerWaitCompleted: true, providerCalls }));
} finally { await bot.close(context); }
