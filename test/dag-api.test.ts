import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { startClientApi } from "../src/api/server.ts";
import type { AuthService } from "../src/auth/types.ts";
import { createCommands } from "../src/commands/index.ts";
import { openBot } from "../src/core/bot.ts";
import { createRun, RunDoc, start, succeed } from "../src/core/dag.ts";
import type { Plan } from "../src/core/plan.ts";
import { addMission, blockMission, createMission, nextAction, ResearchDoc, reserveAttempt, type Contract } from "../src/core/research.ts";
import { projectResearchReport } from "../src/core/research-reports.ts";
import type { ClientEvent, DagView } from "../src/core/ui-contract.ts";
import { ApiClient } from "../src/tui/client.ts";

const plan: Plan = {
	nodes: [
		{ id: "survey", kind: "act", description: "Survey the renderers" },
		{ id: "build", kind: "act", writes: ["src"], description: "Build the pane" },
		{ id: "check", kind: "verify", reads: ["src"], covers: ["R"] },
	],
	edges: [["survey", "build"], ["build", "check"]],
	goal: { requirements: ["R"] },
};

function observer() {
	const events: ClientEvent[] = [];
	const waiters: { predicate: (event: ClientEvent) => boolean; resolve: (event: ClientEvent) => void }[] = [];
	const push = (event: ClientEvent) => {
		events.push(event);
		for (const waiter of [...waiters]) if (waiter.predicate(event)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event); }
	};
	const next = (predicate: (event: ClientEvent) => boolean, label: string): Promise<ClientEvent> => {
		const seen = events.find(predicate);
		if (seen) return Promise.resolve(seen);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5000);
			waiters.push({ predicate, resolve: (event) => { clearTimeout(timer); resolve(event); } });
		});
	};
	return { events, push, next };
}

const dagOf = (event: ClientEvent): DagView | null | undefined => event.type === "dag_status" || event.type === "snapshot" ? event.dag : undefined;

const researchContract = (): Contract => ({
	question: "Does the evidence support the cache hypothesis?", hypotheses: ["Cache reduces duplicate work"],
	requirements: [{ id: "K1", mandatory: true }], scope: "API fixture", exclusions: [], mode: "evidence",
	baseline: { definition: "Unchanged reference", artifactHash: "baseline-hash" },
	evaluator: { profile: "evidence-review-v1", revision: "v1", environmentFingerprint: "fixture", inputFingerprint: "inputs" },
	policy: { kind: "qualitative", maxNoProgressRounds: 2, maxDebugChildren: 1, confirmation: "required-once" },
	reportAuthorityRef: "fixture:authorized-project",
});

