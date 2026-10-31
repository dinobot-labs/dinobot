import type { Context } from "@earendil-works/chord";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AgentDoc, configure, defineDoc, InboxDoc, LiveDoc, ProviderDoc, type Conversation, type ConversationId, type DocumentReader, type Harness, type ModelRef, type Tx } from "@earendil-works/pi-durable";
import { LinkDoc } from "./ask.ts";
import { ClaimsDoc, release } from "./claims.ts";
import { FastDoc, FastPreference, fastState, type FastState } from "./fast.ts";
import { hasPendingQueueTransferIn, withConversationAdmission } from "./queue.ts";
import { reasoningState, type ReasoningState } from "./reasoning.ts";

/** Session-wide index from channel thread keys to durable conversations. */
const ThreadIndex = defineDoc<{ threads: Record<string, number> }>({
	kind: "dinobot.threads",
	version: 1,
	scope: "session",
	initial: () => ({ threads: {} }),
});

/**
 * History of `/new` rotations. A rotation moves a thread's conversation to a fresh archive key
 * `<key>#<n>` in {@link ThreadIndex} and binds the thread key to a new conversation:
 * - `archived`: archive key -> origin. An archive key is read-only history and never admits input.
 * - `lineage`: thread key -> archived conversation IDs, oldest first, for request deduplication.
 * - `requests`: rotation request -> archive key, so a redelivered `/new` never rotates twice.
 */
type ArchiveRecord = { key: string; conversationId: number; requestId: string; at: number };
const ThreadArchive = defineDoc<{
	archived: Record<string, ArchiveRecord>;
	lineage: Record<string, number[]>;
	requests: Record<string, string>;
}>({
	kind: "dinobot.thread-archive",
	version: 1,
	scope: "session",
	initial: () => ({ archived: {}, lineage: {}, requests: {} }),
});

/** Marks the one-time removal of empty threads as done for this store. */
const ThreadPrune = defineDoc<{ done: boolean }>({
	kind: "dinobot.thread-prune",
	version: 1,
	scope: "session",
	initial: () => ({ done: false }),
});

const ModelPreference = defineDoc<{ model: ModelRef | null }>({
	kind: "dinobot.model-preference",
	version: 1,
	scope: "session",
	initial: () => ({ model: null }),
});

const ReasoningPreference = defineDoc<{ thinkingLevel: ModelThinkingLevel | null }>({
	kind: "dinobot.reasoning-preference",
	version: 1,
	scope: "session",
	initial: () => ({ thinkingLevel: null }),
});

/** Persist an explicit selection with the thread configuration in one transaction. */
export async function selectModel(
	harness: Harness,
	models: Models,
	conversationId: ConversationId,
	model: ModelRef,
	context: Context,
	signal?: AbortSignal,
	options: { persistDefault?: boolean } = {},
): Promise<ReasoningState & FastState & { readonly previousThinkingLevel: ModelThinkingLevel }> {
	return harness.commit(async (tx) => {
		signal?.throwIfAborted();
		const agent = await tx.doc(AgentDoc, conversationId);
		const previous = reasoningState(models, agent.model, agent.thinkingLevel);
		const state = reasoningState(models, model, previous.thinkingLevel);
		if (state.supportedThinkingLevels.length === 0) throw new Error(`unknown or unsupported model ${model.provider}/${model.modelId}`);
		signal?.throwIfAborted();
		await configure(tx, conversationId, { model, thinkingLevel: state.thinkingLevel });
		if (options.persistDefault !== false) {
			const preference = await tx.doc(ModelPreference);
			preference.model = model;
			const reasoning = await tx.doc(ReasoningPreference);
			reasoning.thinkingLevel = state.thinkingLevel;
		}
		const fast = fastState(models, model, (await tx.doc(FastDoc, conversationId)).fast);
		signal?.throwIfAborted();
		return { ...state, ...fast, previousThinkingLevel: previous.thinkingLevel };
	}, context);
}

