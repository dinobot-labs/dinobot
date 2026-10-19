import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Value } from "typebox/value";
import { skillsCommand } from "../src/commands/skills.ts";
import { openBot, type Bot } from "../src/core/bot.ts";
import { skillAuthorSystemPrompt } from "../src/core/skills/author.ts";
import { REVIEW_DEFAULTS, SkillEvolutionShape, skillEvolutionConfig, type SkillEvolutionConfig } from "../src/core/skills/evolution-config.ts";
import { EvolutionJobDoc, EvolutionQueueDoc } from "../src/core/skills/evolution-jobs.ts";
import { createSkillEvolutionService, EvolutionCandidateDoc, EvolutionControlDoc } from "../src/core/skills/evolution-service.ts";
import { skillEvolutionExtension } from "../src/extensions/skill-evolution.ts";
import { SkillLifecycleDoc } from "../src/core/skills/retention.ts";
import { SkillDefaultDoc } from "../src/core/skills/manifests.ts";
import { buildReviewSnapshot, REVIEW_SNAPSHOT_LIMIT, SkillReviewStateDoc, transcriptCalls, truncateUtf8, unappliedSkills, type ReviewConversationDigest } from "../src/core/skills/review.ts";
import type { AuthoredSkillCandidate } from "../src/core/skills/author.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const budgets = { maxPending: 2, maxCalls: 4, maxOutputTokens: 4000, timeoutMs: 20_000, dailyMicroUsd: 1_000_000, jobMicroUsd: 400_000 };

// ─── Configuration ──────────────────────────────────────────────────────────

test("review config: defaults, prerequisites, and no observe/evaluate/confirmation/SLO requirement", () => {
	const review = skillEvolutionConfig({ author: true, budgets, review: {} });
	expect(review.problems).toEqual([]);
	expect(review.config.review).toEqual(REVIEW_DEFAULTS);
	expect(REVIEW_DEFAULTS).toEqual({ publish: true, intervalMs: 21_600_000, minConversations: 5, maxConversations: 20, maxPublishesPerDay: 3 });
	// Review is on by default; review: false opts out.
	expect(skillEvolutionConfig({}).config.review).toEqual(REVIEW_DEFAULTS);
	expect(skillEvolutionConfig({ review: false }).config.review).toBeNull();
	// Without review, author still requires observe (statistical/observation path unchanged).
	expect(skillEvolutionConfig({ author: true, budgets, review: false }).problems).toContain("author requires observe");
	expect(skillEvolutionConfig({ author: false, review: {} }).problems).toContain("review requires author");
	// Named review defaults author and budgets.
	expect(skillEvolutionConfig({ review: {} }).problems).toEqual([]);
	expect(skillEvolutionConfig({ author: true, budgets, review: { minConversations: 10, maxConversations: 5 } }).problems)
		.toContain("review.maxConversations must be >= review.minConversations");
	for (const value of [
		{ review: { intervalMs: 1 } }, { review: { maxConversations: 0 } }, { review: { maxPublishesPerDay: -1 } },
		{ review: { unknown: true } }, { review: { publish: "yes" } },
	]) expect(Value.Check(SkillEvolutionShape, value)).toBe(false);
	expect(Value.Check(SkillEvolutionShape, { author: true, budgets, review: { publish: false, intervalMs: 60_000 } })).toBe(true);
});

test("review mode adds a 24 h budget window; lifetime deployments keep their policy revision", () => {
	const getHarness = () => { throw new Error("unused"); };
	const legacy = createSkillEvolutionService({ getHarness, config: skillEvolutionConfig({ author: true, observe: true, budgets }), executorRevision: "x" });
	expect(legacy.policy?.windowMs).toBeUndefined();
	const expected = createHash("sha256").update(JSON.stringify({ limits: budgets, confirmation: null, executorRevision: "x" })).digest("hex");
	expect(legacy.policy?.revision).toBe(expected);
	const review = createSkillEvolutionService({ getHarness, config: skillEvolutionConfig({ author: true, budgets, review: {} }), executorRevision: "x" });
	expect(review.policy?.windowMs).toBe(DAY);
	expect(review.policy?.revision).not.toBe(expected);
	expect(review.policy?.totalBudget.costMicros).toBe(budgets.dailyMicroUsd);
});

