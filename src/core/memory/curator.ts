import type { Context } from "@earendil-works/chord";
import { type AssistantMessage, type Message, Type } from "@earendil-works/pi-ai";
import {
	type Conversation, type ConversationId, defineTask, type EntryId, type EntryRecord, type Harness, type ModelRef, type NextTaskState,
	type TaskRuntime, UserEntry,
} from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { listThreads } from "../threads.ts";
import { MEMORY_NOTE_KIND } from "../ui-contract.ts";
import type { MemoryConfig } from "./config.ts";
import { projectOf } from "./project.ts";
import { type MemoryEntry, MemoryDoc, replaceAuto } from "./store.ts";
import { ActivationDoc, adopt, claim, commitWindow, CuratorDoc, type CuratorState, failAttempt, readRange, startExtracting, type WindowRecord } from "./window.ts";

/**
 * Automatic project memory: a conversation-owned background task per claimed window.
 *
 * Every finished user input of a channel/TUI thread re-derives the user turn count t from durable history. When
 * t - cursor >= N, one commit writes the claim and creates the curator task. The task reads the window from the full
 * durable history (scanEntries, never the compacted context), asks the configured model for JSON memories, and settles the
 * window in one commit: project memories (store.ts `replaceAuto`) + cursor + receipt, or a retry/skip after a model failure.
 * A memory may name known automatic memories it supersedes (a contradiction or update) or merges (when the project's
 * automatic memory is near its cap); those are removed and forgotten in the same commit. Memories a person wrote are
 * shown to the model as protected and are never superseded.
 * Effects are fenced by the window token (window.ts I1), so a crashed or stale attempt never writes twice; the model call
 * itself may run more than once after a crash, and the content-addressed keys keep the effect idempotent.
 * The user's turn never waits on any of this.
 *
 * Adoption: the first start of the curator on a store records its activation time. A conversation whose history began
 * before that time starts its cursor at its current turn count when the curator first scans it, so enabling the loop on
 * an existing store does not replay every past turn. The rule depends only on durable data, never on which trigger
 * (startup pass or a finished input) happens to scan the conversation first.
 */
export const CURATOR_TASK = "dinobot.memory.curator";
/** Appears in every curator request, so logs and tests can tell curator calls from main-model calls. */
export const CURATOR_MARKER = "[dinobot-memory-curator]";
const TAG = "[memory.curator]";
const MAX_MESSAGE_CHARS = 2_000;
const MAX_WINDOW_CHARS = 60_000;
const MAX_ITEMS = 8;
const MAX_ITEM_CHARS = 400;
const KNOWN_LIMIT = 60;
const KNOWN_CHARS = 200;
/** Near the cap every project memory is shown (shorter), so the model can merge old ones too. */
const KNOWN_FULL_LIMIT = 400;
const KNOWN_FULL_CHARS = 140;
const MAX_REPLACES = 10;

export const CURATOR_SYSTEM_PROMPT = [
	`${CURATOR_MARKER} You curate durable project memory for a team coding agent.`,
	"Read the conversation excerpt and extract facts about the project that stay true beyond this conversation: conventions, decisions, architecture, commands, paths, preferences of the people working on it, and recurring pitfalls.",
	"Skip small talk, one-off task progress, anything already obsolete inside the excerpt, secrets and credentials, and anything already listed under Known memories.",
	"Write each memory as one short self-contained third-person reference statement in the language of the conversation.",
	"Known memories are listed as [key] (date) text. When a new fact contradicts or updates a known memory, return the new fact with replaces set to the keys it supersedes; the old ones are deleted. Never put a key marked (written by a person) in replaces: if a new fact contradicts one of those, leave the fact out.",
	"When the capacity line says automatic memory is near or at its limit, also merge known automatic memories that overlap: return one combined memory with replaces set to all the keys it merges. Merge only memories that say the same kind of thing; do not drop information that is still true.",
	`Return at most ${MAX_ITEMS} memories. Reply with JSON only: {"memories":[{"text":"...","replaces":["auto/..."]}]} (replaces is optional). Reply {"memories":[]} when nothing qualifies.`,
].join("\n");

