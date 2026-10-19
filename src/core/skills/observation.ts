import type { Context, JsonValue } from "@earendil-works/chord";
import {
	AssistantEntry, ToolResultEntry, ToolTask, defineDoc, defineDocFamily,
	type ConversationId, type Cursor, type EntryId, type Session, type TaskRecord, type Tx,
} from "@earendil-works/pi-durable";
import { CapabilityTask, CellDoc } from "../codemode/calls.ts";

export type SkillObservationKind = "load_attempt" | "load_succeeded" | "load_failed" | "companion_read" | "catalog_rendered";
export type SkillObservationSource = "direct" | "codemode";
export type SkillObservation = {
	readonly id: string;
	readonly invocationId: string;
	readonly taskId: number;
	readonly conversationId: number;
	readonly source: SkillObservationSource;
	readonly kind: SkillObservationKind;
	readonly name: string | null;
	readonly version: string | null;
	readonly path: string | null;
	/** A returned tool result is not proof of delivery to the model. */
	readonly outcome: "attempt" | "succeeded" | "failed";
};
type SourceState = {
	watermark: number;
	cursor: Cursor | null;
	attempted: number | null;
	collected: number;
	dropped: number;
	/** Terminal invocations whose classification or outcome cannot be reconstructed. */
	unknown: number;
};
type ObservationState = {
	observations: SkillObservation[];
	bytes: number;
	maxObservations: number | null;
	maxBytes: number | null;
};
/** One globally bounded event store in the separate observation Session. */
export const SkillObservationDoc = defineDoc<ObservationState>({
	kind: "dinobot.skill-observations", version: 1, scope: "session",
	initial: () => ({ observations: [], bytes: 0, maxObservations: null, maxBytes: null }),
});
export const SkillObservationSourceDoc = defineDocFamily<SourceState, null>({
	kind: "dinobot.skill-observation-source", version: 1, scope: "session", family: true,
	initial: () => ({ watermark: 0, cursor: null, attempted: null, collected: 0, dropped: 0, unknown: 0 }),
});
export type SkillObservationLimits = {
	readonly maxObservations: number;
	readonly maxBytes: number;
	readonly pageSize: number;
};
export type SkillObservationProjectorOptions = {
	/** Main Harness: table reads and snapshots only, never observation writes. */
	readonly source: Session;
	/** Host-owned separate Session AND storage backend, not another main DB writer. */
	readonly observations: Session;
	readonly limits: SkillObservationLimits;
};
export type SkillObservationCoverage = {
	readonly watermark: number;
	readonly collected: number;
	readonly dropped: number;
	readonly unknown: number;
	readonly pendingInvocation: number | null;
	readonly caughtUp: boolean;
};
export type SkillObservationProjection = {
	readonly ok: true;
	readonly sources: Readonly<Record<SkillObservationSource, SkillObservationCoverage>>;
	/** No durable catalog-render marker exists in the current producer contract. */
	readonly catalogRendered: "unknown";
} | {
	readonly ok: false;
	/** Report to the host's operational diagnostics, never replace the main result. */
	readonly error: string;
};
type RecordTask = TaskRecord<JsonValue, JsonValue, JsonValue>;
type Invocation = { name: string; args: unknown; result: unknown };
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function parse(value: unknown): unknown {
	if (typeof value !== "string") return undefined;
	try { return JSON.parse(value); }
	catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}