/** Resolve, validate, configure and remember a choice on the same serialized commit line. */
export async function selectReasoning(
	harness: Harness,
	models: Models,
	conversationId: ConversationId,
	choice: string,
	context: Context,
	signal?: AbortSignal,
): Promise<ReasoningState> {
	return harness.commit(async (tx) => {
		signal?.throwIfAborted();
		const agent = await tx.doc(AgentDoc, conversationId);
		const state = reasoningState(models, agent.model, agent.thinkingLevel);
		const levels = state.supportedThinkingLevels;
		if (levels.length === 0) throw new Error("Reasoning controls are unavailable for the current model.");
		const preference = await tx.doc(ReasoningPreference);
		let level: ModelThinkingLevel;
		if (choice === "cycle") {
			if (levels.length < 2) throw new Error("The current model does not support changing reasoning effort.");
			level = levels[(levels.indexOf(state.thinkingLevel) + 1) % levels.length]!;
		} else {
			const supported = levels.find((candidate) => candidate === choice);
			if (!supported) throw new Error(`Unsupported reasoning level "${choice}". Supported: ${levels.join(", ")}`);
			level = supported;
		}
		signal?.throwIfAborted();
		await configure(tx, conversationId, { thinkingLevel: level });
		preference.thinkingLevel = level;
		return { thinkingLevel: level, supportedThinkingLevels: levels };
	}, context);
}

/** Store an explicit fast choice for the thread and as the default for new threads; the next request uses it. */
export async function selectFast(
	harness: Harness,
	models: Models,
	conversationId: ConversationId,
	choice: "on" | "off" | "toggle",
	context: Context,
	signal?: AbortSignal,
): Promise<FastState> {
	return harness.commit(async (tx) => {
		signal?.throwIfAborted();
		const agent = await tx.doc(AgentDoc, conversationId);
		const stored = await tx.doc(FastDoc, conversationId);
		const state = fastState(models, agent.model, stored.fast);
		if (!state.fastSupported) {
			const name = agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "the current model";
			throw new Error(`Fast mode is unavailable for ${name}.`);
		}
		const fast = choice === "toggle" ? !state.fast : choice === "on";
		signal?.throwIfAborted();
		await tx.doc(ProviderDoc, conversationId);
		stored.fast = fast;
		(await tx.doc(FastPreference)).fast = fast;
		return { fast, fastSupported: true };
	}, context);
}

/** Canonical exact owner identity, usable atomically with acquisition/cleanup. Never follow parent links. */
export async function claimHolderTx(tx: Tx, id: ConversationId): Promise<string> {
	const threads = (await tx.doc(ThreadIndex)).threads;
	return Object.entries(threads).find(([, conversation]) => conversation === id)?.[0] ?? `conversation:${id}`;
}

/**
 * Claim holders of the conversations that delegated to `id`, nearest first, following `LinkDoc.parent`. Parent links
 * are written once when a child is created, so a snapshot read outside the claim commit is stable. Empty for a
 * top-level conversation; stops at a cycle or after 64 links. Read-only.
 */
export async function claimAncestorHolders(harness: Harness, id: ConversationId, context: Context): Promise<string[]> {
	const index = (await harness.snapshot(ThreadIndex, context))?.threads ?? {};
	const holderOf = (conversation: ConversationId) => Object.entries(index).find(([, bound]) => bound === conversation)?.[0] ?? `conversation:${conversation}`;
	const holders: string[] = [];
	const seen = new Set<ConversationId>([id]);
	for (let current = id; ;) {
		const parent = (await harness.snapshot(LinkDoc, current, context))?.parent;
		if (parent === undefined || seen.has(parent) || seen.size > 64) return holders;
		seen.add(parent);
		holders.push(holderOf(parent));
		current = parent;
	}
}

/**
 * ADR 0096: the live channel thread a conversation answers in: its `channel:threadKey` binding, unless that key is
 * archived history (after /new the thread belongs to a newer conversation). Undefined for unbound (subagent)
 * conversations. Read-only.
 */
export async function threadOfConversation(
	reader: Pick<DocumentReader, "snapshot">,
	conversationId: ConversationId,
	context: Context,
): Promise<{ channel: string; threadKey: string } | undefined> {
	const [index, archive] = await Promise.all([reader.snapshot(ThreadIndex, context), reader.snapshot(ThreadArchive, context)]);
	for (const [key, bound] of Object.entries(index?.threads ?? {})) {
		if (bound !== conversationId || archive?.archived[key] !== undefined) continue;
		const colon = key.indexOf(":");
		if (colon > 0) return { channel: key.slice(0, colon), threadKey: key.slice(colon + 1) };
	}
	return undefined;
}

