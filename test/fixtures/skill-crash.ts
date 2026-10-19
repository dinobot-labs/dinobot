import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot } from "../../src/core/bot.ts";

const [db, proposalId, phase] = process.argv.slice(2);
if (!db || !proposalId || !["prepared", "committed"].includes(phase!)) throw new Error("Expected database, proposal ID and crash phase");
const models = createModels();
models.setProvider(fauxProvider({ provider: "faux", models: [{ id: "one" }] }).provider);
const bot = await openBot({ storage: await openNodeSqliteStorage(db), models, defaultModel: { provider: "faux", modelId: "one" }, toolMode: "direct", plugins: [] }, context);
if (phase === "prepared") {
	const commit = bot.harness.commit.bind(bot.harness);
	bot.harness.commit = (change, ctx) => commit(async (tx) => {
		const result = await change(tx);
		console.log("prepared");
		// Deliberately hold the transaction before commit for the parent SIGKILL.
		await new Promise<void>(() => {});
		return result;
	}, ctx);
}
await bot.skills.publish({ proposalId, requestId: "crash-publish" }, "crash-test", context);
console.log("committed");
// Keep the process alive after commit, before returning a tool-level response.
setInterval(() => {}, 1000);
await new Promise<void>(() => {});
