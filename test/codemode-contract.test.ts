import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	defineExtension,
	defineTool,
	Harness,
	MemoryStorage,
	hook,
	ToolTask,
	UsageDoc,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { toolExtensions } from "../src/core/toolmode.ts";

const cell = (code: string) => fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" });
test("nested invocation honors prepare, validation, before/after hooks, output, usage and invocation fencing", async () => {
	const registry = createRegistry();
	let harness!: Harness;
	let captured: ToolExecutionApi | undefined;
	let runs = 0;
	for (const extension of toolExtensions("hybrid", [], () => harness)) registry.install(extension);
	registry.install(
		defineExtension({
			name: "probe",
			tools: [
				defineTool({
					name: "probe",
					parameters: Type.Object({ n: Type.Number() }),
					description: "probe",
					prepareArguments: (args) => ({ n: Number((args as { n: unknown }).n) }),
					execute: async ({ n }, api) => {
						captured = api;
						runs++;
						if (n === 8) return { isError: true, content: [] };
						api.output(`n=${n}`);
						api.diagnostic({ severity: "info", message: "observed" });
						return {
							usage: {
								input: 1,
								output: 2,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 3,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						};
					},
				}),
			],
			hooks: [
				hook(ToolTask, {
					beforeTool: (call) =>
						call.name !== "probe"
							? undefined
							: call.arguments.n === 0
								? { block: "zero blocked" }
								: { arguments: { n: Number(call.arguments.n) * 2 } },
					afterTool: (call, result) => (call.name === "probe" ? { ...result, details: { checked: true } } : undefined),
				}),
			],
		}),
	);
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
	try {
		const conversation = await harness.createConversation(
			{ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "one" } } },
			context,
		);
		faux.setResponses([
			cell('text(await tools.probe({n:"3"}));text(await tools.probe({n:0}));text(await tools.probe({n:4}));'),
			fauxAssistantMessage("done"),
		]);
		await (await conversation.submit({ type: "input", content: "run" }, context)).wait(context);
		const messages = (await conversation.context(context)).messages;
		expect(JSON.stringify(messages)).toContain("n=6");
		expect(JSON.stringify(messages)).toContain("zero blocked");
		expect(JSON.stringify(messages)).toContain("checked");
		expect(JSON.stringify(messages)).toContain("Tool error");
		expect(JSON.stringify(messages)).toContain("2 internal call(s)");
		expect(runs).toBe(2);
		expect((await harness.snapshot(UsageDoc, conversation.id, context))?.tools.probe?.totalTokens).toBe(3);
		await expect(captured!.commit(async () => 42, context)).rejects.toThrow();
		expect(() => captured!.output("late")).toThrow();
	} finally {
		await harness.close(context);
	}
});

test.each(["before", "after"] as const)(
	"an uncooperative %s hook cannot prevent nested task cancellation",
	async (phase) => {
		const registry = createRegistry();
		let harness!: Harness;
		for (const extension of toolExtensions("hybrid", [], () => harness)) registry.install(extension);
		const entered = Promise.withResolvers<void>();
		const hang = async (call: { name: string }) => {
			if (call.name === "probe") {
				entered.resolve();
				await new Promise(() => {});
			}
			return undefined;
		};
		registry.install(
			defineExtension({
				name: "probe",
				tools: [
					defineTool({
						name: "probe",
						description: "probe",
						parameters: Type.Object({}),
						execute: async () => ({ content: [] }),
					}),
				],
				hooks: [hook(ToolTask, phase === "before" ? { beforeTool: hang } : { afterTool: hang })],
			}),
		);
		const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		try {
			const conversation = await harness.createConversation(
				{ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "one" } } },
				context,
			);
			faux.setResponses([cell("await tools.probe({})")]);
			const submission = await conversation.submit({ type: "input", content: "start" }, context);
			await entered.promise;
			await conversation.abort(context);
			expect((await submission.wait(context)).status).toBe("unanswered");
			expect((await harness.inspect(context)).tasks).toEqual([]);
		} finally {
			await harness.close(context);
		}
	},
	5000,
);