/** ADR 0096: whether the conversation is archived history (its thread moved to a newer conversation by /new). Read-only. */
export async function conversationArchived(reader: Pick<DocumentReader, "snapshot">, conversationId: ConversationId, context: Context): Promise<boolean> {
	const [index, archive] = await Promise.all([reader.snapshot(ThreadIndex, context), reader.snapshot(ThreadArchive, context)]);
	let archived = false;
	for (const [key, bound] of Object.entries(index?.threads ?? {})) {
		if (bound !== conversationId) continue;
		if (archive?.archived[key] === undefined) return false;
		archived = true;
	}
	return archived;
}

/**
 * The top-level conversation of `conversationId`: subagent conversations follow their `LinkDoc.parent` chain. Undefined
 * when the chain is cyclic or deeper than 64 links. Does not check that the conversation exists. Read-only.
 */
export async function rootConversation(
	reader: Pick<DocumentReader, "snapshot">,
	conversationId: ConversationId,
	context: Context,
): Promise<ConversationId | undefined> {
	let root = conversationId;
	const seen = new Set<ConversationId>([root]);
	for (;;) {
		const parent = (await reader.snapshot(LinkDoc, root, context))?.parent;
		if (parent === undefined) return root;
		if (seen.has(parent) || seen.size > 64) return undefined; // `seen` holds the start plus the parents so far
		seen.add(parent);
		root = parent;
	}
}

/**
 * ADR 0106: the live `channel:threadKey` a top-level conversation answers in: its own binding, or, when `/new` archived
 * it (`<key>#<n>`), the key it was archived from, which now names a newer conversation. Undefined for a conversation
 * bound to no thread key. Read-only.
 */
export async function liveThreadKey(
	reader: Pick<DocumentReader, "snapshot">,
	conversationId: ConversationId,
	context: Context,
): Promise<string | undefined> {
	const [index, archive] = await Promise.all([reader.snapshot(ThreadIndex, context), reader.snapshot(ThreadArchive, context)]);
	let origin: string | undefined;
	for (const [key, bound] of Object.entries(index?.threads ?? {})) {
		if (bound !== conversationId) continue;
		const archived = archive?.archived[key];
		if (archived === undefined) return key;
		origin ??= archived.key;
	}
	return origin !== undefined && index?.threads[origin] !== undefined ? origin : undefined;
}

/** Every known `channel:threadKey` with its conversation. Read-only. */
export async function listThreads(harness: Harness, context: Context): Promise<Record<string, ConversationId>> {
	const index = await harness.snapshot(ThreadIndex, context);
	return { ...(index?.threads ?? {}) } as Record<string, ConversationId>;
}

/**
 * The channel (`tui`, `telegram`, ...) of the thread a conversation belongs to. Subagent conversations follow their
 * `LinkDoc.parent` chain to the top-level conversation first. Undefined when the root is bound to no thread key,
 * the chain is cyclic or deeper than 64 links. Read-only.
 */
export async function conversationChannel(
	reader: Pick<DocumentReader, "snapshot">,
	conversationId: ConversationId,
	context: Context,
): Promise<string | undefined> {
	const root = await rootConversation(reader, conversationId, context);
	if (root === undefined) return undefined;
	const index = await reader.snapshot(ThreadIndex, context);
	for (const [key, bound] of Object.entries(index?.threads ?? {})) {
		if (bound !== root) continue;
		const colon = key.indexOf(":");
		return colon > 0 ? key.slice(0, colon) : undefined;
	}
	return undefined;
}

/** Fail closed for shared channels, malformed/archived bindings, and unbound subagents.
 * Slack admission constructs this key only after transport, app, team and sender validation. */
