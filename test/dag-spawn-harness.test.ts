import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonObject, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { type Bot, openBot } from "../src/core/bot.ts";
import { RunDoc } from "../src/core/dag.ts";
import { AgentsDoc, ProgressDoc } from "../src/extensions/subagents.ts";

const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [];
afterEach(async () => { for (const bot of bots.splice(0)) await bot.close(context); });

type Transcript = Parameters<FauxResponseFactory>[0];
const lastUser = (t: Transcript) => t.messages.findLast((m) => m.role === "user")?.content;
const turnResults = (t: Transcript) => t.messages.slice(t.messages.findLastIndex((m) => m.role === "user") + 1).filter((m): m is ToolResultMessage => m.role === "toolResult");
const textOf = (r: ToolResultMessage | undefined) => JSON.stringify(r?.content ?? "");

const plan: JsonObject = {
	nodes: [
		{ id: "split", kind: "expand", description: "Split the corpus into shards", reads: ["corpus"], spawn: { template: { kind: "act", description: "Summarize one shard", reads: ["corpus"], writes: ["out"] }, max: 4 } },
		{ id: "check", kind: "verify", description: "Check every shard summary", reads: ["out"], covers: ["R"] },
	],
	edges: [["split", "check"]],
	goal: { requirements: ["R"] },
};

test("an expand node spawns instances end to end: read-only planner, instances dispatched, run verified", async () => {
	const prompts: Record<string, string> = {};
	let schema = "";
	const router: FauxResponseFactory = async (t) => {
		const user = String(lastUser(t));
		const node = /plan node "([^"]+)"/.exec(user)?.[1];
		if (node) {
			prompts[node] = user;
			if (node === "split") return fauxAssistantMessage(JSON.stringify({ instances: [0, 1, 2].map((i) => ({ description: `shard ${i}`, writes: [`out/${i}`] })) }));
			if (node === "check") return fauxAssistantMessage(JSON.stringify({ version: 1, requirements: [{ id: "R", verdict: "pass", evidence: "fixture checked shards" }], summary: "verified", repairable: false }));
			return fauxAssistantMessage(`established ${node}`);
		}
		// Tool declarations travel in the transcript's system messages.
		schema ||= JSON.stringify(t.messages.filter((m) => (m.role as string) === "system"));
		const last = turnResults(t).at(-1);
		if (!last) return fauxAssistantMessage(fauxToolCall("dag_run", { plan }), { stopReason: "toolUse" });
		if (/\[verified\]|\[blocked\]/.test(textOf(last))) return fauxAssistantMessage("settled");
		await Bun.sleep(30);
		return fauxAssistantMessage(fauxToolCall("dag_step", {}), { stopReason: "toolUse" });
	};
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	faux.setResponses(Array.from({ length: 120 }, () => router));
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({ storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [], settings: { retry: { enabled: false } } }, context);
	bots.push(bot);
	const parent = await bot.conversation("test", "dag-spawn", context);
	expect((await (await parent.submit({ type: "input", content: "GO" }, context)).wait(context)).status).toBe("done");

	const run = (await bot.harness.snapshot(RunDoc, parent.id, context))!.runs[0]!;
	expect(run.status).toBe("verified");
	expect(run.plan.nodes.map((n) => n.id)).toEqual(["split", "check", "split/0", "split/1", "split/2"]);
	expect(run.spawned).toBe(3);
	for (const id of ["split/0", "split/1", "split/2"]) expect(run.nodes[id]!.status).toBe("succeeded");
	// The planner runs read-only; instances are ordinary workers with their own narrowed contract.
	const agents = (await bot.harness.snapshot(AgentsDoc, parent.id, context))!.agents;
	const typeOf = async (id: string) => {
		const ref = agents.find((a) => a.taskId === run.nodes[id]!.handle)!;
		return (await bot.harness.snapshot(ProgressDoc, parent.id, String(ref.runnerId), context))?.subagent?.subagentType;
	};
	expect(await typeOf("split")).toBe("explore");
	expect(await typeOf("split/1")).toBe("general-purpose");
	expect(prompts.split).toContain("You plan a dynamic expansion");
	expect(prompts["split/1"]).toContain("You may write only within: out/1");
	expect(prompts.check).toContain("established split/2");
	expect(schema).toContain("dag_run");
	expect(schema).toMatch(/spawn.{0,40}template/);
	expect(schema).toContain("expand nodes only: the node plans read-only");
});