const CuratorOutput = Type.Object({ memories: Type.Array(Type.Object({ text: Type.String({ minLength: 1 }), replaces: Type.Optional(Type.Array(Type.String())) })) });
type CuratorOutputValue = { memories: { text: string; replaces?: string[] }[] };

export type CuratorEvent =
	| { type: "committed"; conversationId: ConversationId; project: string; window: number; added: string[]; replaced: string[] }
	| { type: "skipped"; conversationId: ConversationId; window: number; reason: string };

export type CuratorOptions = {
	readonly config: MemoryConfig["auto"];
	readonly workspaceRoot: string;
	readonly getHarness: () => Harness;
	/** Lease clock (epoch ms). Default Date.now. */
	readonly now?: () => number;
	/** Diagnostic lines. Default console.error. */
	readonly log?: (line: string) => void;
};

type CuratorInput = { token: number; project: string };
type CuratorTaskState = { phase: "extract"; token: number };
type CuratorResult = { status: "settled" | "stale" };
type Runtime = TaskRuntime<CuratorInput, CuratorTaskState, CuratorResult, object>;
type Next = NextTaskState<CuratorTaskState, CuratorResult>;
type Window = { token: number; window: number; cursorTurn: number; windowEnd: number; entries: EntryRecord[]; known: KnownMemories };
export type KnownMemories = { lines: string[]; auto: number; max: number };

function plain<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

function terminal(status: CuratorResult["status"]): Next {
	return { status: "terminal", outcome: { status: "completed", result: { status } } };
}

export function messageText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") parts.push(block.text);
		else if (block.type === "toolCall") parts.push(`[tool call ${block.name} ${JSON.stringify(block.arguments)}]`);
	}
	return parts.join("\n");
}

/** The text of a channel/TUI user turn (`<from user=...>` header), else undefined: nudges, handoffs, subagent prompts. */
export function userTurnText(entry: EntryRecord): string | undefined {
	if (!UserEntry.is(entry)) return undefined;
	const text = (entry.model ?? []).map(messageText).join("\n");
	return text.startsWith("<from user=\"") ? text : undefined;
}

/** Entries with ids in [minEntryId, maxEntryId], oldest first, read page by page outside any commit. */
export async function readEntries(conversation: Conversation, minEntryId: number, maxEntryId: number | undefined, context: Context): Promise<EntryRecord[]> {
	const items: EntryRecord[] = [];
	let cursor: Parameters<Conversation["entries"]>[2];
	do {
		const page = await conversation.entries({
			minEntryId: minEntryId as EntryId,
			...(maxEntryId === undefined ? {} : { maxEntryId: maxEntryId as EntryId }),
		}, 200, cursor, context);
		items.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return items.sort((a, b) => a.id - b.id);
}

export function renderWindow(entries: readonly EntryRecord[]): string {
	const lines: string[] = [];
	for (const entry of entries) {
		if (entry.kind === MEMORY_NOTE_KIND) continue;
		for (const message of entry.model ?? []) {
			if ((message.role as string) === "system") continue;
			const text = messageText(message).trim();
			if (text) lines.push(`${message.role}: ${text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text}`);
		}
	}
	const all = lines.join("\n\n");
	return all.length > MAX_WINDOW_CHARS ? `…${all.slice(-MAX_WINDOW_CHARS)}` : all;
}

/** Tolerates a fenced or prefixed JSON object, then validates it. */
export function parseCuratorOutput(text: string): CuratorOutputValue | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end < start) return undefined;
	try {
		const value: unknown = JSON.parse(text.slice(start, end + 1));
		return Value.Check(CuratorOutput, value) ? value as CuratorOutputValue : undefined;
	} catch {
		return undefined;
	}
}

export function classifyError(detail: string): string {
	const text = detail.toLowerCase();
	if (/\b429\b|rate.?limit|too many requests|overloaded/.test(text)) return "rate_limited";
	if (/timed? ?out|timeout|etimedout/.test(text)) return "timeout";
	if (/api key|credential|unauthori[sz]ed|\b401\b|\b403\b|not configured|no auth|login/.test(text)) return "no_credentials";
	return "provider_error";
}