export async function conversationSlackPrincipal(reader: Pick<DocumentReader, "snapshot">, conversationId: ConversationId, context: Context): Promise<{appId:string;teamId:string;channelId:string;userId:string} | undefined> {
 const root = await rootConversation(reader, conversationId, context);
 if (root === undefined) return undefined;
 const thread = await threadOfConversation(reader, root, context);
 if (thread?.channel !== "slack") return undefined;
 let key: unknown; try { key = JSON.parse(thread.threadKey); } catch { return undefined; }
 if (!Array.isArray(key) || key.length !== 5 || !key.every(v => typeof v === "string")) return undefined;
 const [appId, teamId, channelId, timestamp, userId] = key as [string,string,string,string,string];
 if (!/^A[A-Z0-9]+$/.test(appId) || !/^T[A-Z0-9]+$/.test(teamId) || !/^D[A-Z0-9]+$/.test(channelId) || !/^[UW][A-Z0-9]+$/.test(userId) || !/^\d+\.\d+$/.test(timestamp)) return undefined;
 return {appId,teamId,channelId,userId};
}

/**
 * Unlink `channel:` threads whose conversation never received an entry and has no run or queued input.
 * Opening a TUI binds a thread before the first message, so abandoned openings leave such empty sessions.
 * Run only while nothing else can submit (daemon startup, before the API and channels start), and only once per
 * store: pruning on every startup would drop the cwd/model binding of an empty session a TUI is still attached to.
 * The durable conversation itself is retained, only the thread key is removed. Returns the removed keys.
 */
export async function pruneEmptyThreadsOnce(harness: Harness, channel: string, context: Context): Promise<string[]> {
	if ((await harness.snapshot(ThreadPrune, context))?.done) return [];
	return pruneEmptyThreads(harness, channel, context, true);
}

/** The unconditional removal behind {@link pruneEmptyThreadsOnce}; `mark` records the one-time run in the same commit. */
export async function pruneEmptyThreads(harness: Harness, channel: string, context: Context, mark = false): Promise<string[]> {
	const prefix = `${channel}:`;
	const empty: string[] = [];
	for (const [key, id] of Object.entries(await listThreads(harness, context))) {
		if (!key.startsWith(prefix)) continue;
		const conversation = await harness.conversation(id, context);
		if (conversation === undefined) continue;
		if ((await conversation.entries({}, 1, undefined, context)).items.length > 0) continue;
		const [live, inbox] = await Promise.all([harness.snapshot(LiveDoc, id, context), harness.snapshot(InboxDoc, id, context)]);
		if (live?.run !== undefined || (inbox?.items.length ?? 0) > 0) continue;
		empty.push(key);
	}
	return harness.commit(async (tx) => {
		if (mark) {
			const marker = await tx.doc(ThreadPrune);
			if (marker.done) return [];
			marker.done = true;
		}
		const index = await tx.doc(ThreadIndex);
		const removed = empty.filter((key) => key in index.threads);
		for (const key of removed) delete index.threads[key];
		return removed;
	}, context);
}

export type DeleteThreadResult =
	| { readonly status: "deleted"; readonly removed: readonly string[]; readonly releasedClaims: number }
	| { readonly status: "not_found" | "moved" | "busy" | "quarantined" };

/**
 * Delete a thread from the session list: unlink `key` and the `<key>#<n>` archives its `/new` rotations left, and
 * release the claims those keys hold, in one commit. Sessions, search and thread listings read only these bindings,
 * so the thread disappears from all of them; the durable conversations stay in the store (pi-durable has no delete).
 * Preconditions are re-checked inside the commit: `key` is still bound to `expected`, and no removed conversation has a
 * run, queued input or a pending send-now transfer. `busy` reports caller-observed activity such as running subagents.
 * A key whose claims are quarantined is refused: those fences wait for evidence that their native processes exited.
 * A deleted key is reusable; its next use binds a fresh conversation. Deleting an archive key removes only that archive.
 */
