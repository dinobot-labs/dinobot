import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	createRegistry,
	createSession,
	defineExtension,
	Harness,
	type HarnessSettings,
	LiveDoc,
	type ModelRef,
	type Storage,
	type Session,
	type Submission,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools, createBashTool, type BashPrepare } from "@earendil-works/pi-durable/tools";
import type { BotReply, ChannelAdapter, InboundMessage, ProgressSink } from "../channels/types.ts";
import { prepareChoice as validateChoice, humanAskPrompts, type PreparedChoice } from "./ask-choice.ts";
import { watchProgress } from "./progress-events.ts";
import { askExtension } from "../extensions/ask.ts";
import { dagExtension } from "../extensions/dag.ts";
import { goalExtension } from "../extensions/goal.ts";
import { dagContinuation } from "../extensions/dag-continuation.ts";
import { dinobotExtension } from "../extensions/dinobot.ts";
import { imagesExtension } from "../extensions/images.ts";
import { bashBudgetExtension } from "../extensions/bash-budget.ts";
import { taskProfileExtension, type PromptProfile } from "../extensions/task-profile.ts";
import { lspExtension } from "../extensions/lsp.ts";
import { memoryExtension } from "../extensions/memory.ts";
import { DISABLED_MEMORY, type MemoryConfig } from "./memory/config.ts";
import { createMemoryCurator, markCuratorDisabled, type MemoryCurator } from "./memory/curator.ts";
import { createMemoryRecall } from "./memory/recall.ts";
import { createMemoryRetro, markRetroDisabled, type MemoryRetro } from "./memory/retro.ts";
import { sessionsExtension } from "../extensions/sessions.ts";
import { schedulerExtension } from "../extensions/scheduler.ts";
import { Scheduler, scheduleSubmission } from "./scheduler.ts";
import { skillsExtension } from "../extensions/skills.ts";
import { type AgentDefinition, PLUGIN_WAKE_REQUEST_PREFIX, subagentsExtension, type SubagentSpawner, type WakeDeliver, WakeDoc, type WakeHandOver } from "../extensions/subagents.ts";
import { livenessExtension } from "../extensions/liveness.ts";
import { pluginContinuationPrefix, pluginHooksExtension } from "../extensions/plugin-hooks.ts";
import { todoExtension } from "../extensions/todo.ts";
import { verificationExtension } from "../extensions/verification.ts";
import type { LoadedPlugin, PluginWake, PluginWakeResult } from "../plugins/types.ts";
import { withDefaultSkills } from "../plugins/skills/index.ts";
import { openSessionIndex, type SessionIndex } from "./search.ts";
import { LspManager, type LspOptions } from "./lsp.ts";
import { FAST_ROUTER, fastExtension, type FastRouter } from "./fast.ts";
import { conversationForThread, liveThreadKey, pruneEmptyThreadsOnce, rootConversation, threadBinding, threadOfConversation, withThreadAdmission } from "./threads.ts";
import { validChannelName } from "./channel-identity.ts";
import { repairingRegistry } from "./argument-repair.ts";
import { AttachmentStorageError, materializeFiles } from "./message-files.ts";
import { formatInput, formatInputContent } from "./input.ts";
import { recoverQueuedTransfers, withConversationAdmission } from "./queue.ts";
import { type ToolMode, toolExtensions } from "./toolmode.ts";
import { providerLoginResolver } from "./provider-login.ts";
import { activateEvaluatedSkill, SkillStore } from "./skills/store.ts";
import { createSkillPublicationService } from "./skills/publication.ts";
import { bootstrapSkillManifest, classifyLegacySkillConversations, skillConversationCreated, SkillManifestDoc, skillManifestHash } from "./skills/manifests.ts";
import { skillEvolutionConfig, type SkillEvolutionConfig } from "./skills/evolution-config.ts";
import { SkillObservationProjector } from "./skills/observation.ts";
import { createSkillObservationDriver, SkillObservationDriverDoc } from "./skills/observation-driver.ts";
import { createSkillEvolutionService, type SkillEvolutionService } from "./skills/evolution-service.ts";
import { skillEvolutionExtension } from "../extensions/skill-evolution.ts";
import { createSkillConfirmation, type SkillConfirmationProvider } from "./skills/confirmation.ts";
import { migrateSkillsStorage } from "./skills/storage.ts";
import { sampleSkillRetentionDisk } from "./skills/retention.ts";
import { recordSkillExposure, skillCurationConfig, SkillCurationService, type SkillCurationOptions } from "./skills/curation.ts";
import { SkillReviewService } from "./skills/review.ts";
import { createWorkService, type HostStoragePaths, type WorkService } from "./verification.ts";
import type { CommandSpec } from "./research.ts";
import { createResearchService, type ResearchService } from "./research-service.ts";
import { researchExtension } from "../extensions/research.ts";
import { reconcileManagedEffects } from "./managed-effects.ts";