test("research-only SSE snapshots, mutation, reconnect and thread isolation use durable mission state", async () => {
	const root = await mkdtemp(join(tmpdir(), "research-api-"));
	const { bot, api, close } = await openApi();
	const controllers: AbortController[] = [];
	const streams: Promise<void>[] = [];
	const watch = (thread: string) => {
		const seen = observer(), controller = new AbortController();
		controllers.push(controller);
		streams.push(new ApiClient(api.url).events("tui", thread, seen.push, controller.signal).catch(error => { if (!controller.signal.aborted) throw error; }));
		return seen;
	};
	try {
		const conversation = await bot.conversation("tui", "research", context);
		const now = Date.now();
		const mission = createMission({ id: "mission-api", ownerConversationId: String(conversation.id), controllerTaskId: "fixture-controller", baselineId: "baseline", projectRoot: root, contract: researchContract(), limits: { maxAttempts: 6, maxRounds: 2, maxCandidates: 3, maxConcurrent: 1 }, now });
		await bot.harness.commit(async tx => { addMission(await tx.doc(ResearchDoc, conversation.id), mission); }, context);
		const live = watch("research"), other = watch("other");
		const initial = dagOf(await live.next(event => event.type === "snapshot", "research snapshot"))!;
		expect(initial).toMatchObject({ status: "compiling", nodes: [], research: {
			id: "mission-api", question: mission.contract.question, status: "running", judgment: "undetermined",
			attempts: { used: 0, limit: 6 }, rounds: { used: 0, limit: 2 }, activeAttempts: 0, maxConcurrent: 1,
		} });
		expect(dagOf(await other.next(event => event.type === "snapshot", "other snapshot"))).toBeNull();

		await bot.harness.commit(async tx => {
			const current = (await tx.doc(ResearchDoc, conversation.id)).missions[0]!;
			const action = nextAction(current, now + 1);
			if (action.kind === "wait" || action.kind === "stop") throw new Error("Fixture baseline not dispatchable");
			reserveAttempt(current, { id: "attempt-1", reservationKey: "baseline-key", epoch: 0, now: now + 1, action });
		}, context);
		const admitted = dagOf(await live.next(event => event.type === "dag_status" && dagOf(event)?.research?.attempts.used === 1, "charged research attempt"))!;
		expect(admitted.research).toMatchObject({ attempts: { used: 1, limit: 6 }, candidateBudget: { used: 1, limit: 3 }, rounds: { used: 0, limit: 2 }, activeAttempts: 1, confirmationReserved: 1 });
		expect(admitted.research!.report.writtenRevision).toBeLessThan(admitted.research!.revision);

		await bot.harness.commit(async tx => { blockMission((await tx.doc(ResearchDoc, conversation.id)).missions[0]!, "evaluator unavailable", now + 2); }, context);
		const blocked = dagOf(await live.next(event => event.type === "dag_status" && dagOf(event)?.research?.status === "blocked", "blocked outcome"))!;
		expect(blocked.research).toMatchObject({ judgment: "undetermined", stopReason: "evaluator unavailable", attempts: { used: 1, limit: 6 }, report: { state: "pending" } });
		expect(blocked.status).not.toBe("verified");
		const reconnect = watch("research");
		expect(dagOf(await reconnect.next(event => event.type === "snapshot", "research reconnect"))).toEqual(blocked);

		const otherConversation = await bot.conversation("tui", "other", context);
		await bot.harness.commit(async tx => {
			addMission(await tx.doc(ResearchDoc, otherConversation.id), createMission({ id: "other-mission", ownerConversationId: String(otherConversation.id), controllerTaskId: "other-controller", baselineId: "other-baseline", projectRoot: root, contract: researchContract(), now }));
		}, context);
		await other.next(event => event.type === "dag_status" && dagOf(event)?.research?.id === "other-mission", "other mission");
		const otherReconnect = watch("other");
		expect(dagOf(await otherReconnect.next(event => event.type === "snapshot", "isolated reconnect"))?.research?.id).toBe("other-mission");
		expect(live.events.some(event => dagOf(event)?.research?.id === "other-mission")).toBe(false);
		expect(other.events.some(event => dagOf(event)?.research?.id === "mission-api")).toBe(false);
		await bot.harness.commit(async tx => {
			const runs = await tx.doc(RunDoc, conversation.id);
			runs.runs.push(createRun("execution-with-research", plan, now + 3));
			runs.activeId = "execution-with-research";
		}, context);
		const attached = dagOf(await live.next(event => event.type === "dag_status" && dagOf(event)?.id === "execution-with-research", "execution attaches to mission"))!;
		expect(attached.nodes.map(node => node.id)).toEqual(["survey", "build", "check"]);
		expect(attached.research).toEqual(blocked.research);
	} finally {
		for (const controller of controllers) controller.abort();
		await Promise.all(streams);
		await close();
		await rm(root, { recursive: true, force: true });
	}
});

