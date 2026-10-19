import { mock } from "bun:test";
import * as actual from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { TaskId } from "@earendil-works/pi-durable";

const [mode, root, fault] = process.argv.slice(2);
if (!mode || !root || !fault) throw new Error("Missing fixture arguments");
const fs = { ...actual };
let failures = 0;
let acceptedAtFault = 0;
let interruptRevision: number | undefined;
mock.module("node:fs/promises", () => ({
	...fs,
	rename: async (from: string, to: string) => {
		if (mode === "checkpoint" && basename(to) === "ownership.json") {
			const owner = JSON.parse(await fs.readFile(from, "utf8"));
			if (interruptRevision !== undefined && owner.pending?.revision === interruptRevision) {
				await fs.rename(from, to);
				throw Object.assign(new Error("ENOSPC after pending checkpoint"), { code: "ENOSPC" });
			}
		}
		if (
			mode === "fail" && to.startsWith(join(root, ".dinobot", "research")) &&
			basename(to) === (fault === "evidence" ? "evidence.md" : "ownership.json")
		) {
			let mission: { evaluations: unknown[] } | undefined;
			try {
				const report = await fs.readFile(join(dirname(to), "report.md"), "utf8");
				const json = report.match(/```json\n([\s\S]*?)\n```/);
				if (json) mission = JSON.parse(json[1]!);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const finalMarker = basename(to) !== "ownership.json" || !JSON.parse(await fs.readFile(from, "utf8")).pending;
			if (mission?.evaluations.length && finalMarker) {
				failures++;
				acceptedAtFault = mission.evaluations.length;
				throw Object.assign(new Error("ENOSPC: simulated report publication failure"), { code: "ENOSPC" });
			}
		}
		return fs.rename(from, to);
	},
}));
if (mode === "checkpoint") {
	const { projectResearchReport } = await import("../../src/core/research-reports.ts");
	const { hashResearchBytes } = await import("../../src/core/research-experiments.ts");
	const input = {
		root,
		missionId: "checkpoint",
		directory: ".dinobot/research/checkpoint",
		revision: 1,
		report: "old",
		evidence: "old evidence",
		maxBytes: 4096,
	};
	await projectResearchReport(input);
	const directory = join(root, input.directory);
	const owner = JSON.parse(await fs.readFile(join(directory, "ownership.json"), "utf8"));
	await fs.writeFile(
		join(directory, "ownership.json"),
		JSON.stringify({
			...owner,
			pending: { revision: 2, hashes: { "report.md": hashResearchBytes("partial second") } },
		}),
	);
	await fs.writeFile(join(directory, "report.md"), "partial second");
	interruptRevision = 3;
	try {
		await projectResearchReport({ ...input, revision: 3, report: "third" });
		throw new Error("Fault did not fire");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOSPC") throw error;
	}
	const checkpoint = JSON.parse(await fs.readFile(join(directory, "ownership.json"), "utf8"));
	interruptRevision = undefined;
	await projectResearchReport({ ...input, revision: 4, report: "fourth" });
	await fs.writeFile(
		join(root, "checkpoint.json"),
		JSON.stringify({
			checkpoint,
			repaired: await fs.readFile(join(directory, "report.md"), "utf8"),
			owner: JSON.parse(await fs.readFile(join(directory, "ownership.json"), "utf8")),
		}),
	);
	process.exit(0);
}
// Dynamic import ensures the isolated mock is installed before the production projection module loads.
const { openBot } = await import("../../src/core/bot.ts");
const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
let providerCalls = 0;
const contract = {
	question: "Is fixture K supported?",
	hypotheses: ["K supported"],
	requirements: [{ id: "K", mandatory: true }],
	scope: "fixture.txt",
	exclusions: [],
	mode: "evidence",
	baseline: { definition: "No established evidence" },
	policy: { kind: "qualitative", maxNoProgressRounds: 2, maxDebugChildren: 1, confirmation: "required-once" },
	reportAuthorityRef: "user:fixture",
};
faux.setResponses(Array.from({ length: 80 }, () => (request: Parameters<FauxResponseFactory>[0]) => {
	providerCalls++;
	if (mode === "repair") throw new Error("Repair must not perform model work");
	const user = request.messages.findLast((message) => message.role === "user")?.content;
	const input = typeof user === "string" ? user : "";
	const results = request.messages.slice(request.messages.findLastIndex((message) => message.role === "user") + 1).filter((message) =>
		message.role === "toolResult"
	);
	if (input.startsWith('{"researchRole"')) {
		const payload = JSON.parse(input);
		if (payload.researchRole === "author") {
			return fauxAssistantMessage(JSON.stringify({ hypothesis: "K supported by fixture", evidence: ["fixture.txt"] }));
		}
		if (!results.length) return fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }), { stopReason: "toolUse" });
		return fauxAssistantMessage(
			JSON.stringify({
				validity: "valid",
				guardrails: true,
				comparison: "better",
				feedback: "Observed fixture explicitly supports K",
				requirements: [{ id: "K", verdict: "pass", evidenceIds: ["evidence"] }],
				evidence: [{
					id: "evidence",
					claimIds: ["K"],
					sourceLocator: "fixture.txt",
					location: "line 1",
					version: "fixture-v1",
					sourceFamily: "fixture",
					observation: "K is supported",
					inference: "Fixture supports K only",
					assumptions: [],
					counterevidence: [],
					access: "observed",
					limitations: ["One source family"],
				}],
			}),
		);
	}
	return results.length ? fauxAssistantMessage("Research started.") : fauxAssistantMessage(
		fauxToolCall("research_start", { contract, budget: { maxAttempts: 6, maxRounds: 2, maxCandidates: 3, maxConcurrent: 1 } }),
		{ stopReason: "toolUse" },
	);
}));
const models = createModels();
models.setProvider(faux.provider);
const bot = await openBot({
	storage: await openNodeSqliteStorage(join(root, "bot.sqlite")),
	models,
	defaultModel: { provider: "faux", modelId: "m" },
	workspaceRoot: root,
	toolMode: "direct",
	plugins: [],
	settings: { retry: { enabled: false }, compaction: { enabled: false } },
}, context);
try {
	const parent = await bot.conversation("test", "report-failure", context);
	if (mode === "fail") {
		await (await parent.submit({ type: "input", content: "Research fixture K and write the authorized report." }, context)).wait(context);
	}
	const initial = (await bot.research.status(parent.id, context)).mission!;
	await bot.harness.waitForTask(Number(initial.controllerTaskId) as TaskId<string>, context);
	const mission = (await bot.research.status(parent.id, context)).mission!;
	await fs.writeFile(join(root, `${mode}.json`), JSON.stringify({ mission, failures, acceptedAtFault, providerCalls }));
} finally {
	await bot.close(context);
}