export type BotOptions = {
	readonly storage: Storage;
	/** Host test clock; no model-controlled timing configuration. */
	readonly scheduler?: { now?: () => number; timers?: boolean };
	readonly models: Models;
	readonly defaultModel: ModelRef;
	readonly toolMode: ToolMode;
	readonly plugins: readonly LoadedPlugin[];
	/** Default file/shell working directory; conversations may override cwd. */
	readonly workspaceRoot?: string;
	/** Existing native Bash host preparation hook; not exposed in tool/model arguments. */
	readonly bashPrepare?: BashPrepare;
	/** System prompt profile; "task" trims messaging/collaboration guidance for headless single-task runs. Default "full". */
	readonly promptProfile?: PromptProfile;
	/** Installed-only language servers. Explicit servers replace automatic defaults. */
	readonly lsp?: LspOptions;
	readonly agents?: readonly AgentDefinition[];
	readonly settings?: HarnessSettings;
	/** SQLite file of the session_search index, derived from storage and rebuilt when missing. Defaults to memory. */
	readonly searchIndexPath?: string;
	/** Host-owned runtime files/sidecars and exclusively reserved directories, never model supplied. */
	readonly runtimeStoragePaths?: HostStoragePaths;
	/** Persistent temporary reports; essential evidence is retained in durable documents. */
	readonly verificationEvidenceDir?: string;
	/** Enforce verification outcomes: unverified registered work is projected honestly, coaching, and linked todo/child completion need a certificate. Default: false (optional certification). */
	readonly enforceVerification?: boolean;
	/** Opt into the legacy tool-execution gate (work_plan, lease and environment match before effects). Default: false (YOLO tool execution). */
	readonly gateToolExecution?: boolean;
	/** Router the fast-tier hook updates; it must be the one `models` providers were wrapped with. Default: `FAST_ROUTER`. */
	readonly fastRouter?: FastRouter;
	readonly skillEvolution?: SkillEvolutionConfig;
	/** Upper bound of one blocking task_output wait; tests shorten it. Default TASK_OUTPUT_MAX_TIMEOUT_MS (5 minutes). */
	readonly taskOutputMaxWaitMs?: number;
	/**
	 * ADR 0096: channels that can post an answer the user did not request by a message (`ChannelAdapter.deliverHost`).
	 * Until such a channel is attached with {@link Bot.attachChannel}, a woken answer for one of its threads waits for it;
	 * a woken answer of any other thread (tui, http, tests) stays in the conversation's event stream.
	 */
	readonly hostChannels?: readonly string[];
	/** Tests only: how soon a woken answer whose channel could not take it is offered again (default 30 s). */
	readonly wakeDeliveryRetryMs?: number;
	/** Tests only: how long a woken answer a reply took along waits for that reply to reach the thread (default 60 s). */
	readonly wakeMergeConfirmMs?: number;
	/** Project memory loops (automatic extraction and recall). Default: both off. */
	readonly memory?: MemoryConfig;
	/** Separate telemetry backend: its failure must not poison the main Session. */
	readonly skillObservationStorage?: Storage;
	/** Trusted held-out fixtures and artifact scorer; never supplied by an author tool. */
	readonly skillConfirmationProvider?: SkillConfirmationProvider;
	/** Explicit host authority for trusted same-user worktree experiments; not a sandbox. */
	readonly researchCodeProfiles?: Record<string, CommandSpec>;
	/** Metric-driven archive of unused agent/review/evolution skills (ADR 0038). On by default. */
	readonly curation?: SkillCurationOptions & {
		/** Host clock for curation records, background review and the evolution queue; tests inject a controllable clock. Default Date.now. */
		readonly now?: () => number;
		/** Curator error sink; default console.error. */
		readonly log?: (message: string) => void;
	};
};

export type HandleOptions = { readonly whenBusy?: "steer" };
/** Redeliveries of a withdrawn (never placed) input are admitted again under a derived request id, at most this often. */
const REDELIVERY_LIMIT = 3;
/** ADR 0096: how long a woken answer waits for the reply to a later message to take it along. */
const WAKE_MERGE_GRACE_MS = 5_000;
/** ADR 0096: how long a woken answer a user's reply took along waits for that reply to reach the thread. */
const WAKE_MERGE_CONFIRM_MS = 60_000;
/** ADR 0106: how long a registered plugin wake waits for its input to be admitted (see `wake` in openBot). */
const PLUGIN_WAKE_ADMISSION_GRACE_MS = 60_000;
const PLUGIN_WAKE_KEY = /^[A-Za-z0-9:._-]{1,200}$/;
const PLUGIN_WAKE_MAX_TEXT_BYTES = 16_384;

export interface Bot {
	readonly harness: Harness;
	readonly scheduler: Scheduler;
	readonly models: Models;
	readonly skills: SkillStore;
	readonly skillEvolution: SkillEvolutionService;
	readonly skillPublication: ReturnType<typeof createSkillPublicationService>;
	readonly skillObservations?: Session;
	readonly work: WorkService;
	readonly research: ResearchService;
	/** Skill curator: run/status/archive/restore/pin (ADR 0038). */
	readonly curation: SkillCurationService;
	/** Background review (design section 6); null unless skillEvolution.review is configured. */
	readonly skillReview: SkillReviewService | null;
	/** Full-text index of every thread's history. */
	readonly index: SessionIndex;
	/** Automatic project memory extraction; started only when enabled. */
	readonly memoryCurator: MemoryCurator;
	/** Work retrospectives that maintain the working agreements; started only when enabled. */
	readonly memoryRetro: MemoryRetro;
	/** The durable conversation of a channel thread, created on first use. */
	conversation(channel: string, threadKey: string, context: Context, initialCwd?: string): Promise<Conversation>;
	/** Durably admit a message without waiting for its answer. A busy thread queues it as a follow-up or steer. */
	prepareChoice(message: InboundMessage, context: Context): Promise<PreparedChoice>;
	submit(message: InboundMessage, context: Context, whenBusy?: "followUp" | "steer"): Promise<Submission>;
	/** Submit and wait for the answer; `progress` receives the turn's progress events until it settles (ADR 0047).
	 * `whenBusy: "steer"` joins a running turn of the same conversation (ADR 0057); if the context is aborted while such a
	 * submission is still queued, it is withdrawn so a later redelivery can run it afresh. */
	handle(message: InboundMessage, context: Context, progress?: ProgressSink, options?: HandleOptions): Promise<BotReply>;
	/** ADR 0096: lets a started channel post woken answers of its threads (see {@link BotOptions.hostChannels}). Returns the detach. */
	attachChannel(channel: Pick<ChannelAdapter, "name" | "deliverHost" | "holdsAnswer">): () => void;
	close(context: Context): Promise<void>;
}