test("research report route reads a real scoped artifact and rejects traversal and foreign missions", async () => {
	const root = await mkdtemp(join(tmpdir(), "research-report-api-"));
	const { bot, api, close } = await openApi();
	try {
		const conversation = await bot.conversation("tui", "owner", context);
		const mission = createMission({ id: "report-mission", ownerConversationId: String(conversation.id), controllerTaskId: "fixture-controller", baselineId: "baseline", projectRoot: root, contract: researchContract(), now: Date.now() });
		await bot.harness.commit(async tx => { addMission(await tx.doc(ResearchDoc, conversation.id), mission); }, context);
		await projectResearchReport({
			missionId: mission.id, revision: mission.revision, root, directory: `.dinobot/research/${mission.id}`,
			report: "# Finding\nUndetermined; no confirmation yet.", evidence: "Observed fixture only.", maxBytes: mission.limits.maxArtifactBytes,
		});
		await writeFile(join(root, "secret.txt"), "must not escape report containment");
		const reportUrl = (thread: string, missionId = mission.id, file = "report.md") =>
			new URL(`/v1/threads/tui/${thread}/research/${encodeURIComponent(missionId)}/report?${new URLSearchParams({ file })}`, api.url);
		const response = await fetch(reportUrl("owner"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ content: "# Finding\nUndetermined; no confirmation yet." });
		expect(await new ApiClient(api.url).researchReport("tui", "owner", mission.id, "evidence.md")).toBe("Observed fixture only.");
		for (const url of [
			reportUrl("owner", mission.id, "../../../secret.txt"),
			reportUrl("owner", mission.id, join(root, "secret.txt")),
			reportUrl("owner", mission.id, "ownership.json"),
			reportUrl("foreign"),
			reportUrl("owner", "missing-mission"),
		]) {
			const rejected = await fetch(url);
			expect(rejected.status).toBe(400);
			const body = await rejected.json();
			expect(body).toHaveProperty("error");
			expect(body).not.toHaveProperty("content");
			expect(JSON.stringify(body)).not.toContain("must not escape report containment");
		}
	} finally {
		await close();
		await rm(root, { recursive: true, force: true });
	}
});

async function openApi() {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	const models = createModels(); models.setProvider(faux.provider);
	const bot = await openBot({ storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "one" }, toolMode: "direct", plugins: [] }, context);
	const api = startClientApi(bot, 0, context, createCommands({ bot, models, auth: {} as AuthService, plugins: [], disabled: [] }));
	return { bot, api, close: async () => { await api.stop(); await bot.close(context); } };
}

test("the first snapshot carries a run committed while stream setup was still in flight", async () => {
	const { bot, api, close } = await openApi();
	const controller = new AbortController();
	let stream: Promise<void> | undefined;
	try {
		const conversation = await bot.conversation("tui", "race", context);
		const work = bot.work as { status: typeof bot.work.status };
		const original = work.status.bind(bot.work);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let paused!: () => void;
		const inSetup = new Promise<void>((resolve) => { paused = resolve; });
		work.status = async (...args) => { paused(); await gate; return original(...args); };
		const seen = observer();
		stream = new ApiClient(api.url).events("tui", "race", seen.push, controller.signal).catch((error) => { if (!controller.signal.aborted) throw error; });
		await inSetup;
		work.status = original;
		await bot.harness.commit(async (tx) => {
			const doc = await tx.doc(RunDoc, conversation.id);
			doc.runs.push(createRun("dag-race", plan, 1));
			doc.activeId = "dag-race";
		}, context);
		release();
		const snapshot = await seen.next((event) => event.type === "snapshot", "snapshot");
		expect(dagOf(snapshot)?.id).toBe("dag-race");
	} finally {
		controller.abort();
		await stream;
		await close();
	}
});

