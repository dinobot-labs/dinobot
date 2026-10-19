import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot } from "../../src/core/bot.ts";
const [dir, mode, cut] = process.argv.slice(2) as [string, string, string];
const marker = join(dir, "cut");
const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
const models = createModels();
models.setProvider(faux.provider);
const pause = "await new Promise(()=>{});";
const mark = `await Bun.write(${JSON.stringify(marker)},"ready");`;
if (mode === "initial") {
	const code =
		cut === "before-call"
			? mark + pause
			: cut === "foreground" || cut === "background"
				? `text(await tools.task({description:"crash child",prompt:"crash child",run_in_background:${cut === "background"}}));${mark}${pause}`
				: `text(await tools.probe_effect({}));${mark}${pause}`;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
		async (_transcript, options) => {
			writeFileSync(marker, "ready");
			return new Promise((resolve) =>
				options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), {
					once: true,
				}),
			);
		},
	]);
} else faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("Recovered without replay")));
const bot = await openBot(
	{
		storage: await openNodeSqliteStorage(join(dir, "state.sqlite")),
		models,
		defaultModel: { provider: "faux", modelId: "one" },
		toolMode: "codemode-only",
		plugins: [
			{
				id: "probe",
				tools: [
					{
						name: "probe_effect",
						description: "probe",
						inputSchema: { type: "object", properties: {} },
						execute: async () => {
							if (cut === "intent" && mode === "initial") {
								writeFileSync(marker, "ready");
								await new Promise(() => {});
							}
							appendFileSync(join(dir, "effects"), "effect\n");
							if (cut === "effect" && mode === "initial") {
								writeFileSync(marker, "ready");
								await new Promise(() => {});
							}
							return { applied: true };
						},
					},
				],
			},
		],
	},
	context,
);
if (mode === "initial") {
	const conversation = await bot.conversation("test", "crash", context);
	await conversation.submit({ type: "input", content: "exercise cell", requestId: "once" }, context);
	await new Promise(() => {});
} else {
	// Background work is deliberately outside ordinary idle. Explicitly join it for the recovery assertion; a recovered
	// background child may wake the idle orchestrator for one more turn (ADR 0091), so settle until nothing is live.
	let inspection = await bot.harness.inspect(context);
	for (let round = 0; round < 10; round++) {
		await bot.harness.waitForIdle(context);
		const live = await bot.harness.inspect(context);
		await Promise.all(live.tasks.map((task) => bot.harness.waitForTask(task.record.id, context)));
		await bot.harness.waitForIdle(context);
		inspection = await bot.harness.inspect(context);
		if (inspection.tasks.length === 0) break;
	}
	writeFileSync(join(dir, "recovered"), JSON.stringify(inspection));
	await bot.close(context);
}
