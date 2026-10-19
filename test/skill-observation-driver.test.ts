import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openBot } from "../src/core/bot.ts";
import { SkillObservationDoc } from "../src/core/skills/observation.ts";

test("bot projects a real tool receipt through independent durable host work", async () => {
	// Given an enabled projector with a distinct observation writer.
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({
		storage: new MemoryStorage(), skillObservationStorage: new MemoryStorage(),
		models, defaultModel: { provider: "faux", modelId: "one" },
		plugins: [], toolMode: "direct", skillEvolution: { observe: true },
	}, context);
	try {
		const observations = bot.skillObservations;
		if (!observations) throw new Error("Observation session unavailable");
		await observations.commit(async (tx) => { await tx.doc(SkillObservationDoc); }, context);
		const watch = await observations.watchDoc(SkillObservationDoc, context);
		if (!watch) throw new Error("Observation watch unavailable");
		const signal = Promise.withResolvers<void>();
		const timeout = setTimeout(() => signal.reject(new Error("Observation event timeout")), 5000);
		watch.start(async (value) => {
			if (value?.observations.some((entry) => entry.kind === "load_succeeded" && entry.name === "debugging")) signal.resolve();
		});
		try {
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("skills_load", { name: "debugging" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("main result"),
			]);
			// When main completes, observation completion has its own event signal.
			const reply = await bot.handle({ channel: "test", threadKey: "observe", messageId: "one", userId: "u", text: "load" }, context);
			await signal.promise;
			// Then research did not replace the answer and durable receipt facts exist.
			expect(reply).toMatchObject({ status: "answered", text: "main result" });
			const saved = await observations.snapshot(SkillObservationDoc, context);
			expect(saved?.observations.filter((entry) => entry.kind === "load_succeeded")).toHaveLength(1);
		} finally {
			clearTimeout(timeout);
			await watch.stop();
		}
	} finally {
		await bot.close(context);
	}
});