/**
 * Open the durable runtime and resume work an earlier process left unfinished.
 * The Harness owns every conversation, model turn and tool call; the bot only maps
 * channel threads onto conversations.
 */
export async function openBot(options: BotOptions, context: Context): Promise<Bot> {
	/** The bot's own lifetime context, for work that must outlive one aborted request context. */
	const botContext = context;
	const evolution = skillEvolutionConfig(options.skillEvolution);
	if (evolution.problems.length) throw new Error(evolution.problems.join("; "));
	const { now: curationNow = Date.now, log: curationLog = (message: string) => console.error(message), ...curationInput } = options.curation ?? {};
	const curationConfig = skillCurationConfig(curationInput);
	if (curationConfig.problems.length) throw new Error(curationConfig.problems.join("; "));
	if (evolution.config.observe && !options.skillObservationStorage) throw new Error("Skill observation requires a separate durable storage backend");
	if (options.skillObservationStorage === options.storage) throw new Error("Skill observations cannot share the main storage backend");
	if (options.skillConfirmationProvider &&
		(!evolution.config.confirmation || options.skillConfirmationProvider.id !== evolution.config.confirmation.contractId ||
		options.skillConfirmationProvider.environmentRevision !== evolution.config.confirmation.environmentRevision)) {
		throw new Error("Trusted confirmation provider does not match configured contract/environment");
	}
	const plugins = await withDefaultSkills(options.plugins);
	const registry = repairingRegistry(createRegistry());
	const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
	registry.install(options.bashPrepare ? defineExtension({ ...CodingTools, tools: CodingTools.tools!.map(tool => tool.name === "bash" ? createBashTool({ prepare: options.bashPrepare! }) : tool) }) : CodingTools);
	registry.install(imagesExtension());
	registry.install(bashBudgetExtension());
	const memory = options.memory ?? DISABLED_MEMORY;
	const auxModel = memory.auto.model;
	if (memory.auto.enabled && auxModel && !options.models.getModel(auxModel.provider, auxModel.modelId)) {
		throw new Error(`memory.auto.model: unknown model ${auxModel.provider}/${auxModel.modelId}`);
	}
	const retroModel = memory.retro.model;
	if (memory.retro.enabled && retroModel && !options.models.getModel(retroModel.provider, retroModel.modelId)) {
		throw new Error(`memory.retro.model: unknown model ${retroModel.provider}/${retroModel.modelId}`);
	}
	const getMemoryHarness = () => {
		if (!openedHarness) throw new Error("Bot harness is not open");
		return openedHarness;
	};
	// Registered even when disabled, so a curator task left by an earlier enabled run can still resume and settle.
	const projectAliases = memory.projectAliases ?? [];
	const memoryCurator = createMemoryCurator({ config: memory.auto, workspaceRoot, projectAliases, getHarness: getMemoryHarness });
	const memoryRecall = createMemoryRecall({ config: memory.recall, workspaceRoot, projectAliases, getHarness: getMemoryHarness });
	const memoryRetro = createMemoryRetro({ config: memory.retro, workspaceRoot, projectAliases, getHarness: getMemoryHarness });
	registry.install(memoryExtension({
		workspaceRoot, projectAliases, tasks: [memoryCurator.task, memoryRetro.task], automatic: memory.auto.enabled || memory.recall.enabled,
		retro: memory.retro.enabled, agreementLimits: memory.retro,
	}));
	/**
	 * A work_finish or DAG run ended verified/blocked (ADR 0030): score the skill versions the conversation loaded and
	 * count the outcome for the retrospective. Advisory: a failure is logged and never fails the tool call.
	 */
	const onOutcome = async (conversationId: ConversationId, outcome: "verified" | "blocked", outcomeContext: Context) => {
		try {
			if (openedSkills) await openedSkills.recordOutcome(conversationId, outcome, outcomeContext);
		} catch (error) {
			console.error(`[skills] outcome of conversation ${conversationId} not recorded: ${error instanceof Error ? error.message : String(error)}`);
		}
		try {
			await memoryRetro.noteOutcome(conversationId, outcomeContext);
		} catch (error) {
			console.error(`[memory.retro] outcome of conversation ${conversationId} not recorded: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	registry.install(fastExtension(options.models, options.fastRouter ?? FAST_ROUTER));
	const lsp = new LspManager(options.lsp);
	registry.install(lspExtension(lsp));
	let openedHarness: Harness | undefined;
	const scheduler = new Scheduler(() => { if (!openedHarness) throw new Error("Bot harness is not open"); return openedHarness; }, botContext, options.scheduler?.now);
	registry.install(schedulerExtension(scheduler));
	let openedIndex: SessionIndex | undefined;
	let openedSkills: SkillStore | undefined;
	let openedCuration: SkillCurationService | undefined;
	let openedReview: SkillReviewService | undefined;
	const skillPublication = createSkillPublicationService({
		get session() {
			if (!openedHarness) throw new Error("Bot harness is not open");
			return openedHarness;
		},
		now: Date.now, activatePackage: activateEvaluatedSkill,
		...(evolution.config.deactivate ? { lifecycle: {} } : {}),
	});
	const authorModel = options.models.getModel(options.defaultModel.provider, options.defaultModel.modelId);
	const skillEvolution = createSkillEvolutionService({
		getHarness: () => {
			if (!openedHarness) throw new Error("Bot harness is not open");
			return openedHarness;
		},
		config: evolution,
		// One host clock: review evidence cutoffs, budget windows and curation records agree.
		now: curationNow,
		retainSnapshot: async (tx, id, manifestHash) => {
			const manifest = (await tx.doc(SkillManifestDoc, manifestHash, null)).manifest;
			if (!manifest || skillManifestHash(manifest) !== manifestHash) throw new Error("Research snapshot manifest is unavailable");
			if (manifest.catalog.length) await skillPublication.lifecycle.acquireReference(tx, {
				id: `snapshot:${id}`, kind: "evaluation",
				packages: manifest.catalog.map(({ name, version }) => ({ name, version })),
			});
		},
		capacity: {
			sample: () => sampleSkillRetentionDisk(options.runtimeStoragePaths?.files[0] ?? workspaceRoot),
			admit: async (tx, freeBytes, additionalBytes) => {
				await skillPublication.lifecycle.recordCapacity(tx, { freeBytes, essentialReserveBytes: 64 * 1024 * 1024 });
				await skillPublication.lifecycle.assertResearchCapacity(tx, additionalBytes);
			},
		},
		...(options.skillConfirmationProvider && evolution.config.confirmation ? {
			confirmation: createSkillConfirmation({
				harness: () => {
					if (!openedHarness) throw new Error("Bot harness is not open");
					return openedHarness;
				},
				skills: () => {
					if (!openedSkills) throw new Error("Skill store is not initialized");
					return openedSkills;
				},
				publication: skillPublication, provider: options.skillConfirmationProvider,
				autoPublish: evolution.config.autoPublish,
				anchorManifest: evolution.config.confirmation.anchorManifest,
				lifecycleEnabled: evolution.config.deactivate,
			}),
		} : {}),
		...(authorModel ? { builtinAuthor: { models: options.models, model: authorModel }, executorRevision: "tool-less-author-v1" } : {}),
		...(evolution.config.review ? {
			reviewFinalize: async (order, result, finalizeContext) => {
				if (!openedReview) throw new Error("Skill review is not initialized");
				await openedReview.finalize(order, result, finalizeContext);
			},
		} : {}),
	});
	registry.install(skillEvolutionExtension(skillEvolution));
	const observationSession = options.skillObservationStorage ? createSession(options.skillObservationStorage) : undefined;
	let observationProjector: SkillObservationProjector | undefined;
	const observationDriver = createSkillObservationDriver(() => {
		if (!observationProjector) throw new Error("Skill observation projector is unavailable");
		return observationProjector;
	}, () => {
		if (!openedHarness) throw new Error("Bot harness is not open");
		return openedHarness;
	});
	registry.install(defineExtension({ name: "skill-observation", tasks: [observationDriver.task] }));
	const temporaryEvidence = options.verificationEvidenceDir === undefined;
	const evidenceDirectory = temporaryEvidence
		? await mkdtemp(join(tmpdir(), "dinobot-verification-"))
		: resolve(options.verificationEvidenceDir!);
	await mkdir(evidenceDirectory, { recursive: true });
	const canonicalEvidence = await realpath(evidenceDirectory);
	const work = createWorkService({
		getHarness: () => {
			if (!openedHarness) throw new Error("Bot harness is not open");
			return openedHarness;
		},
		workspaceRoot,
		hostStorage: {
			files: (options.runtimeStoragePaths?.files ?? []).map((path) => resolve(path)),
			directories: [...(options.runtimeStoragePaths?.directories ?? []).map((path) => resolve(path)), canonicalEvidence],
		},
		evidenceDirectory: canonicalEvidence,
		enforceVerification: options.enforceVerification ?? false,
		gateToolExecution: options.gateToolExecution ?? false,
	});
	registry.install(skillsExtension(() => {
		if (!openedSkills) throw new Error("Skill store is not initialized");
		return openedSkills;
	}, () => {
		if (!openedCuration) throw new Error("Skill curation is not initialized");
		return openedCuration;
	}, { curationEnabled: curationConfig.config.enabled }));
	registry.install(dinobotExtension(options.toolMode, plugins));
	for (const extension of toolExtensions(options.toolMode, plugins, () => {
		if (!openedHarness) throw new Error("Bot harness is not open");
		return openedHarness;
	}, providerLoginResolver(options.models))) registry.install(extension);
	registry.install(todoExtension(work));
	registry.install(goalExtension());
	registry.install(askExtension(work, () => {
		if (!openedHarness) throw new Error("Bot harness is not open");
		return openedHarness;
	}));
	/**
	 * ADR 0096: the answer of a woken turn (no channel message asked for it) is handed to the channel of the thread the
	 * conversation is bound to. Unbound (subagent), archived (after /new) and non-native (tui, http) conversations keep it
	 * in their event stream; a native channel that is not attached yet is retried by the wake watcher.
	 */
	type HostSink = { deliver: NonNullable<ChannelAdapter["deliverHost"]>; holds(threadKey: string, answer: number): boolean | undefined };
	const hostSinks = new Map<string, HostSink>();
	const mergeConfirmMs = options.wakeMergeConfirmMs ?? WAKE_MERGE_CONFIRM_MS;
	const hostChannels = new Set(options.hostChannels ?? []);
	const deliverWake: WakeDeliver = async (delivery, context) => {
		const opened = openedHarness;
		if (!opened) return "retry";
		const thread = await threadOfConversation(opened, delivery.conversationId, context);
		if (!thread) return "done";
		const record = await opened.commit((tx) => tx.submissionByRequest(delivery.conversationId, delivery.requestId), context);
		// A plugin wake registers its hand-over just before it submits the input (ADR 0106): wait for that admission briefly.
		if (!record && delivery.requestId.startsWith(PLUGIN_WAKE_REQUEST_PREFIX) && Date.now() - delivery.since < PLUGIN_WAKE_ADMISSION_GRACE_MS) return "pending";
		if (!record || record.type !== "input") return "done";
		if (record.status !== "done" && record.status !== "unanswered") return "pending";
		const sink = hostSinks.get(thread.channel);
		if (!sink) return hostChannels.has(thread.channel) ? "retry" : "done";
		// An aborted woken turn (the user stopped it) has nothing to say.
		if (record.status === "unanswered" && record.reason === "aborted") return "done";
		// A user's reply took it along (handle()): done once the thread holds that reply. A reply that never got there (its
		// job failed or was too long) leaves this answer to be handed over by itself after the confirmation window.
		if (delivery.mergedInto !== undefined) {
			if (sink.holds(thread.threadKey, delivery.mergedInto)) return "done";
			if (Date.now() - (delivery.mergedAt ?? 0) < mergeConfirmMs) return "pending";
		}
		// A later input is running (often the user's own "did you finish?"): its reply takes this answer along, ahead of
		// itself (handle()), so the woken answer never arrives after the reply to a newer message.
		else if ((await opened.snapshot(LiveDoc, delivery.conversationId, context))?.run) return "pending";
		// A later input was already answered: its reply is being composed now and takes this answer along; give it that moment.
		if (record.status === "done" && delivery.mergedInto === undefined) {
			const recent = (await (await opened.conversation(delivery.conversationId, context))?.entries({}, 20, undefined, context))?.items ?? [];
			const later = recent.find((entry) => Number(entry.id) > Number(record.answer) && entry.model?.some((message) => message.role === "assistant" && message.stopReason !== "toolUse"));
			const at = later?.model?.find((message) => message.role === "assistant")?.timestamp;
			if (at !== undefined && Date.now() - at < WAKE_MERGE_GRACE_MS) return "pending";
		}
		// Claim it: from now on a reply to the user's next message no longer takes this answer along (handle()).
		const claimed = await opened.commit(async (tx) => {
			const item = (await tx.doc(WakeDoc, delivery.conversationId)).deliveries?.find((entry) => entry.requestId === delivery.requestId);
			if (!item) return "gone" as const;
			// A reply may have taken it along since this check began: that reply decides, as above.
			if (item.mergedInto !== undefined && item.mergedAt !== delivery.mergedAt) return "merged" as const;
			delete item.mergedInto;
			delete item.mergedAt;
			item.claimed = true;
			return "claimed" as const;
		}, context);
		if (claimed === "gone") return "done";
		if (claimed === "merged") return "pending";
		let reply: Extract<BotReply, { status: "answered" }>;
		if (record.status === "done") {
			const answer = await opened.commit((tx) => tx.entry(record.answer), context);
			const projected = await work.projectSubmission(record.conversationId, String(record.id), answerText(answer?.model), context);
			const asks = await humanAskPrompts(opened, record.conversationId, delivery.since, context, delivery.asks);
			reply = { status: "answered", text: projected.text, answer: Number(record.answer), ...(asks.length ? { asks } : {}) };
		} else {
			reply = { status: "answered", text: `⚠️ 백그라운드 작업 결과를 처리하지 못했습니다: ${record.reason}\n이 스레드에 메시지를 보내 주시면 이어서 처리합니다.` };
		}
		try {
			return sink.deliver(thread.threadKey, reply, `host:${delivery.conversationId}:${record.id}`) === "unavailable" ? "retry" : "done";
		} catch {
			return "retry";
		}
	};
	const wakeRecovery: { current?: (context: Context) => Promise<void> } = {};
	const wakeHandOver: { current?: WakeHandOver } = {};
	const spawner: { current?: SubagentSpawner } = {};
	registry.install(subagentsExtension(() => {
		if (!openedHarness) throw new Error("Bot harness is not open");
		return openedHarness;
	}, work, options.agents, spawner, options.taskOutputMaxWaitMs, { deliver: (delivery, context) => deliverWake(delivery, context), recovery: wakeRecovery, handOver: wakeHandOver, ...(options.wakeDeliveryRetryMs ? { retryMs: options.wakeDeliveryRetryMs } : {}) }));
	registry.install(dagExtension(work, spawner, options.models, onOutcome));
	const ordinaryDag = dagContinuation(() => openedHarness!);
	registry.install(ordinaryDag.extension);
	const research = createResearchService({
		getHarness: () => {
			if (!openedHarness) throw new Error("Bot harness is not open");
			return openedHarness;
		},
		spawner, workspaceRoot, codeProfiles: options.researchCodeProfiles,
	});
	registry.install(researchExtension(research));
	registry.install(sessionsExtension(
		() => {
			if (!openedHarness) throw new Error("Bot harness is not open");
			return openedHarness;
		},
		() => {
			if (!openedIndex) throw new Error("Session index is not open");
			return openedIndex;
		},
	));
	registry.install(verificationExtension(work, plugins.flatMap((plugin) =>
		plugin.tools.filter((tool) => tool.readOnly !== true).map((tool) => tool.name),
	), onOutcome));
	// Plugin turn-end checks (ADR 0105) run before the goal liveness hook: a mechanical ledger finding is more specific.
	registry.install(pluginHooksExtension(() => {
		if (!openedHarness) throw new Error("Bot harness is not open");
		return openedHarness;
	}, plugins, (error) => console.error("plugin onTurnEnd failed:", error instanceof Error ? error.message : error)));
	// Last onYield hook (ADR 0096): the first continuation wins, so every arming hook above runs before it decides.
	registry.install(livenessExtension(() => {
		if (!openedHarness) throw new Error("Bot harness is not open");
		return openedHarness;
	}));
	if (options.promptProfile === "task") registry.install(taskProfileExtension(options.toolMode));
	const harness = await Harness.open(
		options.storage,
		{
			models: options.models, registry,
			conversationCreated: async (tx, record) => {
				await skillConversationCreated(tx, record, evolution.config.sessionPinning);
				await skillPublication.lifecycle.pinAcquired(tx, record);
				await recordSkillExposure(tx, record, curationNow());
			},
			beforeModelRequest: async ({ conversationId }, requestContext) => {
				if (!openedSkills) throw new Error("Skill store is not initialized");
				await openedSkills.executionList(conversationId, requestContext);
			},
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: resolve(workspaceRoot, cwd ?? ".") }),
			...(options.settings ? { settings: options.settings } : {}),
		},
		context,
	);
	openedHarness = harness;
	const skills = new SkillStore(harness, { evidenceChecked: (actor) => actor.startsWith("agent:"), managedManifests: true, retention: skillPublication.lifecycle, now: curationNow });
	const curation = new SkillCurationService({
		harness: () => harness, retention: skillPublication.lifecycle, config: curationConfig.config,
		now: curationNow, log: curationLog,
	});
	openedCuration = curation;
	const reviewConfig = evolution.config.review;
	const review = reviewConfig && evolution.config.budgets ? new SkillReviewService({
		harness: () => harness, evolution: skillEvolution, skills: () => skills, retention: skillPublication.lifecycle,
		config: reviewConfig, publish: reviewConfig.publish && !options.skillConfirmationProvider,
		jobMicroUsd: evolution.config.budgets.jobMicroUsd, executorRevision: "tool-less-author-v1",
		settleMs: curationConfig.config.settleMs, now: curationNow, log: curationLog,
	}) : null;
	openedReview = review ?? undefined;
	try {
		await migrateSkillsStorage(harness, context);
		await harness.commit(classifyLegacySkillConversations, context);
		await harness.commit((tx) => bootstrapSkillManifest(tx, "skills-v1"), context);
		await skills.initialize(plugins.flatMap((plugin) => plugin.skillPackages ?? []), context);
		await skillEvolution.startup(context);
		if (!evolution.config.observe) {
			const driver = await harness.snapshot(SkillObservationDriverDoc, context);
			if (driver?.taskId) await harness.abortTask(driver.taskId, context);
		}
		await work.recover(context);
		await reconcileManagedEffects(harness, plugins.flatMap(p => p.tools), context);
		await research.recover(context);
	} catch (error) {
		await harness.close(context);
		await observationSession?.close(context);
		await lsp.close();
		if (temporaryEvidence) await rm(evidenceDirectory, { recursive: true, force: true });
		throw error;
	}
	openedSkills = skills;
	if (observationSession && evolution.config.observe) {
		observationProjector = new SkillObservationProjector({
			source: harness, observations: observationSession,
			limits: { maxObservations: 4096, maxBytes: 4 * 1024 * 1024, pageSize: 128 },
		});
		await observationDriver.start(harness, context);
	}
	// Once per store, before anything can submit: drop TUI sessions that were opened but never used.
	const pruned = await pruneEmptyThreadsOnce(harness, "tui", context);
	if (pruned.length > 0) console.log(`dinobot: removed ${pruned.length} empty tui session(s)`);
	const index = openSessionIndex(harness, options.searchIndexPath ?? ":memory:");
	openedIndex = index;
	await index.catchUp(context);
	await recoverQueuedTransfers(harness, context);
	await ordinaryDag.recover(context);
	await wakeRecovery.current?.(context);
	harness.resume();
	/**
	 * ADR 0106: one host-started turn for a plugin (a calendar reminder that came due), into the live conversation of the
	 * thread `request.conversationId` belongs to. `plugin-wake:<pluginId>:<key>` is the input's request id, so one key
	 * starts at most one turn, ever, across restarts and /new rotations.
	 *
	 * Crash windows: the channel hand-over is registered (and the wake watcher armed) BEFORE the input is submitted. A crash
	 * after the registration leaves a hand-over without input; deliverWake waits PLUGIN_WAKE_ADMISSION_GRACE_MS for it and
	 * then drops it, and the plugin's retry (its reminder is still pending, since it never saw "admitted") submits and
	 * registers again. A crash after the submission leaves both. The reverse order would leave an admitted turn whose
	 * answer never reaches the channel when the crash fell between the two commits and the turn settled before a retry.
	 * Admission runs on the thread's admission line, so /new cannot rotate the thread between resolution and submission.
	 */
	let closed = false;
	async function wake(pluginId: string, request: PluginWake, ready?: () => Promise<boolean>): Promise<PluginWakeResult> {
		if (typeof request.key !== "string" || !PLUGIN_WAKE_KEY.test(request.key)) throw new Error("plugin wake key must match [A-Za-z0-9:._-]{1,200}");
		if (typeof request.text !== "string" || request.text.trim() === "") throw new Error("plugin wake text must not be empty");
		if (Buffer.byteLength(request.text, "utf8") > PLUGIN_WAKE_MAX_TEXT_BYTES) throw new Error(`plugin wake text exceeds ${PLUGIN_WAKE_MAX_TEXT_BYTES} bytes`);
		if (closed) return "unavailable";
		try {
			return await admitPluginWake(pluginId, request, ready);
		} catch (error) {
			if (closed) return "unavailable";
			throw error;
		}
	}
	const GONE = Symbol("gone");
	async function admitPluginWake(pluginId: string, request: PluginWake, ready?: () => Promise<boolean>): Promise<PluginWakeResult> {
		const context = botContext;
		if (!/^\d+$/.test(request.conversationId)) return "gone";
		const root = await rootConversation(harness, Number(request.conversationId) as ConversationId, context);
		if (root === undefined || !(await harness.conversation(root, context))) return "gone";
		const requestId = `${PLUGIN_WAKE_REQUEST_PREFIX}${pluginId}:${request.key}`;
		const admit = async (target: Conversation, lineage: readonly ConversationId[]): Promise<PluginWakeResult> => {
			// Core schedules belong to the exact origin, never a replacement conversation after /new.
			if (ready && target.id !== root) return "gone";
			const existing = await harness.commit(async (tx) => {
				for (const id of [target.id, ...lineage]) {
					const found = await tx.submissionByRequest(id, requestId);
					if (found) return found;
				}
				return undefined;
			}, context);
			if (existing) {
				// Admitted before. Only a turn of the live conversation that has not settled may still need its hand-over (an
				// earlier call stopped between the two steps); a settled one was handed over or taken along by a reply already.
				// A still queued input restarts the admission grace of its registration; a placed one may have opened asks.
				if (existing.conversationId === target.id && existing.type === "input" && (existing.status === "queued" || existing.status === "placed")) {
					await wakeHandOver.current?.(target.id, requestId, context, { restartGrace: existing.status === "queued" });
				}
				return "duplicate";
			}
			if (ready && !await ready()) return "unavailable";
			// A registration left by a crash before its submission is re-registered with a fresh admission grace, so the
			// watcher cannot drop it between this commit and the submission below.
			await wakeHandOver.current?.(target.id, requestId, context, { restartGrace: true });
			if (ready && !await ready()) return "unavailable";
			await target.submit({ type: "input", content: `${pluginContinuationPrefix(pluginId)}\n${request.text}`, requestId }, context);
			return "admitted";
		};
		const key = await liveThreadKey(harness, root, context);
		try {
			if (key === undefined) {
				const target = await harness.conversation(root, context);
				if (!target) return "gone";
				return await withConversationAdmission(harness, root, () => admit(target, []));
			}
			return await withThreadAdmission(harness, key, async () => {
				const bound = (await threadBinding(harness, key, context)).conversationId;
				const target = bound === undefined ? undefined : await harness.conversation(bound, context);
				if (!target) throw GONE;
				return target;
			}, context, (target, binding) => admit(target, binding.lineage));
		} catch (error) {
			if (error === GONE) return "gone";
			throw error;
		}
	}
	// ADR 0106: plugins start their background work once the bot recovered and before channels start. main.ts closes them
	// after the bot, so a late timer may still call wake after close: it gets "unavailable".
	for (const plugin of plugins) {
		if (!plugin.start) continue;
		try {
			await plugin.start({ wake: (request) => wake(plugin.id, request) });
		} catch (error) {
			console.error(`plugin ${plugin.id} start failed:`, error instanceof Error ? error.message : error);
		}
	}
	scheduler.start((request, ready) => wake("scheduler", request, ready), async (schedule) => {
		const record = await scheduleSubmission(harness, schedule, botContext);
		if (record?.type !== "input") return undefined;
		if (record.status === "done") return { state: "completed", result: answerText((await harness.commit(tx => tx.entry(record.answer), botContext))?.model).slice(0, 4000) };
		if (record.status === "unanswered") return { state: "failed", result: record.reason };
		return undefined;
	}, options.scheduler?.timers ?? true);
	if (memory.auto.enabled) await memoryCurator.start(harness, context);
	else await markCuratorDisabled(harness, context);
	if (memory.retro.enabled) await memoryRetro.start(harness, context);
	else await markRetroDisabled(harness, context);
	// Startup run (after skills.initialize) and the unref'd interval; serialized, errors logged.
	curation.start(context);
	// Background review timer (design section 6): serialized ticks, unref'd, errors logged.
	review?.start(context);

	async function conversation(channel: string, threadKey: string, context: Context, initialCwd?: string): Promise<Conversation> {
		if (!validChannelName(channel)) throw new Error("channel must be non-empty and contain no colon");
		const key = `${channel}:${threadKey}`;
		const conversationId = await conversationForThread(harness, options.models, key, options.defaultModel, context, initialCwd ?? workspaceRoot);
		const found = await harness.conversation(conversationId, context);
		if (found === undefined) throw new Error(`conversation ${conversationId} of ${key} is missing`);
		return found;
	}

	async function submit(message: InboundMessage, context: Context, whenBusy?: "followUp" | "steer"): Promise<Submission> {
		const requestId = `${message.channel}:${message.messageId}`;
		return withThreadAdmission(harness, `${message.channel}:${message.threadKey}`, () => conversation(message.channel, message.threadKey, context), context, async (target, binding) => {
			// Deduplicate across /new: a redelivered message that an archived predecessor already admitted is not run again.
			if (binding.lineage.length > 0) {
				const prior = await harness.commit(async (tx) => {
					for (const id of binding.lineage) {
						const found = await tx.submissionByRequest(id, requestId);
						if (found) return found.id;
					}
					return undefined;
				}, context);
				const existing = prior === undefined ? undefined : await harness.submission(prior, context);
				if (existing) return existing;
			}
			// A redelivered message is not admitted again, so it gets no note either. A withdrawn input (aborted before it was
			// placed, ADR 0057) never reached the model: its redelivery is a new admission under a derived request id.
			let id = requestId;
			let existing = await harness.commit((tx) => tx.submissionByRequest(target.id, id), context);
			for (let n = 2; existing && existing.type === "input" && existing.status === "unanswered" && existing.entry === undefined && existing.reason === "aborted" && n <= REDELIVERY_LIMIT + 1; n++) {
				id = `${requestId}#${n}`;
				existing = await harness.commit((tx) => tx.submissionByRequest(target.id, id), context);
			}
			if (!existing) {
				message = await materializeFiles(message, workspaceRoot);
				await memoryRecall.recall(target, message.text, context);
			}
			return target.submit(
				{ type: "input", content: formatInputContent(message), requestId: id, ...(whenBusy ? { whenBusy } : {}) },
				context,
			);
		});
	}

	async function prepareChoice(message: InboundMessage, context: Context): Promise<PreparedChoice> {
		if (!message.choice) return { ok: true, message };
		const target = await conversation(message.channel, message.threadKey, context);
		return validateChoice(harness, target.id, message, Date.now(), context);
	}
	let closeTask: Promise<void> | undefined;
	return {
		harness,
		scheduler,
		models: options.models,
		skills,
		skillEvolution,
		skillPublication,
		...(observationSession ? { skillObservations: observationSession } : {}),
		work,
		research,
		curation,
		skillReview: review,
		index,
		memoryCurator,
		memoryRetro,
		conversation,
		submit,
		prepareChoice,
		attachChannel(channel) {
			const deliver = channel.deliverHost, holds = channel.holdsAnswer;
			if (!deliver) return () => undefined;
			const sink: HostSink = {
				deliver: (threadKey, reply, id) => deliver.call(channel, threadKey, reply, id),
				// A channel that cannot tell is trusted with the reply it accepted.
				holds: (threadKey, answer) => holds ? holds.call(channel, threadKey, answer) : true,
			};
			hostSinks.set(channel.name, sink);
			return () => { if (hostSinks.get(channel.name) === sink) hostSinks.delete(channel.name); };
		},
		async handle(message, context, progress, options = {}) {
			const since = Date.now();
			const prepared = await prepareChoice(message, context);
			if (!prepared.ok) return { status: "answered", text: prepared.notice };
			let submission: Submission;
			try { submission = await submit(prepared.message, context, options.whenBusy); }
			catch (error) {
				if (error instanceof AttachmentStorageError) return {status:"answered",text:"⚠️ Attachment storage unavailable. Please retry later."};
				throw error;
			}
			const record = await submission.status(context).catch(() => undefined);
			const stopProgress = progress && record ? await watchProgress(harness, record.conversationId, progress, context, record.id) : undefined;
			// A steer whose request is abandoned while still queued is withdrawn (bot context: the request context is aborted).
			const withdraw = options.whenBusy === "steer" && record ? () => void harness.abortSubmission(record.id, botContext, record.conversationId).catch(() => undefined) : undefined;
			if (withdraw) context.abortSignal?.addEventListener("abort", withdraw, { once: true });
			let settled: Awaited<ReturnType<typeof submission.wait>>;
			try {
				settled = await submission.wait(context);
			} finally {
				if (withdraw) context.abortSignal?.removeEventListener("abort", withdraw);
				await stopProgress?.();
			}
			if (settled.type !== "input" || settled.status !== "done") {
				return { status: "unanswered", reason: settled.status === "unanswered" ? settled.reason : settled.status };
			}
			const answer = await harness.commit((tx) => tx.entry(settled.answer), context);
			const projected = await work.projectSubmission(settled.conversationId, String(submission.id), answerText(answer?.model), context);
			// ADR 0096: woken answers this thread has not been handed yet go out with this reply, before it, so a woken
			// answer never arrives after the reply to a newer message. The same answer entry (a steer joined the woken
			// turn) is this reply itself.
			const earlier = !hostChannels.has(message.channel) ? [] : await harness.commit(async (tx) => {
				const doc = await tx.doc(WakeDoc, settled.conversationId);
				// Plain copies: transaction objects are unusable once it settles.
				const taken: { id: number; answer?: number; asks: string[] }[] = [];
				for (const item of doc.deliveries ?? []) {
					if (item.claimed || item.mergedInto !== undefined) continue;
					const record = await tx.submissionByRequest(settled.conversationId, item.requestId);
					if (!record || record.type !== "input" || (record.status !== "done" && record.status !== "unanswered")) continue;
					// Kept until the thread is seen to hold this reply; the watcher hands it over itself if it never does.
					item.mergedInto = Number(settled.answer);
					item.mergedAt = Date.now();
					taken.push({ id: Number(record.id), ...(record.status === "done" ? { answer: Number(record.answer) } : {}), asks: [...item.asks] });
				}
				return taken;
			}, context);
			const before: string[] = [];
			for (const item of earlier) {
				if (item.answer === undefined || item.answer === Number(settled.answer)) continue;
				const woken = await harness.commit(async (tx) => answerText((await tx.entry(item.answer as never))?.model), context);
				before.push((await work.projectSubmission(settled.conversationId, String(item.id), woken, context)).text);
			}
			const asks = await humanAskPrompts(harness, settled.conversationId, since, context, earlier.flatMap((item) => item.asks));
			return {
				status: "answered",
				...(asks.length ? { asks } : {}),
				text: [...before, projected.text].filter((part) => part.trim()).join("\n\n"),
				answer: Number(settled.answer),
				...(projected.workflow.status === "informational" ? {} : { workflow: projected.workflow }),
			};
		},
		close(context) {
			closed = true;
			return closeTask ??= Promise.resolve().then(async () => {
				const errors: unknown[] = [];
				for (const close of [
					() => scheduler.close(),
					() => memoryCurator.stop(),
					() => memoryRetro.stop(),
					() => curation.stop(),
					() => review?.stop(),
					() => harness.close(context),
					() => observationSession?.close(context),
					() => lsp.close(),
					() => index.close(),
					() => temporaryEvidence ? rm(evidenceDirectory, { recursive: true, force: true }) : undefined,
				]) {
					try { await close(); } catch (error) { errors.push(error); }
				}
				// Bun on Windows defers node:sqlite StatementSync native finalization to GC
				// even after DatabaseSync.close() and the adapter clears its statement cache.
				// Release those closed handles before callers remove their owned database directory.
				if (process.platform === "win32") Bun.gc(true);
				if (errors.length) throw new AggregateError(errors, "Bot cleanup failed");
			});
		},
	};
}

export function answerText(messages: readonly { role: string; content: unknown }[] | undefined): string {
	const parts: string[] = [];
	for (const message of messages ?? []) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content as { type: string; text?: string }[]) {
			if (block.type === "text" && block.text) parts.push(block.text);
		}
	}
	return parts.join("\n");
}
