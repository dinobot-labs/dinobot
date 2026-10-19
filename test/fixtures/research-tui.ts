import { ChatApp } from "../../src/tui/app.ts";
import type { ApiClient } from "../../src/tui/client.ts";
import type { Manifest } from "../../src/manifest.ts";
import type { ClientEvent, DagView } from "../../src/core/ui-contract.ts";

// Deterministic backend fixture; actual ChatApp, ProcessTerminal, input and rendering are live.
const dag: DagView = {
	id: "research-round-3",
	revision: 3,
	status: "verified",
	replanBudget: 0,
	requirements: [{ id: "latency", certified: true }],
	levels: 1,
	updatedAt: Date.now(),
	nodes: [{
		id: "confirm",
		kind: "verify",
		title: "Fixed evaluator confirmation",
		state: "succeeded",
		level: 0,
		parents: [],
		directParents: [],
		attempt: 1,
		maxAttempts: 1,
		covers: ["latency"],
		critical: true,
		result: "Execution finished; inspect independent research verdict",
	}],
	research: {
		id: "research-fixture",
		revision: 9,
		question: "Can latency improve without a correctness regression?",
		status: "inconclusive",
		judgment: "undetermined",
		stopReason: "Confirmation did not reach the frozen target",
		deadlineAt: Date.now() + 60000,
		attempts: { used: 7, limit: 8 },
		rounds: { used: 3, limit: 4 },
		candidateBudget: { used: 4, limit: 8 },
		activeAttempts: 0,
		maxConcurrent: 2,
		confirmationReserved: 0,
		incumbentId: "candidate-2",
		candidates: [
			{
				id: "baseline",
				operation: "baseline",
				state: "evaluated",
				hypothesis: "Pinned baseline",
				value: 120,
				unit: "ms",
				validity: "valid",
				verdict: "fail",
				feedback: "Correct but slower than target",
			},
			{
				id: "candidate-1",
				parentId: "baseline",
				operation: "draft",
				state: "invalid",
				hypothesis: "Avoid allocation",
				validity: "invalid",
				verdict: "inconclusive",
				feedback: "Correctness guardrail failed",
			},
			{
				id: "candidate-2",
				parentId: "candidate-1",
				operation: "debug",
				state: "evaluated",
				hypothesis: "Restore ordering",
				value: 105,
				unit: "ms",
				delta: -15,
				validity: "valid",
				verdict: "fail",
				feedback: "Improved baseline but missed 100 ms target",
				runId: "research-round-3",
				nodeId: "confirm",
			},
		],
		report: { directory: ".dinobot/research/research-fixture", state: "current", writtenRevision: 9 },
	},
};
const client = {
	commands: async () => [],
	threadModel: async () => ({ model: "fixture/local", thinkingLevel: "off", supportedThinkingLevels: ["off"] }),
	events: async (_channel: string, _thread: string, receive: (event: ClientEvent) => void, signal: AbortSignal) => {
		receive({
			type: "snapshot",
			entries: [],
			tools: [],
			compactions: [],
			inbox: [],
			agent: { cwd: "/fixture/project" },
			usage: { models: {}, tools: {} },
			dag,
		});
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
	},
	researchReport: async (channel: string, thread: string, id: string, file: string) => {
		if (channel !== "tui" || thread !== "main" || id !== "research-fixture" || file !== "report.md") throw new Error("Wrong report scope");
		return "# Research fixture report\nVerdict: inconclusive\nBaseline: 120 ms; candidate: 105 ms; target: 100 ms.\nA completed DAG is not goal achievement.\nEvidence: fixed evaluator receipt; invalid first candidate retained.\nNo merge or deployment occurred.";
	},
} as unknown as ApiClient;
const app = new ChatApp(
	client,
	{ model: { provider: "fixture", modelId: "local" }, toolMode: "hybrid" } as Manifest,
	"main",
	undefined,
	undefined,
	10000,
	undefined,
	{ preferences: { load: () => ({ toolsExpanded: false }), save() {} } },
);
app.start();
setTimeout(() => {
	app.screen.stop();
	process.exit(2);
}, 15000).unref();