export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

function day(at: number | undefined): string {
	return at === undefined ? "" : ` (${new Date(at).toISOString().slice(0, 10)})`;
}

/**
 * The project's memories the curator sees, newest first: the latest KNOWN_LIMIT normally; every one (shorter) once the
 * automatic entries come within one extraction of the cap, so old overlapping ones can be merged.
 */
export function knownMemories(entries: readonly MemoryEntry[], project: string, max: number): KnownMemories {
	const mine = entries.filter((entry) => entry.project === project).sort((a, b) => b.revision - a.revision);
	const auto = mine.filter((entry) => entry.origin === "auto").length;
	const near = auto + MAX_ITEMS > max;
	const [limit, chars] = near ? [KNOWN_FULL_LIMIT, KNOWN_FULL_CHARS] : [KNOWN_LIMIT, KNOWN_CHARS];
	const lines = mine.slice(0, limit).map((entry) => {
		const flat = entry.content.replace(/\s+/g, " ").trim();
		const text = flat.length > chars ? `${flat.slice(0, chars)}…` : flat;
		return `- [${entry.key}]${day(entry.updatedAt ?? entry.createdAt)}${entry.origin === "auto" ? "" : " (written by a person)"} ${text}`;
	});
	return { lines, auto, max };
}

export function renderKnown(known: KnownMemories): string {
	const near = known.auto + MAX_ITEMS > known.max;
	const capacity = `Capacity: ${known.auto} of at most ${known.max} automatic memories${known.auto >= known.max ? " (at the limit: new memories are only stored when they replace or merge known ones)" : near ? " (near the limit: merge overlapping ones)" : ""}.`;
	return known.lines.length ? `${capacity}\nKnown memories:\n${known.lines.join("\n")}\n\n` : `${capacity}\n\n`;
}

/** Valid items of a reply: trimmed, bounded, replaces deduplicated; superseding items first, since they free room. */
export function curatedItems(output: CuratorOutputValue | undefined): { text: string; replaces: string[] }[] {
	const items = (output?.memories ?? []).map((item) => ({
		text: item.text.trim(),
		replaces: [...new Set((item.replaces ?? []).map((key) => key.trim()).filter((key) => key.length > 0))].slice(0, MAX_REPLACES),
	})).filter((item) => item.text.length > 0 && item.text.length <= MAX_ITEM_CHARS).slice(0, MAX_ITEMS);
	return [...items.filter((item) => item.replaces.length > 0), ...items.filter((item) => item.replaces.length === 0)];
}