function field(value: unknown, name: string): string | null {
	if (!object(value)) return null;
	const result = value[name];
	// Bound metadata even for invalid arguments. Never retain bodies or companion contents.
	return typeof result === "string" && result.length <= 512 ? result : null;
}
function payload(result: unknown): unknown {
	if (!object(result) || !Array.isArray(result.content)) return undefined;
	const texts = result.content.filter((block: unknown) => object(block) && block.type === "text");
	if (texts.length !== 1) return undefined;
	const block: unknown = texts[0];
	return object(block) ? parse(block.text) : undefined;
}
async function invocation(tx: Tx, task: RecordTask, source: SkillObservationSource): Promise<Invocation | undefined> {
	if (!object(task.input)) return undefined;
	if (source === "codemode") {
		const input = task.input;
		if (typeof input.name !== "string" || typeof input.parent !== "number" || typeof input.ordinal !== "number") return undefined;
		return { name: input.name, args: parse(input.args), result: undefined };
	}
	const { assistant, callId } = task.input;
	if (typeof assistant !== "number" || typeof callId !== "string") return undefined;
	// Durable task JSON retains numeric IDs but erases their compile-time brand.
	const entry = await tx.entry(AssistantEntry, assistant as EntryId);
	const message = entry?.model?.[0];
	const call = message?.role === "assistant"
		? message.content.find((block) => block.type === "toolCall" && block.id === callId)
		: undefined;
	if (!call || call.type !== "toolCall") return undefined;
	let result: unknown;
	if (task.state.status === "terminal" && object(task.state.outcome.result)) {
		const entryId = task.state.outcome.result.entryId;
		if (typeof entryId === "number") {
			const receipt = await tx.entry(ToolResultEntry, entryId as EntryId);
			result = receipt?.model?.find((message) => message.role === "toolResult" && message.toolCallId === callId && message.toolName === call.name);
		}
	}
	return { name: call.name, args: call.arguments, result };
}
function outcome(call: Invocation): "succeeded" | "failed" | "unknown" {
	if (!object(call.result)) return "unknown";
	if (call.result.isError === true) return "failed";
	const value = payload(call.result);
	if (call.name === "skills_load") {
		return object(value) && field(value, "name") !== null && field(value, "version") !== null && typeof value.body === "string"
			? "succeeded" : "unknown";
	}
	return object(value) && field(value, "name") !== null && field(value, "version") !== null && field(value, "path") !== null && typeof value.content === "string"
		? "succeeded" : "unknown";
}
function append(store: ObservationState, state: SourceState, observation: SkillObservation): void {
	const bytes = Buffer.byteLength(JSON.stringify(observation));
	if (store.observations.length >= (store.maxObservations ?? 0) || store.bytes + bytes > (store.maxBytes ?? 0)) {
		state.dropped++;
		return;
	}
	store.observations.push(observation);
	store.bytes += bytes;
	state.collected++;
}
function observe(
	store: ObservationState, state: SourceState,
	input: { task: RecordTask; source: SkillObservationSource; call: Invocation; kind: SkillObservationKind; outcome: SkillObservation["outcome"] },
): void {
	const { task, source, call, kind, outcome } = input;
	const returned = outcome === "succeeded" ? payload(call.result) : undefined;
	const invocationId = `${task.conversationId}:${source}:${task.id}`;
	append(store, state, {
		id: `${invocationId}:${kind}`, invocationId, taskId: task.id, conversationId: task.conversationId,
		source, kind, outcome,
		name: field(returned, "name") ?? field(call.args, "name"),
		version: field(returned, "version") ?? field(call.args, "version"),
		path: call.name === "skills_read_file" ? field(returned, "path") ?? field(call.args, "path") : null,
	});
}

/**
 * Host-owned catch-up, explicitly outside the request/answer path. Call after a
 * completed run, or from the host's durable background task, and again at startup.
 * There is no detached promise, main DB writer, hook, model call, or research IO.
 * The host opens a separate observation Session/backend using createSession.
 * A failed storage commit poisons that Session in pi-durable: return the failure,
 * reopen ONLY the observation Session, and resume from its committed watermark.
 *
 * Each call scans at most pageSize records per source. Cursor, watermark, coverage
 * and observations commit together. A live lower-ID task blocks that source:
 * advancing past it would permanently lose its eventual result on restart.
 * Bounds apply across all conversations; admission drops new events without evicting old
 * evidence. Limits are fixed on first projection, including across restart.
 */