export async function deleteThread(
	harness: Harness,
	key: string,
	expected: ConversationId,
	context: Context,
	options: { busy?: boolean; now?: number } = {},
): Promise<DeleteThreadResult> {
	return harness.commit(async (tx) => {
		const index = await tx.doc(ThreadIndex);
		const archive = await tx.doc(ThreadArchive);
		const bound = index.threads[key];
		if (bound === undefined) return { status: "not_found" as const };
		if (bound !== expected) return { status: "moved" as const };
		const removed = [key, ...Object.keys(index.threads).filter((candidate) => candidate !== key && archive.archived[candidate]?.key === key)];
		if (options.busy) return { status: "busy" as const };
		for (const removedKey of removed) {
			const id = index.threads[removedKey] as ConversationId;
			const live = await tx.doc(LiveDoc, id);
			const inbox = await tx.doc(InboxDoc, id);
			if (live.run !== undefined || inbox.items.length > 0 || (await hasPendingQueueTransferIn(tx, id))) return { status: "busy" as const };
		}
		const claims = await tx.doc(ClaimsDoc);
		if (claims.claims.some((claim) => removed.includes(claim.holder) && claim.quarantined !== undefined)) return { status: "quarantined" as const };
		const now = options.now ?? Date.now();
		let releasedClaims = 0;
		for (const removedKey of removed) releasedClaims += release(claims, removedKey, undefined, now).length;
		for (const removedKey of removed) {
			delete index.threads[removedKey];
			delete archive.archived[removedKey];
		}
		return { status: "deleted" as const, removed, releasedClaims };
	}, context);
}

/** Current binding of a full `channel:threadKey`, whether it is archived history, and its archived predecessors. */
export type ThreadBinding = {
	readonly conversationId: ConversationId | undefined;
	readonly archived: boolean;
	readonly lineage: readonly ConversationId[];
};

export async function threadBinding(harness: Harness, key: string, context: Context): Promise<ThreadBinding> {
	const [index, archive] = await Promise.all([harness.snapshot(ThreadIndex, context), harness.snapshot(ThreadArchive, context)]);
	return {
		conversationId: index?.threads[key] as ConversationId | undefined,
		archived: archive?.archived[key] !== undefined,
		lineage: [...(archive?.lineage[key] ?? [])] as ConversationId[],
	};
}

/** Input addressed to archived history; archive keys are read-only. */
export class ArchivedThreadError extends Error {
	constructor(key: string) {
		super(`thread ${key} is archived history and accepts no input`);
		this.name = "ArchivedThreadError";
	}
}

const MOVED = Symbol("moved");
const BINDING_ATTEMPTS = 8;

/**
 * Run `action` on the conversation bound to `key`, on that conversation's admission line, after
 * re-checking that the key is still bound to it. Rotation also holds that line, so the binding seen
 * by `action` cannot change before `action` returns: every admission is ordered either wholly
 * before a rotation (and then the rotation sees it as busy) or wholly after it (into the new
 * conversation). A binding that moved in between is resolved again; each retry requires another
 * committed rotation, so the bound is reached only under a stream of `/new` requests.
 */
export async function withThreadAdmission<T>(
	harness: Harness,
	key: string,
	resolve: () => Promise<Conversation>,
	context: Context,
	action: (conversation: Conversation, binding: ThreadBinding) => Promise<T>,
): Promise<T> {
	for (let attempt = 0; attempt < BINDING_ATTEMPTS; attempt++) {
		const conversation = await resolve();
		const outcome = await withConversationAdmission(harness, conversation.id, async () => {
			const binding = await threadBinding(harness, key, context);
			if (binding.archived) throw new ArchivedThreadError(key);
			if (binding.conversationId !== conversation.id) return MOVED;
			return { value: await action(conversation, binding) };
		});
		if (outcome !== MOVED) return outcome.value;
	}
	throw new Error(`thread ${key} was rebound ${BINDING_ATTEMPTS} times during admission; try again`);
}

export type RotateResult =
	| { readonly status: "rotated"; readonly archivedKey: string; readonly conversationId: ConversationId }
	| { readonly status: "unchanged" | "busy" | "moved" | "archived" };

/**
 * Bind `key` to a fresh conversation in one commit, keeping the old one as `<key>#<n>` history.
 * Preconditions are re-checked inside the commit: the key is still bound to `expected`, which has no run,
 * no queued input and no pending send-now transfer. The new conversation inherits model, reasoning,
 * cwd and fast mode; history, todos, work and subagents stay with the archived conversation.
 * `requestId` makes the rotation idempotent: a redelivery returns the recorded result.
 * `skipIfEmpty` turns a rotation of a conversation without entries into "unchanged"; `busy` reports
 * caller-observed activity (such as running subagents) after the idempotency lookup.
 */