export function createMemoryCurator(options: CuratorOptions) {
	const { config } = options;
	const now = options.now ?? Date.now;
	const log = options.log ?? ((line: string) => console.error(line));
	const listeners = new Set<(event: CuratorEvent) => void>();
	const chains = new Map<ConversationId, Promise<void>>();
	let closed = false;
	let epoch = Number.POSITIVE_INFINITY;

	function publish(event: CuratorEvent): void {
		for (const listener of listeners) {
			try { listener(event); } catch (error) { log(`${TAG} listener failed: ${error instanceof Error ? error.message : String(error)}`); }
		}
	}

	/**
	 * claimed -> extracting for our token; a lease that expired while we were down is re-claimed under a new token.
	 * The commit only moves the state; the window's entries are read afterwards, page by page outside any commit
	 * (entries are immutable once written), so a long window never holds the session's commit line.
	 */
	async function begin(runtime: Runtime, project: string, token: number, context: Context): Promise<Window | undefined> {
		let started: { record: WindowRecord; userEntries: number[] } | undefined;
		await runtime.commit(async (tx) => {
			const draft = await tx.doc(CuratorDoc, runtime.conversationId);
			const state = plain(draft) as CuratorState;
			let record = state.window;
			if (record.token !== token || (record.state !== "claimed" && record.state !== "extracting")) return terminal("stale");
			const at = now();
			let active = token;
			if (record.leaseUntil !== null && at > record.leaseUntil) {
				const reclaimed = claim(record, { userTurn: state.userEntries.length, everyTurns: config.everyTurns, now: at, leaseMs: config.leaseMs });
				if (!reclaimed.ok) return terminal("stale");
				record = reclaimed.record;
				active = reclaimed.token;
			}
			if (record.state === "claimed") {
				const moved = startExtracting(record, { token: active, now: at });
				if (!moved.ok) return terminal("stale");
				record = moved.record;
			}
			draft.window = record;
			started = { record, userEntries: state.userEntries };
			return active === token ? undefined : { status: "running", checkpoint: { phase: "extract", token: active } } satisfies Next;
		}, context);
		if (started === undefined) return undefined;
		const { record, userEntries } = started;
		const conversation = await options.getHarness().conversation(runtime.conversationId, context);
		const range = readRange(record.cursorTurn, record.windowEnd, 1, record.floorTurn);
		const first = userEntries[range.fromExclusive];
		const after = userEntries[range.toInclusive];
		const entries = conversation === undefined || first === undefined ? [] : await readEntries(conversation, first, after === undefined ? undefined : after - 1, context);
		const memory = await options.getHarness().snapshot(MemoryDoc, context);
		const known = knownMemories(memory?.entries ?? [], project, config.maxPerProject);
		return { token: record.token, window: record.window, cursorTurn: record.cursorTurn, windowEnd: record.windowEnd, entries, known };
	}

	async function call(runtime: Runtime, ref: ModelRef, prompt: string): Promise<{ output?: CuratorOutputValue; error?: string }> {
		const name = `${ref.provider}/${ref.modelId}`;
		const model = runtime.models.getModel(ref.provider, ref.modelId);
		if (model === undefined) return { error: "model_unknown" };
		const timeout = AbortSignal.timeout(config.timeoutMs);
		const signal = AbortSignal.any([runtime.signal, timeout]);
		let message: AssistantMessage;
		try {
			message = await raceAbort(runtime.models.completeSimple(model, {
				systemPrompt: CURATOR_SYSTEM_PROMPT,
				messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
			}, { signal }), signal);
		} catch (error) {
			runtime.signal.throwIfAborted();
			const detail = error instanceof Error ? error.message : String(error);
			log(`${TAG} ${name} failed: ${detail}`);
			return { error: timeout.aborted ? "timeout" : classifyError(detail) };
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			runtime.signal.throwIfAborted();
			const detail = message.errorMessage ?? message.stopReason;
			log(`${TAG} ${name} failed: ${detail}`);
			return { error: timeout.aborted ? "timeout" : classifyError(detail) };
		}
		const output = parseCuratorOutput(messageText(message));
		if (output === undefined) {
			log(`${TAG} ${name} reply is not curator JSON`);
			return { error: "schema_mismatch" };
		}
		return { output };
	}

	/** The configured model, then the conversation's model once when they differ and the first call failed. */
	async function extract(runtime: Runtime, window: Window, context: Context): Promise<{ output?: CuratorOutputValue; error?: string }> {
		const prompt = `${renderKnown(window.known)}Conversation excerpt:\n${renderWindow(window.entries)}`;
		const main = (await runtime.agent(context)).model;
		const first = config.model ?? main;
		if (first === undefined) return { error: "model_unknown" };
		const result = await call(runtime, first, prompt);
		if (result.output !== undefined || main === undefined || (main.provider === first.provider && main.modelId === first.modelId)) return result;
		return call(runtime, main, prompt);
	}

	/** One commit: memories + commitWindow (or failAttempt), then the next claim when more turns are due. */
	async function settle(runtime: Runtime, project: string, window: Window, extracted: { output?: CuratorOutputValue; error?: string } | undefined, context: Context): Promise<{ next?: number; event?: CuratorEvent }> {
		const outcome: { next?: number; event?: CuratorEvent } = {};
		const items = curatedItems(extracted?.output);
		const evidence = { conversationId: runtime.conversationId as number, turn: window.windowEnd };
		await runtime.commit(async (tx) => {
			delete outcome.next;
			delete outcome.event;
			const draft = await tx.doc(CuratorDoc, runtime.conversationId);
			const state = plain(draft) as CuratorState;
			const at = now();
			let record = state.window;
			let receipts = state.receipts;
			if (extracted === undefined || extracted.output !== undefined) {
				// Fence first (commitWindow is pure): a stale or duplicate token writes no memory.
				const fence = commitWindow(state, { token: window.token, now: at, keys: [] });
				if (!fence.ok || fence.status === "duplicate") return terminal("stale");
				const memory = await tx.doc(MemoryDoc);
				const added: string[] = [];
				const replaced: string[] = [];
				const keys: string[] = [];
				for (const item of items) {
					const write = replaceAuto(memory, project, item.text, item.replaces, config.maxPerProject, { now: at, evidence });
					keys.push(write.key);
					replaced.push(...write.replaced);
					if (write.status === "added") added.push(write.key);
					if (write.status === "full") log(`${TAG} project memory of ${project} is full; extracted memory not stored`);
					if (write.status === "protected") log(`${TAG} extracted memory contradicts a memory a person wrote in ${project}; not stored`);
				}
				const committed = commitWindow(state, { token: window.token, now: at, keys });
				if (!committed.ok) return terminal("stale");
				record = committed.record;
				receipts = committed.receipts;
				outcome.event = { type: "committed", conversationId: runtime.conversationId, project, window: window.window, added, replaced };
			} else {
				const reason = extracted.error ?? "aux_failed";
				const failed = failAttempt(state, { token: window.token, now: at, maxRetries: config.maxRetries, reason });
				if (!failed.ok) return terminal("stale");
				record = failed.record;
				receipts = failed.receipts;
				if (failed.status === "skipped") outcome.event = { type: "skipped", conversationId: runtime.conversationId, window: window.window, reason };
			}
			draft.receipts = receipts;
			// A retryable failure ends the task: the window is retried on the next finished input or start, not in a tight
			// loop that would burn every attempt within one provider outage.
			const next = record.state === "idle" || !config.enabled
				? { ok: false as const }
				: claim(record, { userTurn: state.userEntries.length, everyTurns: config.everyTurns, now: at, leaseMs: config.leaseMs });
			if (next.ok) {
				draft.window = next.record;
				outcome.next = next.token;
				return { status: "running", checkpoint: { phase: "extract", token: next.token } } satisfies Next;
			}
			draft.window = record;
			return terminal("settled");
		}, context);
		return outcome;
	}

	const task = defineTask<CuratorInput, CuratorTaskState, CuratorResult>({
		name: CURATOR_TASK, version: 1,
		initial: (input) => ({ phase: "extract", token: input.token }),
		phases: {
			extract: async (record, runtime, context) => {
				// Disabled since the claim: settle nothing and call no model; the window keeps its lease and the adoption
				// epoch of the next enabled start skips it.
				if (!config.enabled) {
					await runtime.commit(() => terminal("stale"), context);
					return;
				}
				const { project } = record.input;
				let token = record.state.checkpoint.token;
				for (;;) {
					const window = await begin(runtime, project, token, context);
					if (window === undefined) return;
					const extracted = window.entries.length === 0 ? undefined : await extract(runtime, window, context);
					const settled = await settle(runtime, project, window, extracted, context);
					if (settled.event) publish(settled.event);
					if (settled.next === undefined) return;
					token = settled.next;
				}
			},
		},
		abort: async (_record, runtime, context) => {
			// The window keeps its lease; it is re-claimed once the lease expires.
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});

	/**
	 * Count new user turns of one thread conversation and claim a window when one is due. Idempotent. New entries are read
	 * page by page outside any commit; the commit applies them only if no other scan moved `scannedTo` meanwhile.
	 */
	async function noteExchange(conversationId: ConversationId, context: Context): Promise<void> {
		const harness = options.getHarness();
		if (!Object.values(await listThreads(harness, context)).includes(conversationId)) return;
		const conversation = await harness.conversation(conversationId, context);
		if (conversation === undefined) return;
		const project = await projectOf(harness, conversationId, options.workspaceRoot, context);
		if (project === undefined) return;
		const seen = (await harness.snapshot(CuratorDoc, conversationId, context))?.scannedTo ?? 0;
		const entries = await readEntries(conversation, seen + 1, undefined, context);
		await harness.commit(async (tx) => {
			const record = await tx.conversation(conversationId);
			if (record === undefined || record.owner !== undefined) return;
			const draft = await tx.doc(CuratorDoc, conversationId);
			const state = plain(draft) as CuratorState;
			if (state.scannedTo !== seen) return;
			const fresh = state.scannedTo === 0 && state.window.window === 0 && state.window.cursorTurn === 0;
			for (const entry of entries) {
				if (userTurnText(entry) !== undefined) state.userEntries.push(entry.id);
				if (entry.id > state.scannedTo) state.scannedTo = entry.id;
			}
			const at = now();
			// Adoption: turns gained before the epoch are skipped, never replayed (a fresh conversation that began before the
			// epoch, or one last scanned before it, e.g. while extraction was disabled).
			const began = entries.find((entry) => entry.model?.[0]?.timestamp !== undefined)?.model?.[0]?.timestamp;
			const stale = fresh ? began !== undefined && began < epoch : (state.scannedAt ?? 0) < epoch;
			if (stale) {
				const adopted = adopt(state, { userTurn: state.userEntries.length, now: at });
				if (adopted) {
					state.window = adopted.record;
					state.receipts = adopted.receipts;
				}
			}
			draft.userEntries = state.userEntries;
			draft.scannedTo = state.scannedTo;
			draft.scannedAt = at;
			draft.receipts = state.receipts;
			const claimed = claim(state.window, { userTurn: state.userEntries.length, everyTurns: config.everyTurns, now: at, leaseMs: config.leaseMs });
			if (!claimed.ok) {
				draft.window = state.window;
				return;
			}
			draft.window = claimed.record;
			await tx.createTask(task, { token: claimed.token, project }, { ownership: { kind: "conversation" }, conversationId, background: true });
		}, context);
	}

	function schedule(conversationId: ConversationId, context: Context): Promise<void> {
		if (closed) return Promise.resolve();
		const previous = chains.get(conversationId) ?? Promise.resolve();
		const next = previous.then(() => noteExchange(conversationId, context)).catch((error: unknown) => {
			if (!closed) log(`${TAG} turn check of conversation ${conversationId} failed: ${error instanceof Error ? error.message : String(error)}`);
		});
		chains.set(conversationId, next);
		void next.finally(() => { if (chains.get(conversationId) === next) chains.delete(conversationId); });
		return next;
	}

	return {
		task,
		noteExchange: (conversationId: ConversationId, context: Context) => schedule(conversationId, context),
		/** Watch finished inputs, then re-check every thread (missed triggers, expired leases; adoption of old ones). */
		async start(harness: Harness, context: Context): Promise<void> {
			epoch = await harness.commit(async (tx) => {
				const activation = await tx.doc(ActivationDoc);
				if (activation.epoch === null || activation.disabled) {
					activation.epoch = now();
					activation.disabled = false;
				}
				return activation.epoch;
			}, context);
			const unsubscribe = harness.subscribeCommits((publication) => {
				for (const change of publication.changes) {
					if (change.type === "submission" && change.value.type === "input" && change.value.status === "done") {
						void schedule(change.value.conversationId, context);
					}
				}
			});
			harness.subscribeClose(() => { closed = true; unsubscribe(); });
			for (const conversationId of new Set(Object.values(await listThreads(harness, context)))) void schedule(conversationId, context);
		},
		async settled(): Promise<void> {
			while (chains.size > 0) await Promise.all([...chains.values()]);
		},
		stop(): void {
			closed = true;
		},
		subscribe(listener: (event: CuratorEvent) => void): () => void {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
	};
}

export type MemoryCurator = ReturnType<typeof createMemoryCurator>;

/** Record that this run has automatic extraction off, so the next enabled start opens a new adoption epoch. */
export async function markCuratorDisabled(harness: Harness, context: Context): Promise<void> {
	await harness.commit(async (tx) => {
		const activation = await tx.doc(ActivationDoc);
		if (activation.epoch !== null && !activation.disabled) activation.disabled = true;
	}, context);
}
