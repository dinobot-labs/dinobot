import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createResearchService, ResearchServiceDoc } from "../src/core/research-service.ts";
import {
	addMission,
	bindAttempt,
	cancelMission,
	type Contract,
	createMission,
	ResearchDoc,
	reserveAttempt,
	settleAttempt,
} from "../src/core/research.ts";
const context = BACKGROUND_CONTEXT;
const roots: string[] = [], harnesses: Harness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0)) await h.close(context);
	for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
function contract(): Contract {
	return {
		question: "K?",
		hypotheses: [],
		requirements: [{ id: "K", mandatory: true }],
		scope: "fixture",
		exclusions: [],
		mode: "evidence",
		baseline: { definition: "base", artifactHash: "base-hash" },
		evaluator: { profile: "fixture", revision: "1", environmentFingerprint: "env", inputFingerprint: "input" },
		policy: { kind: "qualitative", confirmation: "required-once", maxNoProgressRounds: 2, maxDebugChildren: 1 },
		reportAuthorityRef: "none",
	};
}
async function open(root: string) {
	const registry = createRegistry();
	const h = await Harness.open(await openNodeSqliteStorage(join(root, "state.sqlite")), { registry, models: createModels() }, context);
	harnesses.push(h);
	const service = createResearchService({ getHarness: () => h, spawner: {}, workspaceRoot: root });
	return { h, service };
}
async function seed(root: string, cut: "reserve" | "intent" | "effect" | "receipt" | "cancel") {
	const { h } = await open(root);
	const conversation = await h.commit(async (tx) => {
		const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
		const m = createMission({
			id: "mission",
			baselineId: "baseline",
			controllerTaskId: "host-controller",
			ownerConversationId: String(c.id),
			projectRoot: root,
			contract: contract(),
			now: Date.now(),
		});
		reserveAttempt(m, {
			id: "a1",
			reservationKey: "stable",
			epoch: 0,
			now: Date.now(),
			action: { kind: "evaluate", candidateId: "baseline" },
		});
		if (cut !== "reserve" && cut !== "cancel") {
			bindAttempt(m, "a1", { runId: "run", nodeId: "a1", key: "key", runnerId: "command:a1" }, 0, Date.now());
		}
		if (cut === "receipt") settleAttempt(m, "a1", { state: "failed", error: "definitive execution receipt" }, 0, Date.now());
		if (cut === "cancel") cancelMission(m, "before dispatch", Date.now());
		addMission(await tx.doc(ResearchDoc, c.id), m);
		(await tx.doc(ResearchServiceDoc, c.id)).records.mission = {
			startKey: "start",
			requestHash: "hash",
			initialized: true,
			artifacts: { baseline: { content: "base" } },
			raw: {},
			external: cut === "intent" || cut === "effect"
				? { a1: { state: "intent", ...(cut === "effect" ? { pid: 12345 } : {}) } }
				: cut === "receipt"
				? { a1: { state: "done" } }
				: {},
		};
		return c.id;
	}, context);
	await h.close(context);
	harnesses.splice(harnesses.indexOf(h), 1);
	return conversation;
}
describe("research SQLite durable cut recovery", () => {
	test.each(["intent", "effect"] as const)("%s without definitive command receipt is unknown, charged, never replayed", async (cut) => {
		const root = await mkdtemp(join(tmpdir(), "research-crash-"));
		roots.push(root);
		const conversationId = await seed(root, cut);
		const { h, service } = await open(root);
		await service.recover(context);
		const first = (await service.status(conversationId, context, "mission")).mission!;
		expect(first.status).toBe("blocked");
		expect(first.attempts[0]!.state).toBe("unknown");
		expect(first.ledger.attemptsAdmitted).toBe(1);
		expect(first.ledger.activeAttemptIds).toEqual(["a1"]);
		const before = await h.snapshot(ResearchDoc, conversationId, context);
		await service.recover(context);
		expect(await h.snapshot(ResearchDoc, conversationId, context)).toEqual(before);
	});
	test("reservation before spawn stays resumable without a second charge", async () => {
		const root = await mkdtemp(join(tmpdir(), "research-reserved-"));
		roots.push(root);
		const cid = await seed(root, "reserve");
		const { h, service } = await open(root);
		await service.recover(context);
		await h.commit(async (tx) => {
			const m = (await tx.doc(ResearchDoc, cid)).missions[0]!;
			const old = reserveAttempt(m, {
				id: "a1",
				reservationKey: "stable",
				epoch: 0,
				now: Date.now(),
				action: { kind: "evaluate", candidateId: "baseline" },
			});
			expect(old.ordinal).toBe(1);
			expect(m.ledger.attemptsAdmitted).toBe(1);
		}, context);
	});
	test("definitive failed receipt survives reopen without becoming unknown or refunding", async () => {
		const root = await mkdtemp(join(tmpdir(), "research-receipt-"));
		roots.push(root);
		const cid = await seed(root, "receipt");
		const { service } = await open(root);
		await service.recover(context);
		const m = (await service.status(cid, context)).mission!;
		expect(m.attempts[0]!.state).toBe("failed");
		expect(m.ledger.activeAttemptIds).toEqual([]);
		expect(m.ledger.attemptsAdmitted).toBe(1);
	});
	test("cancellation before spawn recovers to settled cancelled without execution", async () => {
		const root = await mkdtemp(join(tmpdir(), "research-cancel-"));
		roots.push(root);
		const cid = await seed(root, "cancel");
		const { service } = await open(root);
		await service.recover(context);
		const m = (await service.status(cid, context)).mission!;
		expect(m.status).toBe("cancelled");
		expect(m.cancellationEpoch).toBe(1);
		expect(m.ledger.attemptsAdmitted).toBe(1);
		expect(m.ledger.activeAttemptIds).toEqual([]);
	});
	test("expired admission deadline fences reserved work on recovery", async () => {
		const root = await mkdtemp(join(tmpdir(), "research-deadline-"));
		roots.push(root);
		const { h, service } = await open(root);
		const cid = await h.commit(async (tx) => {
			const c = await tx.createConversation({ ownership: { kind: "ownerless" } });
			const m = createMission({
				id: "expired",
				baselineId: "b",
				controllerTaskId: "controller",
				ownerConversationId: String(c.id),
				projectRoot: root,
				contract: contract(),
				now: 0,
			});
			addMission(await tx.doc(ResearchDoc, c.id), m);
			(await tx.doc(ResearchServiceDoc, c.id)).records.expired = {
				startKey: "start",
				requestHash: "hash",
				initialized: true,
				artifacts: {},
				raw: {},
				external: {},
			};
			return c.id;
		}, context);
		await service.recover(context);
		const m = (await service.status(cid, context)).mission!;
		expect(m.status).toBe("cancelled");
		expect(m.cancellationEpoch).toBe(1);
		expect(m.ledger.attemptsAdmitted).toBe(0);
	});
});
