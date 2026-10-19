import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { type Bot, openBot } from "../src/core/bot.ts";
import { acquire, type ClaimsState, liveClaims } from "../src/core/claims.ts";
import { contentText } from "../src/core/search.ts";

const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
});

async function start() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({
		storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" },
		toolMode: "direct", plugins: [], settings: { retry: { enabled: false } },
	}, context);
	bots.push(bot);
	return { bot, faux };
}

const lastToolResult: FauxResponseFactory = (transcript) => {
	const result = transcript.messages.filter((message): message is ToolResultMessage => message.role === "toolResult").at(-1);
	return fauxAssistantMessage(JSON.stringify({ isError: result?.isError ?? null, text: result ? contentText(result.content) : "" }));
};

/** Thread `test:parent` claims `parentKey`, then delegates; the child claims `childKey`. Returns the child's claim result. */
async function delegatedClaim(parentKey: string, childKey: string) {
	const { bot, faux } = await start();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("work_claim", { key: parentKey, intent: "parent work" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("task", { description: "Child", prompt: "edit the delegated part" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("work_claim", { key: childKey, intent: "delegated part" }), { stopReason: "toolUse" }),
		lastToolResult,
		lastToolResult,
	]);
	const outcome = await bot.handle({ channel: "test", threadKey: "parent", messageId: "m1", userId: "U1", text: "go" }, context);
	expect(outcome.status).toBe("answered");
	const parentAnswer = JSON.parse(outcome.status === "answered" ? outcome.text : "{}") as { text: string };
	const child = JSON.parse(parentAnswer.text.slice(parentAnswer.text.indexOf("{"), parentAnswer.text.lastIndexOf("}") + 1)) as { isError: boolean; text: string };
	return { bot, child };
}

test("a subagent may claim inside the resource its own parent thread holds", async () => {
	const { bot, child } = await delegatedClaim("repo:x", "repo:x/src");
	expect(child.text).not.toContain("Conflict");
	expect(child.isError).toBe(false);
	const claims = await liveClaims(bot.harness, context);
	expect(claims.map((claim) => claim.key).sort()).toEqual(["repo:x", "repo:x/src"]);
	expect(claims.find((claim) => claim.key === "repo:x")?.holder).toBe("test:parent");
});

test("only an unfenced ancestor's claim is exempt; fenced ancestors, siblings and the reverse direction still conflict", () => {
	const state: ClaimsState = { nextToken: 1, claims: [] };
	const child = (holder: string, key: string) => acquire(state, { key, holder, intent: "child", ttlMs: 1000, ancestors: ["t:root"] }, 0);
	expect(acquire(state, { key: "repo:x", holder: "t:root", intent: "root", ttlMs: 1000 }, 0).status).toBe("granted");
	expect(child("conversation:1", "repo:x/a").status).toBe("granted");
	expect(child("conversation:2", "repo:x/a").status).toBe("conflict"); // sibling
	expect(acquire(state, { key: "repo:x/a/b", holder: "t:root", intent: "root again", ttlMs: 1000 }, 0).status).toBe("conflict"); // parent has no exemption over its child
	state.claims[0]!.quarantined = "UNKNOWN native process provenance";
	expect(child("conversation:3", "repo:x/c").status).toBe("conflict"); // an unfinished effect of the ancestor still fences
	expect(acquire(state, { key: "repo:x/d", holder: "t:other", intent: "foreign", ttlMs: 1000 }, 0).status).toBe("conflict");
});

test("a subagent still conflicts with a claim another thread holds", async () => {
	const { bot, faux } = await start();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("work_claim", { key: "repo:y", intent: "other thread" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("held"),
		fauxAssistantMessage(fauxToolCall("task", { description: "Child", prompt: "edit y" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("work_claim", { key: "repo:y/src", intent: "child" }), { stopReason: "toolUse" }),
		lastToolResult,
		lastToolResult,
	]);
	await bot.handle({ channel: "test", threadKey: "other", messageId: "m0", userId: "U1", text: "hold" }, context);
	const outcome = await bot.handle({ channel: "test", threadKey: "parent", messageId: "m1", userId: "U1", text: "go" }, context);
	const parentAnswer = JSON.parse(outcome.status === "answered" ? outcome.text : "{}") as { text: string };
	expect(parentAnswer.text).toContain("Conflict");
	expect(parentAnswer.text).toContain("repo:y held by test:other");
});