export class SkillObservationProjector {
	constructor(private readonly options: SkillObservationProjectorOptions) {
		const { source, observations, limits } = options;
		if (source === observations) throw new RangeError("Observation Session must be separate from the main Harness");
		for (const [name, value] of Object.entries(limits)) {
			if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
		}
		if (limits.pageSize > 256 || limits.maxObservations > 4096 || limits.maxBytes > 4 * 1024 * 1024)
			throw new RangeError("Observation limits exceed bounded projector capacity");
	}
	async catchUp(conversationId: ConversationId, context: Context): Promise<SkillObservationProjection> {
		// Fail-open boundary: callers receive an independent operational result.
		try {
			return await this.options.observations.commit(async (tx) => {
				const store = await tx.doc(SkillObservationDoc);
				if (store.maxObservations === null) {
					store.maxObservations = this.options.limits.maxObservations;
					store.maxBytes = this.options.limits.maxBytes;
				}
				if (store.maxObservations !== this.options.limits.maxObservations || store.maxBytes !== this.options.limits.maxBytes)
					throw new RangeError("Observation storage limits differ from persisted policy");
				const sources = {
					direct: await this.project(tx, store, { conversationId, source: "direct", context }),
					codemode: await this.project(tx, store, { conversationId, source: "codemode", context }),
				};
				return { ok: true, sources, catalogRendered: "unknown" } satisfies SkillObservationProjection;
			}, context);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}
	private async project(
		tx: Tx, store: ObservationState,
		input: { conversationId: ConversationId; source: SkillObservationSource; context: Context },
	): Promise<SkillObservationCoverage> {
		const { conversationId, source, context } = input;
		const state = await tx.doc(SkillObservationSourceDoc, `${conversationId}:${source}`, null);
		// Source commit performs ONLY table reads. No source documents are created
		// or modified, including when a CellDoc receipt is missing.
		const page = await this.options.source.commit(async (read) => {
			const tasks = await read.scanTasks({
				conversationId, kind: source === "direct" ? ToolTask.definition.name : CapabilityTask.definition.name,
			}, this.options.limits.pageSize, state.cursor ?? undefined);
			const items = [];
			for (const task of tasks.items) {
				if (task.id > state.watermark) items.push({ task, call: await invocation(read, task, source) });
			}
			return { items, next: tasks.next };
		}, context);
		let blocked = false;
		let pendingInvocation: number | null = null;
		for (const { task, call } of page.items) {
			if (source === "codemode" && call && object(task.input) && typeof task.input.parent === "number") {
				const cell = await this.options.source.snapshot(CellDoc, task.conversationId, String(task.input.parent), context);
				const receipt = cell?.calls.find((item) => item.id === task.id && item.ordinal === (object(task.input) ? task.input.ordinal : undefined));
				call.result = parse(receipt?.result);
			}
			const relevant = call?.name === "skills_load" || call?.name === "skills_read_file";
			if (call?.name === "skills_load" && state.attempted !== task.id) {
				observe(store, state, { task, source, call, kind: "load_attempt", outcome: "attempt" });
				state.attempted = task.id;
			}
			if (task.state.status !== "terminal") {
				blocked = true;
				pendingInvocation = task.id;
				break;
			}
			if (!call) state.unknown++;
			else if (relevant) {
				const result = outcome(call);
				if (result === "unknown") state.unknown++;
				else observe(store, state, {
					task, source, call, outcome: result,
					kind: call.name === "skills_read_file" ? "companion_read" : result === "succeeded" ? "load_succeeded" : "load_failed",
				});
			}
			state.watermark = task.id;
			state.attempted = null;
		}
		// Keep the previous cursor on the last page. Re-scanning its bounded tail
		// is safe via watermark, without manufacturing a backend-owned cursor.
		if (!blocked && page.next) state.cursor = page.next;
		return {
			watermark: state.watermark, collected: state.collected, dropped: state.dropped,
			unknown: state.unknown, pendingInvocation,
			caughtUp: !blocked && !page.next,
		};
	}
}