export async function rotateThread(
	harness: Harness,
	models: Models,
	key: string,
	expected: ConversationId,
	requestId: string,
	context: Context,
	options: { skipIfEmpty?: boolean; busy?: boolean; now?: number } = {},
): Promise<RotateResult> {
	return harness.commit(async (tx) => {
		const archive = await tx.doc(ThreadArchive);
		const index = await tx.doc(ThreadIndex);
		const request = key + "\n" + requestId;
		const recorded = archive.requests[request];
		// The thread may have moved on since; report the current binding, never rotate again.
		if (recorded !== undefined) return { status: "rotated" as const, archivedKey: recorded, conversationId: index.threads[key] as ConversationId };
		if (archive.archived[key] !== undefined) return { status: "archived" as const };
		if (index.threads[key] !== expected) return { status: "moved" as const };
		const live = await tx.doc(LiveDoc, expected);
		const inbox = await tx.doc(InboxDoc, expected);
		if (options.busy || live.run !== undefined || inbox.items.length > 0 || (await hasPendingQueueTransferIn(tx, expected))) return { status: "busy" as const };
		if (options.skipIfEmpty) return { status: "unchanged" as const };
		const agent = await tx.doc(AgentDoc, expected);
		const fast = (await tx.doc(FastDoc, expected)).fast;
		let n = 1;
		while (index.threads[`${key}#${n}`] !== undefined) n++;
		const archivedKey = `${key}#${n}`;
		const created = await createThreadConversation(tx, models, agent.model ?? (await tx.doc(ModelPreference)).model, {
			thinkingLevel: agent.thinkingLevel ?? null, cwd: agent.cwd, fast,
		});
		index.threads[archivedKey] = expected;
		index.threads[key] = created;
		archive.archived[archivedKey] = { key, conversationId: expected, requestId, at: options.now ?? Date.now() };
		// Assign a new array: a push on the value of `??=` would bypass the commit draft.
		archive.lineage[key] = [...(archive.lineage[key] ?? []), expected];
		archive.requests[request] = archivedKey;
		return { status: "rotated" as const, archivedKey, conversationId: created };
	}, context);
}

/** Create and configure an ownerless conversation; the caller binds it. */
async function createThreadConversation(
	tx: Tx,
	models: Models,
	model: ModelRef | null,
	settings: { thinkingLevel: ModelThinkingLevel | null; cwd: string | undefined; fast: boolean | null },
): Promise<ConversationId> {
	if (model === null) throw new Error("no model to configure the new conversation with");
	const state = reasoningState(models, model, settings.thinkingLevel ?? "off");
	const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
	await configure(tx, created.id, { model, thinkingLevel: state.thinkingLevel, ...(settings.cwd ? { cwd: settings.cwd } : {}) });
	await tx.doc(ProviderDoc, created.id);
	(await tx.doc(FastDoc, created.id)).fast = settings.fast;
	return created.id;
}

/**
 * Return the conversation bound to `threadKey`, creating it on first use.
 * Lookup and creation happen in one commit; the Session serializes commits, so two
 * concurrent first messages of a thread still end up in the same conversation.
 */
export async function conversationForThread(
	harness: Harness,
	models: Models,
	threadKey: string,
	model: ModelRef,
	context: Context,
	cwd?: string,
): Promise<ConversationId> {
	return harness.commit(async (tx) => {
		const index = await tx.doc(ThreadIndex);
		const existing = index.threads[threadKey];
		if (existing !== undefined) {
			const id = existing as ConversationId;
			const agent = await tx.doc(AgentDoc, id);
			const state = reasoningState(models, agent.model, agent.thinkingLevel);
			if (state.supportedThinkingLevels.length > 0 && state.thinkingLevel !== agent.thinkingLevel) {
				await configure(tx, id, { thinkingLevel: state.thinkingLevel });
			}
			await tx.doc(ProviderDoc, id);
			return id;
		}
		const preference = await tx.doc(ModelPreference);
		const reasoning = await tx.doc(ReasoningPreference);
		const created = await createThreadConversation(tx, models, preference.model ?? model, {
			thinkingLevel: reasoning.thinkingLevel, cwd, fast: (await tx.doc(FastPreference)).fast,
		});
		index.threads[threadKey] = created;
		return created;
	}, context);
}
