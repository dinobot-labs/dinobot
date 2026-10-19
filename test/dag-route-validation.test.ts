import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { JsonObject, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { type Bot, openBot } from "../src/core/bot.ts";
import { RunDoc } from "../src/core/dag.ts";
import { resolveModel } from "../src/extensions/subagents.ts";

const bots: Bot[] = [];
afterEach(async () => { for (const bot of bots.splice(0)) await bot.close(context); });

const planWith = (route?: string): JsonObject => ({
	nodes: [{ id: "v", kind: "verify", covers: ["R"], ...(route === undefined ? {} : { route }) }],
	edges: [],
	goal: { requirements: ["R"] },
});

function toolResultText(messages: readonly Message[]): string {
	return messages
		.filter((message) => message.role === "toolResult")
		.flatMap((message) => message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])))
		.join("\n");
}

/** Drives one turn in which the scripted model calls dag_run with the plan, then reports the tool result text. */
async function runPlan(thread: string, plan: JsonObject): Promise<{ resultText: string; runCount: number; storedRoute?: string; blockedReason?: string }> {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "fixture" }] });
	let resultText = "";
	faux.setResponses([
		() => fauxAssistantMessage(fauxToolCall("dag_run", { plan }), { stopReason: "toolUse" }),
		(transcript) => {
			resultText = toolResultText(transcript.messages);
			return fauxAssistantMessage("done");
		},
	]);
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({ storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "fixture" }, toolMode: "direct", plugins: [], settings: { retry: { enabled: false } } }, context);
	bots.push(bot);
	const conversation = await bot.conversation("test", thread, context);
	await (await conversation.submit({ type: "input", content: "start" }, context)).wait(context);
	const doc = await bot.harness.snapshot(RunDoc, conversation.id, context);
	const run = doc?.runs[0];
	const node = run?.plan.nodes[0];
	return {
		resultText,
		runCount: doc?.runs.length ?? 0,
		...(typeof node?.route === "string" ? { storedRoute: node.route } : {}),
		...(run?.reason !== undefined ? { blockedReason: run.reason } : {}),
	};
}

test("dag_run rejects a route that resolves to a model outside the registry, with the resolution spelled out", async () => {
	const { resultText, runCount } = await runPlan("bad-route", planWith("default"));
	expect(resultText).toContain("plan rejected");
	expect(resultText).toContain('node "v"');
	expect(resultText).toContain('route "default" resolves to faux/default, which is not a configured model');
	expect(runCount).toBe(0);
});

test("dag_run rejects a route whose provider is not in the registry (the old failure surfaced only as the child's no_model)", async () => {
	const { resultText, runCount } = await runPlan("unknown-provider", planWith("nowhere/fixture"));
	expect(resultText).toContain("plan rejected");
	expect(resultText).toContain("nowhere/fixture");
	expect(runCount).toBe(0);
});

test.each([["fixture", "faux/fixture"], ["faux/fixture", "faux/fixture"], ["inherit", "faux/fixture"]] as const)(
	"dag_run accepts the valid route %p and pins it to %p in the stored plan",
	async (route, pinnedRoute) => {
		const { resultText, runCount, storedRoute } = await runPlan(`good-${route}`, planWith(route));
		expect(resultText).not.toContain("plan rejected");
		expect(runCount).toBe(1);
		// A bare or inherit route is pinned to its qualified provider/modelId at admission, so a later /model
		// switch cannot re-resolve it against another provider at dispatch time.
		expect(storedRoute).toBe(pinnedRoute);
	},
);

test("a pinned route re-resolves to the admitted model at dispatch even after the orchestrator switches provider", async () => {
	const { storedRoute } = await runPlan("pinned-after-switch", planWith("fixture"));
	expect(storedRoute).toBe("faux/fixture");
	// Dispatch calls the same resolveModel with the conversation's CURRENT model; simulate a /model switch.
	const switched = { provider: "other", modelId: "elsewhere" };
	expect(resolveModel(storedRoute!, switched)).toEqual({ provider: "faux", modelId: "fixture" });
	// Without the pin, the bare route would have drifted to the new provider (the P2 failure mode).
	expect(resolveModel("fixture", switched)).toEqual({ provider: "other", modelId: "fixture" });
});

test("dag_run without a route keeps inheriting the orchestrator model", async () => {
	const { resultText, runCount } = await runPlan("no-route", planWith());
	expect(resultText).not.toContain("plan rejected");
	expect(runCount).toBe(1);
});
