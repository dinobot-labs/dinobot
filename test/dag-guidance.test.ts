import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { type Bot, openBot } from "../src/core/bot.ts";
import { createRun, RunDoc, summarize } from "../src/core/dag.ts";

const context = BACKGROUND_CONTEXT;
const bots: Bot[] = [];
afterEach(async () => { for (const bot of bots.splice(0)) await bot.close(context); });

test.each([false, true])("rendered dag_protocol guides unit-level verification (active run: %s)", async (active) => {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	let prompt: string | undefined;
	faux.setResponses([(transcript) => {
		for (const message of transcript.messages) {
			if (message.role === "system" && typeof message.sections?.dag_protocol === "string") {
				prompt = message.sections.dag_protocol;
			}
		}
		return fauxAssistantMessage("done");
	}]);
	const models = createModels();
	models.setProvider(faux.provider);
	const bot = await openBot({ storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [], settings: { retry: { enabled: false } } }, context);
	bots.push(bot);
	const parent = await bot.conversation("test", "dag-guidance", context);
	const run = createRun("guidance-run", {
		nodes: [{ id: "verify", kind: "verify", covers: ["R"] }],
		edges: [], goal: { requirements: ["R"] },
	}, 0);
	if (active) await bot.harness.commit(async (tx) => {
		const doc = await tx.doc(RunDoc, parent.id);
		doc.runs.push(run);
		doc.activeId = run.id;
	}, context);

	const result = await (await parent.submit({ type: "input", content: "Plan a complex multi-step implementation." }, context)).wait(context);
	expect(result.status).toBe("done");
	expect(prompt).toBeDefined();
	// Assert the provider-visible extension output, not a copied prompt fixture.
	expect(prompt).toMatch(/use DAG for multi-step work/);
	expect(prompt).toMatch(/complex or long-running work.*decompose as finely as practical.*small independently verifiable units/);
	expect(prompt).toMatch(/explicit scope, dependencies and completion criteria/);
	expect(prompt).toMatch(/Separate implementation act[/]delegate nodes from read-only verify nodes for each meaningful unit/);
	expect(prompt).toMatch(/implementation -> verification -> dependent work.*verified results/);
	expect(prompt).toMatch(/Do not defer all validation to one final mega-step.*retain final integration verification/);
	expect(prompt).toMatch(/Avoid meaningless overfragmentation.*finite node limits.*256 nodes/);

	// Existing compiler, authority, replan and research ownership controls remain.
	expect(prompt).toContain("acyclic, closure, coverage, Bernstein race freedom, verify dominance, certifying dominance, pre-effect verification, producer order, authority");
	// The certification semantics and the ask-node protocol are stated where plans are written.
	expect(prompt).toMatch(/certified by any passing verify node.*only verify nodes after it cover/);
	expect(prompt).toMatch(/verify node that reads each upstream write between it and any irreversible node/);
	expect(prompt).toMatch(/post req:<id>.*its verifiers must run after it/);
	expect(prompt).toMatch(/human authority ask.*approve or deny with the human's quote.*your own decision/);
	expect(prompt).toContain("file/check/fact/node/req predicates");
	expect(prompt).toContain("Declare reads/writes scopes");
	expect(prompt).toContain("Irreversible actions need an ask ancestor");
	expect(prompt).toMatch(/Replan.*only by extending the goal within the finite budget/);
	expect(prompt).toMatch(/Research-owned runs.*only through research_status[/]research_cancel, never generic DAG mutations/);
	if (active) expect(prompt).toContain(`Active run:\n${summarize(run)}`);
	else expect(prompt).not.toContain("Active run:");
});