test("review author prompt variant keeps the base contract and adds triggers and exclusions", () => {
	const base = skillAuthorSystemPrompt();
	const review = skillAuthorSystemPrompt("review");
	expect(review.startsWith(base)).toBe(true);
	expect(review).toContain("corrected");
	expect(review).toContain("environment or infrastructure failures");
	expect(review).toContain("Prefer edit of an existing agent-created skill");
	expect(review).toContain("no_change");
	expect(base).toContain("No tool calls are available");
});

// ─── Snapshot producer bounds ───────────────────────────────────────────────

test("UTF-8 truncation never splits a code point", () => {
	expect(truncateUtf8("가나다", 9, "")).toBe("가나다");
	expect(truncateUtf8("가나다", 8, "")).toBe("가나");
	expect(truncateUtf8("가나다", 7, "")).toBe("가나");
	expect(truncateUtf8("a😀b", 4, "")).toBe("a");
	const marked = truncateUtf8("x".repeat(5000), 1024);
	expect(Buffer.byteLength(marked)).toBeLessThanOrEqual(1024);
	expect(marked.endsWith("…[truncated]")).toBe(true);
});

test("snapshot is bounded to 64 KiB, truncates messages to 1 KiB and lists the agent catalog", () => {
	const huge = "가".repeat(4000);
	const conversations: ReviewConversationDigest[] = Array.from({ length: 20 }, (_, index) => ({
		id: index + 1, userMessages: Array.from({ length: 8 }, () => huge), finalAssistant: huge,
		tools: { read: 3, bash: 1 }, skills: { debugging: 2 }, work: "verified x1",
	}));
	const snapshot = buildReviewSnapshot(conversations, [{ name: "agent-flow", description: "Agent workflow", provenance: "agent", archived: false }]);
	expect(Buffer.byteLength(snapshot)).toBeLessThanOrEqual(REVIEW_SNAPSHOT_LIMIT);
	expect(snapshot).not.toContain("\uFFFD");
	expect(snapshot).toContain("- agent-flow [agent]: Agent workflow");
	expect(snapshot).toContain("UNTRUSTED");
	const small = buildReviewSnapshot([{ id: 7, userMessages: [huge], finalAssistant: "done", tools: { read: 2 }, skills: {}, work: null }], []);
	const line = small.split("\n").find((item) => item.startsWith("- 가"))!;
	expect(Buffer.byteLength(line)).toBeLessThanOrEqual(1024 + 2);
	expect(small).toContain("Tools called: read x2");
	expect(small).toContain("Skills loaded: none");
	expect(small).toContain("(none)");
	expect(buildReviewSnapshot([], [])).toBe(buildReviewSnapshot([], []));
});

// ─── Real SQLite bot with a faux model ──────────────────────────────────────

