import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { activateEvaluatedSkill } from "../../src/core/skills/store.ts";
import { createSkillPublicationService } from "../../src/core/skills/publication.ts";

const [path, phase] = process.argv.slice(2);
if (!path || (phase !== "prepared" && phase !== "committed")) throw new Error("Expected SQLite path and crash phase");
const harness = await Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry() }, context);
const service = createSkillPublicationService({ session: harness, now: () => 1000, activatePackage: activateEvaluatedSkill });
// Keep both barriers alive; the parent synchronizes on stdout, never on this timer.
setInterval(() => {}, 1000);
if (phase === "prepared") {
	const commit = harness.commit.bind(harness);
	harness.commit = (change, ctx) => commit(async (tx) => {
		const result = await change(tx);
		console.log("prepared");
		// Barrier holds the exact uncommitted effects until the parent sends SIGKILL.
		await new Promise<void>(() => {});
		return result;
	}, ctx);
}
await service.publisher.publish({ requestId: "crash-publish", evidence: { kind: "evaluation", id: "evidence" } }, context);
console.log("committed");
await new Promise<void>(() => {});
