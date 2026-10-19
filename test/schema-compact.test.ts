import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot, type Bot } from "../src/core/bot.ts";
import { compactSchema } from "../src/core/schema-compact.ts";

const accepts = (schema: unknown, value: unknown) => {
	try {
		validateToolArguments({ name: "t", description: "", parameters: { type: "object", properties: { v: schema }, required: ["v"] } } as any, { type: "toolCall", id: "x", name: "t", arguments: { v: value } } as any);
		return true;
	} catch {
		return false;
	}
};
/** compactSchema must accept exactly the instances the original accepts. */
function expectEquivalent(original: unknown, samples: unknown[]) {
	const compact = compactSchema(original as any);
	for (const sample of samples) expect([sample, accepts(compact, sample)]).toEqual([sample, accepts(original, sample)]);
	return compact;
}

const predicate = Type.Union([
	Type.Object({ kind: Type.Literal("file"), path: Type.String({ minLength: 1 }), hash: Type.Optional(Type.String()) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("check"), id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("fact"), id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("node"), id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object({ kind: Type.Literal("req"), id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);

test("a union of string literals becomes one enum with the same instances", () => {
	const original = JSON.parse(JSON.stringify(Type.Union(["act", "verify", "ask"].map((k) => Type.Literal(k)), { description: "node kind" })));
	const compact = expectEquivalent(original, ["act", "verify", "ask", "Act", "", "delegate", 1, null, ["act"]]);
	expect(compact).toEqual({ type: "string", enum: ["act", "verify", "ask"], description: "node kind" });
});

test("tagged object branches that differ only by the tag merge, others stay apart", () => {
	const original = JSON.parse(JSON.stringify(predicate));
	const compact = expectEquivalent(original, [
		{ kind: "file", path: "a.ts" }, { kind: "file", path: "a.ts", hash: "h" }, { kind: "file", id: "x" }, { kind: "file", path: "" },
		{ kind: "req", id: "r1" }, { kind: "node", id: "n" }, { kind: "check", id: "c" }, { kind: "fact", id: "f" },
		{ kind: "req" }, { kind: "req", id: "" }, { kind: "req", id: "r", path: "p" }, { kind: "other", id: "x" }, { id: "x" }, "req", null,
	]) as any;
	expect(compact.anyOf).toHaveLength(2);
	expect(compact.anyOf[1].properties.kind).toEqual({ type: "string", enum: ["check", "fact", "node", "req"] });
	expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(original).length);
});

test("branches with different constraints are not merged, and non-string consts are left alone", () => {
	const original = JSON.parse(JSON.stringify(Type.Union([
		Type.Object({ kind: Type.Literal("a"), id: Type.String() }),
		Type.Object({ kind: Type.Literal("b"), id: Type.String({ minLength: 3 }) }),
		Type.Literal(3),
	])));
	const compact = expectEquivalent(original, [{ kind: "a", id: "" }, { kind: "b", id: "" }, { kind: "b", id: "abc" }, 3, 4, "a"]) as any;
	expect(compact.anyOf).toHaveLength(3);
});

test("the input object is not mutated and const/enum/required payloads are copied verbatim", () => {
	const original = JSON.parse(JSON.stringify(Type.Object({ mode: Type.Union([Type.Literal("x"), Type.Literal("y")]), anyOf: Type.String() }, { required: ["mode"] })));
	const before = JSON.stringify(original);
	const compact = compactSchema(original) as any;
	expect(JSON.stringify(original)).toBe(before);
	expect(compact.properties.mode).toEqual({ type: "string", enum: ["x", "y"] });
	expect(compact.properties.anyOf).toEqual({ type: "string" });
});

let dir: string | undefined;
let bot: Bot | undefined;
afterEach(async () => {
	await bot?.close(BACKGROUND_CONTEXT);
	bot = undefined;
	if (dir) await rm(dir, { recursive: true, force: true });
	dir = undefined;
});

test("model requests carry compacted tool schemas while stored declarations keep the originals", async () => {
	dir = await mkdtemp(join(tmpdir(), "dinobot-schema-"));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	let requested: any;
	faux.setResponses([(context: any) => { requested = getCurrentSystemMessage(context.messages); return fauxAssistantMessage("ok"); }]);
	const models = createModels();
	models.setProvider(faux.provider);
	bot = await openBot({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "codemode-only", plugins: [] }, BACKGROUND_CONTEXT);
	await bot.handle({ channel: "test", threadKey: "T1", messageId: "m1", userId: "U1", text: "hi" }, BACKGROUND_CONTEXT);
	const sent = requested.toolsAdded.find((tool: any) => tool.name === "ask");
	expect(sent.parameters.properties.kind.enum).toContain("decision");
	expect(sent.parameters.properties.kind.anyOf).toBeUndefined();
	const dag = requested.toolsAdded.find((tool: any) => tool.name === "dag_run");
	expect(dag.parameters.properties.plan.properties.init.items.anyOf).toHaveLength(2);
	const conversation = await bot.conversation("test", "T1", BACKGROUND_CONTEXT);
	const items: any[] = [];
	let cursor: Parameters<typeof conversation.entries>[2];
	do {
		const page = await conversation.entries({}, 100, cursor, BACKGROUND_CONTEXT);
		items.push(...page.items);
		cursor = page.next;
	} while (cursor);
	const stored = items.filter((item) => item.kind === "pi.system").flatMap((item) => item.model ?? []).flatMap((message: any) => message.toolsAdded ?? []).find((tool: any) => tool.name === "ask");
	expect(stored).toBeDefined();
	expect(stored.parameters.properties.kind.anyOf).toBeDefined();
	expect(stored.parameters.properties.kind.enum).toBeUndefined();
});