const bots: Bot[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
type Fixture = Awaited<ReturnType<typeof setup>>;
async function setup(input: { review?: NonNullable<SkillEvolutionConfig["review"]>; path?: string; clock?: { value: number } } = {}) {
	let path = input.path;
	if (!path) {
		const directory = await mkdtemp(join(tmpdir(), "skill-review-"));
		directories.push(directory);
		path = join(directory, "bot.sqlite");
	}
	const faux = fauxProvider({ api: "faux-skill-review", provider: "faux", models: [{ id: "one" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const clock = input.clock ?? { value: 1_000 * DAY };
	const logs: string[] = [];
	const bot = await openBot({
		storage: await openNodeSqliteStorage(path), models,
		defaultModel: { provider: "faux", modelId: "one" }, toolMode: "direct", plugins: [],
		workspaceRoot: process.cwd(), settings: { retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 } },
		skillEvolution: { author: true, budgets, review: { minConversations: 2, maxConversations: 3, intervalMs: 60_000, ...input.review } },
		curation: { now: () => clock.value, log: (message) => logs.push(message) },
	}, context);
	bots.push(bot);
	const review = bot.skillReview;
	if (!review) throw new Error("Background review is not configured");
	// Let the startup tick settle.
	await review.tick(context);
	return { bot, review, faux, clock, logs, path };
}
async function createRoots(bot: Bot, count: number): Promise<ConversationId[]> {
	return bot.harness.commit(async (tx) => {
		const ids: ConversationId[] = [];
		for (let i = 0; i < count; i++) ids.push((await tx.createConversation({ ownership: { kind: "ownerless" } })).id);
		return ids;
	}, context);
}
async function talk(f: Fixture, thread: string, text: string, answer: string): Promise<ConversationId> {
	f.faux.setResponses([fauxAssistantMessage(answer)]);
	const reply = await f.bot.handle({ channel: "test", threadKey: thread, messageId: `${thread}-1`, userId: "u1", text }, context);
	expect(reply.status).toBe("answered");
	return (await f.bot.conversation("test", thread, context)).id;
}
async function waitForReviewTask(bot: Bot) {
	const status = await bot.skillEvolution.status(context);
	const live = status.scheduled.filter((task) => task.status !== "terminal");
	expect(live).toHaveLength(1);
	return bot.harness.waitForTask(live[0]!.taskId, context);
}
function candidate(value: Partial<AuthoredSkillCandidate> & Pick<AuthoredSkillCandidate, "operation" | "name">): AuthoredSkillCandidate {
	return { hypothesis: "Users repeatedly asked for tabular reports", description: `Workflow ${value.name}`, body: `Follow the ${value.name} workflow.`, files: {}, ...value };
}
async function catalog(bot: Bot, id: ConversationId): Promise<string[]> {
	return (await bot.skills.executionList(id, context)).map((item) => item.name);
}

test("end to end: settled conversations -> snapshot -> enqueue -> schedule -> author JSON -> published skill for new conversations", async () => {
	const f = await setup();
	const { bot, review, faux, clock } = f;
	const old = await createRoots(bot, 2);
	const bare = await createRoots(bot, 1);
	const first = await talk(f, "t1", "Please always format reports as tables", "Done, formatted as a table.");
	const second = await talk(f, "t2", "Again: reports must be tables, not prose", "Understood, table format.");
	// Not settled yet: nothing is snapshotted and nothing is registered.
	expect(await review.tick(context)).toMatchObject({ action: "waiting", reason: "0/2 new settled root conversations" });
	expect((await bot.skillEvolution.status(context)).mode).toBe("paused");
	clock.value += HOUR;
	const requests: string[] = [];
	faux.setResponses([(request) => {
		requests.push(JSON.stringify(request.messages));
		return fauxAssistantMessage(JSON.stringify(candidate({ operation: "create", name: "table-reports" })));
	}]);
	const tick = await review.tick(context);
	expect(tick.action).toBe("scheduled");
	const task = await waitForReviewTask(bot);
	expect(task.state.status).toBe("terminal");
	// The author saw a review-mode prompt and only the newest maxConversations (3) settled roots.
	expect(requests).toHaveLength(1);
	expect(requests[0]).toContain("Background review");
	expect(requests[0]).toContain("Please always format reports as tables");
	for (const id of [bare[0]!, first, second]) expect(requests[0]).toContain(`### Conversation ${id}`);
	for (const id of old) expect(requests[0]).not.toContain(`### Conversation ${id}\\n`);
	const status = await review.status(context);
	expect(status.latest).toMatchObject({ status: "published", operation: "create", name: "table-reports" });
	expect(status.publishedToday).toBe(1);
	expect(status.lastConversationId).toBe(Number(second));
	const history = await bot.skills.history("table-reports", context);
	expect(history).toHaveLength(1);
	expect(history[0]!.actor).toBe("host:skill-review");
	// Default manifest changed: a NEW conversation sees the skill, an existing pinned one does not.
	const fresh = await createRoots(bot, 1);
	expect(await catalog(bot, fresh[0]!)).toContain("table-reports");
	expect(await catalog(bot, first)).not.toContain("table-reports");
	// Provenance "review": curatable by the metric-driven archive.
	expect((await bot.curation.status(context)).skills.find((item) => item.name === "table-reports")?.provenance).toBe("review");
	// Evolution status in review mode: no SLO/observe/confirmation reasons; review publication on; fixed window.
	const evolution = await bot.skillEvolution.status(context);
	expect(evolution.reviewPublicationEnabled).toBe(true);
	expect(evolution.automaticAuthorModelImplemented).toBe(true);
	expect(evolution.publicationImplemented).toBe(false);
	expect(evolution.budgetScope).toBe("fixed-window");
	expect(evolution.disabledReasons).not.toContain("verified SLO registration is missing");
	expect(evolution.disabledReasons).not.toContain("observation prerequisite is disabled");
	expect(evolution.mode).toBe("running");
	// The next tick only closes the finished job; the worker conversation is never a review input.
	clock.value += 2 * HOUR;
	expect(await review.tick(context)).toMatchObject({ action: "waiting", reason: "1/2 new settled root conversations" });
	expect((await review.status(context)).job).toBeNull();
	// Surfaced in /skills evolution status.
	const output: string[] = [];
	await skillsCommand(bot).run("evolution status", {
		surface: "tui", channel: "tui", threadKey: "main", userId: "local", context,
		io: {
			signal: new AbortController().signal, interactive: false,
			print: (text) => { output.push(text); }, notify() {}, state() {},
			prompt: async () => { throw new Error("Unexpected prompt"); },
		},
	});
	const printed = output.join("\n");
	expect(printed).toContain("Background review: publishing (reversible, unverified)");
	expect(printed).toContain("published today 1/3");
	expect(printed).toContain("Last review: published create table-reports");
	expect(printed).toContain("Budget scope: fixed 24.0h window");
});

test("skill-use signals: a failed load and a loaded-but-unapplied skill reach the author snapshot; an applied one does not", async () => {
	const f = await setup();
	const { bot, review, faux, clock } = f;
	const load = (name: string, id: string) => fauxAssistantMessage(fauxToolCall("skills_load", { name }, { id }), { stopReason: "toolUse" });
	const bash = (command: string, id: string) => fauxAssistantMessage(fauxToolCall("bash", { command }, { id }), { stopReason: "toolUse" });
	const ask = async (thread: string, responses: ReturnType<typeof fauxAssistantMessage>[]) => {
		faux.setResponses(responses);
		const reply = await bot.handle({ channel: "test", threadKey: thread, messageId: `${thread}-1`, userId: "u1", text: "How do I configure dinobot?" }, context);
		expect(reply.status).toBe("answered");
		return (await bot.conversation("test", thread, context)).id;
	};
	// Loaded the bundled dinobot skill, then answered from memory: nothing it names is used.
	const unapplied = await ask("s1", [load("dinobot", "l1"), fauxAssistantMessage("Edit some yaml.")]);
	// Loaded a skill that does not exist.
	const failed = await ask("s2", [load("ghost-skill", "l2"), fauxAssistantMessage("No such skill.")]);
	// Loaded and applied: a later call runs a command from its body.
	const applied = await ask("s3", [load("dinobot", "l3"), bash("dinobot --help", "b3"), fauxAssistantMessage("See the help output.")]);
	clock.value += HOUR;
	const requests: string[] = [];
	faux.setResponses([(request) => {
		requests.push(JSON.stringify(request.messages));
		return fauxAssistantMessage(JSON.stringify(candidate({ operation: "no_change", name: "none", body: "" })));
	}]);
	expect((await review.tick(context)).action).toBe("scheduled");
	await waitForReviewTask(bot);
	expect(requests).toHaveLength(1);
	const snapshot = JSON.parse(requests[0]!).map((message: { content: unknown }) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
	const block = (id: ConversationId) => snapshot.split(`### Conversation ${id}`)[1]!.split("### Conversation")[0]!;
	expect(block(unapplied)).toContain("Skills loaded but not visibly applied (no later call uses their commands, paths or code; heuristic): dinobot");
	expect(block(failed)).toContain("Skill loads that failed: ghost-skill");
	expect(block(failed)).not.toContain("not visibly applied");
	expect(block(applied)).toContain("Skills loaded: dinobot x1");
	expect(block(applied)).not.toContain("not visibly applied");
	expect(requests[0]).toContain("skills loaded but not visibly applied");
});

test("transcript skill signals are pure: codemode loads count, guidance-only and unknown bodies are never unapplied", () => {
	const entries = [
		{ id: 1, kind: "pi.message", model: [{ role: "assistant", content: [{ type: "toolCall", id: "c", name: "codemode", arguments: { code: "await tools.skills_load({ name: 'deploy' })" } }] }] },
		{ id: 2, kind: "pi.message", model: [{ role: "assistant", content: [{ type: "toolCall", id: "b", name: "bash", arguments: { command: "./other.sh" } }] }] },
	] as never;
	const calls = transcriptCalls(entries);
	expect(calls.firstLoad).toEqual({ deploy: 0 });
	expect(unappliedSkills(calls, { deploy: "Run `script/deploy.sh` now." })).toEqual(["deploy"]);
	expect(unappliedSkills(calls, { deploy: "Think carefully and be concise." })).toEqual([]);
	expect(unappliedSkills(calls, {})).toEqual([]);
	expect(unappliedSkills(transcriptCalls([...entries, { id: 3, kind: "pi.message", model: [{ role: "assistant", content: [{ type: "toolCall", id: "d", name: "bash", arguments: { command: "script/deploy.sh" } }] }] }] as never), { deploy: "Run `script/deploy.sh` now." })).toEqual([]);
});

test("interval gate and no_change: nothing is published and the cap is not consumed", async () => {
	const f = await setup({ review: { intervalMs: 6 * HOUR } });
	const { bot, review, faux, clock } = f;
	await createRoots(bot, 2);
	clock.value += HOUR;
	faux.setResponses([fauxAssistantMessage(JSON.stringify(candidate({ operation: "no_change", name: "none", body: "" })))]);
	expect((await review.tick(context)).action).toBe("scheduled");
	await waitForReviewTask(bot);
	expect((await review.status(context)).latest).toMatchObject({ status: "skipped", operation: "no_change" });
	expect((await review.status(context)).publishedToday).toBe(0);
	await createRoots(bot, 3);
	clock.value += HOUR;
	expect(await review.tick(context)).toMatchObject({ action: "waiting", reason: "review interval has not elapsed" });
	clock.value += 5 * HOUR;
	faux.setResponses([fauxAssistantMessage(JSON.stringify(candidate({ operation: "no_change", name: "none", body: "" })))]);
	expect((await review.tick(context)).action).toBe("scheduled");
	await waitForReviewTask(bot);
	expect((await bot.harness.snapshot(SkillReviewStateDoc, context))?.snapshots).toBe(2);
});

async function draft(bot: Bot, jobId: string, value: AuthoredSkillCandidate): Promise<string> {
	const ref = `candidate-${jobId}-1`;
	await bot.harness.commit(async (tx) => {
		const doc = await tx.doc(EvolutionCandidateDoc, ref, ref);
		doc.candidate = structuredClone(value); doc.jobId = jobId;
	}, context);
	return ref;
}
async function publish(f: Fixture, jobId: string, value: AuthoredSkillCandidate) {
	return f.review.publishJob(jobId, await draft(f.bot, jobId, value), context);
}

test("write guard refuses bundled and user edits and duplicate creates; lifecycle ops only on agent-created skills", async () => {
	const f = await setup();
	const { bot } = f;
	expect(await publish(f, "job-bundled", candidate({ operation: "edit", name: "debugging" }))).toMatchObject({ status: "refused", reason: "write guard: bundled skill is not agent-created" });
	expect(await publish(f, "job-bundled-off", candidate({ operation: "deactivate", name: "debugging", body: "" }))).toMatchObject({ status: "refused" });
	const staged = await bot.skills.propose({ name: "owner-flow", description: "Owner", body: "Owner body", files: {}, expectedGeneration: 0, requestId: "owner" }, "local-owner", context);
	await bot.skills.publish({ proposalId: staged.proposalId, requestId: "owner-publish" }, "local-owner", context);
	expect(await publish(f, "job-user", candidate({ operation: "edit", name: "owner-flow" }))).toMatchObject({ status: "refused", reason: "write guard: user skill is not agent-created" });
	expect(await publish(f, "job-unknown", candidate({ operation: "edit", name: "missing-flow" }))).toMatchObject({ status: "refused", reason: "write guard: unknown skill" });
	expect(await publish(f, "job-create", candidate({ operation: "create", name: "review-flow" }))).toMatchObject({ status: "published" });
	expect(await publish(f, "job-duplicate", candidate({ operation: "create", name: "review-flow" }))).toMatchObject({ status: "refused", reason: "write guard: create of an existing skill" });
	expect(await publish(f, "job-dup-bundled", candidate({ operation: "create", name: "debugging" }))).toMatchObject({ status: "refused" });
	// Refusals never consume the daily cap.
	expect((await f.review.status(context)).publishedToday).toBe(1);
	// Edit of the review-created skill is allowed and patches it.
	expect(await publish(f, "job-edit", candidate({ operation: "edit", name: "review-flow", body: "Improved workflow." }))).toMatchObject({ status: "published", operation: "edit" });
	expect((await bot.skills.history("review-flow", context)).map((item) => item.actor)).toEqual(["host:skill-review", "host:skill-review"]);
	// Deactivate through retention curate (reversible); a new conversation no longer sees it.
	expect(await publish(f, "job-off", candidate({ operation: "deactivate", name: "review-flow", body: "" }))).toMatchObject({ status: "published", operation: "deactivate" });
	expect((await bot.harness.snapshot(SkillLifecycleDoc, "review-flow", context))?.status).toBe("inactive");
	expect(await catalog(bot, (await createRoots(bot, 1))[0]!)).not.toContain("review-flow");
	expect((await f.review.status(context)).publishedToday).toBe(3);
});

test("daily publish cap is durable, idempotent per job, and resets on the next day", async () => {
	const f = await setup({ review: { maxPublishesPerDay: 2 } });
	const { clock } = f;
	const a = await publish(f, "job-a", candidate({ operation: "create", name: "flow-a" }));
	expect(a.status).toBe("published");
	// Exact retry of the same job: same result, no second publication or count.
	expect(await f.review.publishJob("job-a", "candidate-job-a-1", context)).toEqual(a);
	expect(await publish(f, "job-b", candidate({ operation: "create", name: "flow-b" }))).toMatchObject({ status: "published" });
	expect(await publish(f, "job-c", candidate({ operation: "create", name: "flow-c" }))).toMatchObject({ status: "skipped", reason: "daily publish cap 2 reached" });
	expect(await f.bot.skills.list(context).then((items) => items.map((item) => item.name))).not.toContain("flow-c");
	expect((await f.review.status(context)).publishedToday).toBe(2);
	clock.value += DAY;
	expect((await f.review.status(context)).publishedToday).toBe(0);
	expect(await publish(f, "job-d", candidate({ operation: "create", name: "flow-d" }))).toMatchObject({ status: "published" });
	expect((await f.bot.skills.history("flow-a", context))).toHaveLength(1);
});

test("restart: startup pause is auto-resumed, the interrupted job is rescheduled once with new deterministic ids, published once", async () => {
	const clock = { value: 1_000 * DAY };
	const first = await setup({ clock });
	await createRoots(first.bot, 2);
	clock.value += HOUR;
	const entered = Promise.withResolvers<void>();
	first.faux.setResponses([async (_request, options) => {
		entered.resolve();
		return new Promise((resolve) => {
			options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })), { once: true });
		});
	}]);
	expect((await first.review.tick(context)).action).toBe("scheduled");
	await entered.promise;
	const before = await first.bot.harness.snapshot(SkillReviewStateDoc, context);
	const jobId = before?.job?.jobId;
	if (!jobId) throw new Error("Missing review job");
	bots.splice(bots.indexOf(first.bot), 1);
	await first.bot.close(context);
	// Reopen the same SQLite file: startup pauses research and aborts the in-flight task.
	const second = await setup({ path: first.path, clock });
	let authorCalls = 0;
	second.faux.setResponses([() => {
		authorCalls++;
		return fauxAssistantMessage(JSON.stringify(candidate({ operation: "create", name: "restart-flow" })));
	}]);
	const job = await second.bot.harness.snapshot(EvolutionJobDoc, jobId, context);
	expect(job?.status).toBe("retry");
	expect(job?.attempts).toBe(1);
	// The startup pause was not an operator stop: the reviewer resumed it; retry waits for its cooldown.
	expect((await second.bot.skillEvolution.status(context)).mode).toBe("running");
	expect(await second.review.tick(context)).toMatchObject({ action: "waiting", jobId });
	clock.value += 61_000;
	expect(await second.review.tick(context)).toMatchObject({ action: "scheduled", jobId });
	await waitForReviewTask(second.bot);
	expect(authorCalls).toBe(1);
	expect((await second.review.status(context)).latest).toMatchObject({ status: "published", name: "restart-flow" });
	// Re-driving the finished job is idempotent; no duplicate snapshot, job or publication.
	await second.review.tick(context);
	const state = await second.bot.harness.snapshot(SkillReviewStateDoc, context);
	expect(state?.snapshots).toBe(1);
	expect(state?.job).toBeNull();
	expect(state?.publishCount).toBe(1);
	expect((await second.bot.harness.snapshot(EvolutionQueueDoc, context))?.coverage.accepted).toBe(1);
	expect(await second.bot.skills.history("restart-flow", context)).toHaveLength(1);
	// An explicit operator pause is never overridden by the reviewer.
	await second.bot.skillEvolution.pause("operator-pause", context, "local-owner");
	await createRoots(second.bot, 2);
	clock.value += 2 * HOUR;
	expect(await second.review.tick(context)).toMatchObject({ action: "blocked" });
	expect((await second.bot.skillEvolution.status(context)).mode).toBe("paused");
});

test("crash between enqueue and the job record: the planned snapshot is re-admitted, never a second job", async () => {
	const f = await setup();
	const { bot, review, faux, clock } = f;
	await createRoots(bot, 2);
	clock.value += HOUR;
	const evolution = bot.skillEvolution;
	const original = evolution.enqueue;
	let enqueues = 0;
	evolution.enqueue = async (...args: Parameters<typeof original>) => {
		enqueues++;
		await original(...args);
		throw new Error("simulated crash after enqueue");
	};
	try {
		await expect(review.tick(context)).rejects.toThrow("simulated crash after enqueue");
	} finally {
		evolution.enqueue = original;
	}
	expect(enqueues).toBe(1);
	const crashed = await bot.harness.snapshot(SkillReviewStateDoc, context);
	expect(crashed?.job).toBeNull();
	expect(crashed?.snapshots).toBe(0);
	const planned = crashed?.planned;
	if (!planned) throw new Error("Missing planned snapshot");
	expect(planned.enqueueRequestId).toBe(`review:enqueue:${planned.snapshotId}`);
	expect((await bot.harness.snapshot(EvolutionQueueDoc, context))?.coverage.accepted).toBe(1);
	// New settled conversations would make a different snapshot; the plan is re-admitted instead.
	await createRoots(bot, 3);
	clock.value += HOUR;
	faux.setResponses([fauxAssistantMessage(JSON.stringify(candidate({ operation: "no_change", name: "none", body: "" })))]);
	const tick = await review.tick(context);
	expect(tick).toMatchObject({ action: "scheduled", snapshotId: planned.snapshotId });
	await waitForReviewTask(bot);
	const state = await bot.harness.snapshot(SkillReviewStateDoc, context);
	expect(state?.planned).toBeNull();
	expect(state?.snapshots).toBe(1);
	expect(state?.job?.snapshotId).toBe(planned.snapshotId);
	const queue = await bot.harness.snapshot(EvolutionQueueDoc, context);
	expect(queue?.coverage.accepted).toBe(1);
	expect(queue?.pending).toHaveLength(0);
	expect((await review.status(context)).latest).toMatchObject({ status: "skipped", operation: "no_change" });
});

test("model actors cannot resume an explicit operator pause/kill; startup pauses and host resume are unchanged", async () => {
	const f = await setup();
	const evolution = f.bot.skillEvolution;
	const model = "agent:7";
	// Admission prerequisites without a review tick (which would resume as the host): one registered
	// snapshot with a provider reservation.
	const manifestHash = (await f.bot.harness.snapshot(SkillDefaultDoc, context))?.publication?.manifestHash;
	if (!manifestHash) throw new Error("Missing default manifest");
	const content = "fixture snapshot";
	const digest = createHash("sha256").update(content).digest("hex");
	const snapshotId = await evolution.registerSnapshot({
		manifestHash, evidenceDigest: digest, evidenceWindow: "fixture", evidenceCutoff: f.clock.value - 1,
		problem: "background-review", authorSnapshot: { content, hash: digest },
	}, context);
	await evolution.registerProviderReservation({ snapshotId, executorRevision: (await evolution.status(context)).executorRevision!, inputTokenUpperBound: 10_000, maximumProviderAttempts: 1, reservedMicroUsd: 1000 }, context);
	// Startup pause only (no explicit control op): review mode needs no SLO, a model may resume it.
	expect((await evolution.status(context))).toMatchObject({ mode: "paused", operatorStopped: false, canResume: true });
	await evolution.resume("model-resume-startup", context, model);
	expect((await evolution.status(context)).mode).toBe("running");
	// Exact retry of the model's own successful resume is a replay.
	await evolution.resume("model-resume-startup", context, model);
	for (const [stop, actor] of [["pause", "local-owner"], ["kill", "local-owner"], ["pause", model], ["kill", model]] as const) {
		await evolution[stop](`${stop}-${actor}`, context, actor);
		await expect(evolution.resume(`model-resume-after-${stop}-${actor}`, context, model)).rejects.toMatchObject({ code: "disabled", message: "Research was explicitly paused or killed; only the operator can resume it" });
		expect((await evolution.status(context)).mode).toBe(stop === "kill" ? "killed" : "paused");
		await evolution.resume(`owner-resume-${stop}-${actor}`, context, "local-owner");
		expect((await evolution.status(context)).mode).toBe("running");
	}
	// Legacy control documents without lastOp count as an operator stop for models only.
	await evolution.pause("legacy-pause", context, "local-owner");
	await f.bot.harness.commit(async (tx) => { delete (await tx.doc(EvolutionControlDoc)).lastOp; }, context);
	await expect(evolution.resume("model-resume-legacy", context, model)).rejects.toMatchObject({ code: "disabled" });
	await evolution.resume("host-resume-legacy", context, "host:skill-review");
	expect((await evolution.status(context)).mode).toBe("running");
	// The tool description no longer claims an SLO is always required.
	const tool = skillEvolutionExtension(evolution).tools?.find((item) => item.name === "skill_evolution_resume");
	expect(tool?.description).toContain("background review mode does not need an SLO registration");
	expect(tool?.description).toContain("statistical evaluate path requires");
	expect(tool?.description).toContain("Refused when the operator explicitly paused or killed research");
});
