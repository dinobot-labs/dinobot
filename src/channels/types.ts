/**
 * The contract between messaging channels (Slack, Teams, HTTP, ...) and the bot core.
 * Channels translate their native events into InboundMessage and render BotReply back.
 * Nothing channel-specific crosses this boundary.
 */
import type { WorkflowStatus } from "../core/ui-contract.ts";

/** Bounded wire bytes; core persists locally and exposes metadata/path, not base64, to the model. */
export type InboundFile = { readonly name: string; readonly mimeType: string; readonly data: string };

/** One image attached to a channel message: canonical base64 bytes and their MIME type. */
export type InboundImage = { readonly mimeType: string; readonly data: string };

/** Display-only human choices (ADR 0063). */
export type AskPrompt = { readonly id: string; readonly question: string; readonly options: readonly string[]; readonly default: string; readonly deadlineAt: number };
/** Untrusted click; core validates against the clicker's conversation. */
export type AskChoice = { readonly askId: string; readonly option: number };

export type InboundMessage = {
	readonly choice?: AskChoice;
	/** Channel adapter name, e.g. "slack", "teams", "http". */
	readonly channel: string;
	/** Stable key of the native thread/conversation; one key maps to one durable conversation. */
	readonly threadKey: string;
	/** Native message id. Used as the idempotency key, so redelivered events are answered once. */
	readonly messageId: string;
	readonly userId: string;
	readonly text: string;
	/** Images attached to this message, admitted by the shared bounds of core/message-images.ts. */
	readonly images?: readonly InboundImage[];
	readonly files?: readonly InboundFile[];
};

export type BotReply =
	| {
			readonly status: "answered";
			readonly asks?: readonly AskPrompt[];
			readonly text: string;
			readonly workflow?: WorkflowStatus;
			/** Durable id of the answer entry (ADR 0057). Inputs one run answered together share it; a channel delivers each
			 * answer once by comparing it, never by comparing text. */
			readonly answer?: number;
	  }
	| { readonly status: "unanswered"; readonly reason: string };

/**
 * Channel-neutral, bounded progress of one turn while the bot works on it (ADR 0047). Channels may render it, as
 * Telegram's status message does, or ignore it. Previews are short single-line hints, never tool output.
 *
 *   tool_start/tool_end  one tool call (codemode inner calls are reported as their own tools)
 *   todos                the agent's todo list: completed / total and the item in progress
 *   phase                the model is thinking or writing the answer, with no tool running
 *   retry                the model request is being retried after an error
 *   activity             something happened that the other events do not show (rate-limited liveness)
 *   draft                snapshot of the answer text written so far (tail; ADR 0057); never a delta
 *   steer                another input joined the running turn (ADR 0057)
 *   heartbeat            transport keep-alive: the core is up and the turn is unsettled; never a sign of progress
 *
 * `preview` is the fixed safe vocabulary (ADR 0056); `detail` is the best-effort redacted argument line a channel may
 * show in its detailed mode (ADR 0057). `todos.current` is the item text; channels decide whether to show it.
 */
export type ProgressEvent =
	| { readonly type: "tool_start"; readonly id: string; readonly name: string; readonly preview?: string; readonly detail?: string; readonly at?: number }
	| { readonly type: "tool_end"; readonly id: string; readonly ok: boolean; readonly at?: number }
	| { readonly type: "todos"; readonly done: number; readonly total: number; readonly current?: string }
	| { readonly type: "phase"; readonly phase: "thinking" | "writing" }
	| { readonly type: "retry"; readonly attempt: number }
	| { readonly type: "activity" }
	| { readonly type: "draft"; readonly text: string }
	| { readonly type: "steer" }
	| { readonly type: "heartbeat" };

/** Receives a turn's progress. Must not throw or block; delivery is best effort and never affects the reply. */
export type ProgressSink = (event: ProgressEvent) => void;

/** Per-call handling options (ADR 0057). `whenBusy: "steer"` asks the core to join a running turn of the same
 * conversation instead of waiting for it; an idle conversation runs the message as its own turn. */
export type HandlerOptions = { readonly whenBusy?: "steer" };

/** Native adapters pass an optional lifetime signal and progress sink. Handlers should honor cancellation. */
export type MessageHandler = (message: InboundMessage, signal?: AbortSignal, progress?: ProgressSink, options?: HandlerOptions) => Promise<BotReply>;

/**
 * ADR 0096: outcome of handing a channel the answer of a turn its user did not start with a message (a woken
 * orchestrator). `admitted`: durably queued for delivery (or already was); `duplicate`: the same answer is already
 * delivered or queued in that thread; `unroutable`: the channel cannot address that thread; `unavailable`: not now
 * (stopped, full), try again later.
 */
export type HostDeliveryResult = "admitted" | "duplicate" | "unroutable" | "unavailable";

export interface ChannelAdapter {
	readonly name: string;
	/** Private adapter storage and sidecars, excluded from host evidence. */
	readonly storagePaths?: readonly string[];
	/** Native external channels must bypass the global privileged command middleware. */
	readonly commandPolicy?: "none";
	/** Optional host policy for advisory native menus; never substitutes for handler authorization. */
	start(handler: MessageHandler, nativeHandler?: MessageHandler, controls?: { modelControls: boolean }): Promise<void>;
	stop(): Promise<void>;
	/** Optional (ADR 0096): post `reply` to the thread `threadKey` although no message of that thread asked for it.
	 * `id` makes the delivery idempotent across retries and restarts. Never throws. */
	deliverHost?(threadKey: string, reply: Extract<BotReply, { status: "answered" }>, id: string): HostDeliveryResult;
	/** Optional (ADR 0096): whether the thread `threadKey` durably holds (queued or delivered) the reply carrying answer entry
	 * `answer`; undefined when the channel cannot tell now (stopped, unroutable). Never throws. */
	holdsAnswer?(threadKey: string, answer: number): boolean | undefined;
}