test("a failing setup step stops every watch acquired before it", async () => {
	const { bot, api, close } = await openApi();
	try {
		const harness = bot.harness as { watchDoc: (...args: unknown[]) => Promise<{ stop(): Promise<unknown> } | undefined> };
		const work = bot.work as unknown as { status: (...args: unknown[]) => Promise<unknown>; watch: (...args: unknown[]) => Promise<unknown> };
		const originals = { watchDoc: harness.watchDoc.bind(bot.harness), status: work.status.bind(bot.work), watch: work.watch.bind(bot.work) };
		let acquired = 0;
		let stopped = 0;
		harness.watchDoc = async (...args) => {
			if ((args[0] === RunDoc && failAt === "runs") || (args[0] === ResearchDoc && failAt === "research")) throw new Error("injected: document watch");
			const watch = await originals.watchDoc(...args);
			if (!watch) return watch;
			acquired++;
			const stop = watch.stop.bind(watch);
			watch.stop = async () => { stopped++; return stop(); };
			return watch;
		};
		work.status = async (...args) => { if (failAt === "status") throw new Error("injected: status"); return originals.status(...args); };
		work.watch = async (...args) => { if (failAt === "watch") throw new Error("injected: workflow watch"); return originals.watch(...args); };
		let failAt: "runs" | "research" | "status" | "watch" = "runs";
		for (const [point, expected] of [["runs", 1], ["research", 2], ["status", 3], ["watch", 3]] as const) {
			failAt = point;
			acquired = 0;
			stopped = 0;
			const response = await fetch(new URL(`/v1/threads/tui/fault-${point}/events`, api.url));
			await response.body?.cancel();
			expect(response.status).toBeGreaterThanOrEqual(500);
			expect(acquired).toBe(expected);
			expect(stopped).toBe(expected);
		}
		Object.assign(harness, { watchDoc: originals.watchDoc });
		Object.assign(work, { status: originals.status, watch: originals.watch });
	} finally {
		await close();
	}
});

test("parent SSE carries the active DAG run: null snapshot, dag_status on every change, latest view on reconnect", async () => {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	const models = createModels(); models.setProvider(faux.provider);
	const bot = await openBot({ storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "one" }, toolMode: "direct", plugins: [] }, context);
	const api = startClientApi(bot, 0, context, createCommands({ bot, models, auth: {} as AuthService, plugins: [], disabled: [] }));
	const client = new ApiClient(api.url);
	const controllers: AbortController[] = [];
	const streams: Promise<void>[] = [];
	const watch = () => {
		const seen = observer();
		const controller = new AbortController(); controllers.push(controller);
		streams.push(client.events("tui", "dag", seen.push, controller.signal).catch((error) => { if (!controller.signal.aborted) throw error; }));
		return seen;
	};
	try {
		const live = watch();
		const snapshot = await live.next((event) => event.type === "snapshot", "snapshot");
		expect(dagOf(snapshot)).toBeNull();

		const conversation = await bot.conversation("tui", "dag", context);
		const mutate = (change: (run: ReturnType<typeof createRun>) => void) => bot.harness.commit(async (tx) => {
			const doc = await tx.doc(RunDoc, conversation.id);
			const run = doc.runs.find((r) => r.id === "dag-1")!;
			change(run);
		}, context);
		await bot.harness.commit(async (tx) => {
			const doc = await tx.doc(RunDoc, conversation.id);
			doc.runs.push(createRun("dag-1", plan, 1));
			doc.activeId = "dag-1";
		}, context);
		const created = dagOf(await live.next((event) => dagOf(event)?.id === "dag-1", "created run"))!;
		expect(created.nodes.map((n) => [n.id, n.state, n.level])).toEqual([["survey", "ready", 0], ["build", "pending", 1], ["check", "pending", 2]]);

		await mutate((run) => start(run, "survey", "sa-1", 2));
		await live.next((event) => dagOf(event)?.nodes[0]?.state === "running", "survey running");
		await mutate((run) => succeed(run, "survey", "surveyed", 3));
		const moved = dagOf(await live.next((event) => dagOf(event)?.nodes[0]?.state === "succeeded", "survey done"))!;
		expect(moved.nodes[1]).toMatchObject({ id: "build", state: "ready", parents: ["survey"] });

		const updates = live.events.filter((event) => event.type === "dag_status").map((event) => JSON.stringify(dagOf(event)));
		for (let i = 1; i < updates.length; i++) expect(updates[i]).not.toBe(updates[i - 1]);

		const reconnect = watch();
		const restored = dagOf(await reconnect.next((event) => event.type === "snapshot", "reconnect snapshot"))!;
		expect(restored).toEqual(moved);

		await bot.harness.commit(async (tx) => { const doc = await tx.doc(RunDoc, conversation.id); delete doc.activeId; }, context);
		await live.next((event) => event.type === "dag_status" && event.dag === null, "cleared run");
	} finally {
		for (const controller of controllers) controller.abort();
		await Promise.all(streams);
		await api.stop();
		await bot.close(context);
	}
});
