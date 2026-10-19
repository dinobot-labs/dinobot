import { copyJson, type Context } from "@earendil-works/chord";
import { type Conversation, type ConversationId, type Harness, type Cursor, type TaskId, type Tx, defineDoc, InboxDoc, LiveDoc, type InboxItem, type InboxState, type SubmissionId, type UserInput } from "@earendil-works/pi-durable";
import { formatInput, parseInput } from "./input.ts";
import { WorkDoc } from "./verification.ts";
import type { QueuedInput } from "./ui-contract.ts";

/**
 * Client operations on a conversation's queued input (`pi.inbox`). pi-durable owns the queue and its boundaries; these
 * only read it, withdraw one item, or withdraw every item and deliver it at once in a fresh run.
 */
type InputItem = Extract<InboxItem, { mode: "steer" | "followUp" }>;

const inputItems = (inbox: Readonly<InboxState> | null | undefined): InputItem[] =>
	(inbox?.items ?? []).filter((item): item is InputItem => item.mode !== "write");

function plainText(content: InputItem["content"]): string {
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
}

/** The inbox's input items as clients show them: ID order, writes left out, the `<from>` header split off. */
export function queuedInputs(inbox: Readonly<InboxState> | null | undefined): QueuedInput[] {
	return inputItems(inbox).map((item) => {
		const raw = plainText(item.content);
		const parsed = parseInput(raw);
		return { id: Number(item.id), mode: item.mode, text: parsed?.text ?? raw, ...(parsed ? { userId: parsed.userId } : {}) };
	});
}

export type WithdrawResult = { status: "withdrawn"; item: QueuedInput } | { status: "already_placed" | "settled" | "not_found" };

/**
 * Withdraw one queued input of this conversation and return what it said. An input a boundary already placed, a
 * settled one, a write, or another conversation's submission is reported and left alone.
 */
export async function withdrawQueued(harness: Harness, conversationId: ConversationId, id: number, context: Context): Promise<WithdrawResult> {
	const inbox = await harness.snapshot(InboxDoc, conversationId, context);
	const shown = queuedInputs(inbox).find((item) => item.id === id);
	if (shown === undefined) {
		if (inbox?.items.some((item) => Number(item.id) === id)) return { status: "not_found" };
		const record = await (await harness.submission(id as SubmissionId, context))?.status(context);
		if (record === undefined || record.conversationId !== conversationId || record.type !== "input") return { status: "not_found" };
		return { status: record.status === "placed" ? "already_placed" : record.status === "queued" ? "not_found" : "settled" };
	}
	const outcome = await harness.abortSubmission(id as SubmissionId, context, conversationId);
	if (outcome === "aborted") return { status: "withdrawn", item: shown };
	return { status: outcome };
}

/**
 * One input from several, in order. Text from a single sender keeps one `<from>` header, so every reader of the header
 * (transcript, search, asks) sees one message; mixed senders keep each header so attribution survives.
 */
function combine(contents: readonly InputItem["content"][]): UserInput {
	if (contents.every((content) => typeof content === "string")) {
		const parsed = contents.map((content) => parseInput(content));
		const [first] = parsed;
		if (first !== undefined && parsed.every((part) => part !== undefined && part.userId === first.userId && part.channel === first.channel)) {
			return formatInput({ userId: first.userId, channel: first.channel, text: parsed.map((part) => part!.text).join("\n\n") });
		}
		return contents.join("\n\n");
	}
	return contents.flatMap((content) => (typeof content === "string" ? [{ type: "text" as const, text: content }] : content)) as UserInput;
}

export type SendNowResult = { sent: number; submissionId?: number };

type Transfer = { requestId: string; items: InputItem[]; runnerId?: TaskId };
const TransferDoc = defineDoc<{ pending: Transfer | null }>({
	kind: "dinobot.queue-transfer", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ pending: null }),
});

/** The same check inside a commit, so callers can make it atomic with their own index change. */
export async function hasPendingQueueTransferIn(tx: Tx, conversationId: ConversationId): Promise<boolean> {
	return (await tx.doc(TransferDoc, conversationId)).pending != null;
}

/** Read pending durable transfers while holding the shared admission lock before configuration changes. */
export async function hasPendingQueueTransfer(harness: Harness, conversationId: ConversationId, context: Context): Promise<boolean> {
	return (await harness.snapshot(TransferDoc, conversationId, context))?.pending != null;
}

// One Harness owns a Session mutation line. Serialize the non-transactional abort/submit
// steps as well, without retaining closed harnesses or completed conversation locks.
const sends = new WeakMap<Harness, Map<ConversationId, Promise<unknown>>>();

/** Product ingress and send-now share one admission line. A late steer must not
 * enter the runner that a transfer is about to cancel. Internal Harness callers
 * bypassing Bot.submit are outside this admission boundary. */
export async function withConversationAdmission<T>(harness: Harness, id: ConversationId, action: () => Promise<T>): Promise<T> {
	let locks = sends.get(harness);
	if (!locks) sends.set(harness, locks = new Map());
	const previous = locks.get(id);
	const operation = (async () => {
		if (previous) await previous.catch(() => {});
		return action();
	})();
	locks.set(id, operation);
	try { return await operation; }
	finally { if (locks.get(id) === operation) locks.delete(id); }
}

/** Explicit user cancellation, unlike shutdown, revokes pending send-now recovery.
 * Clear the receipt durably first: even a failed/interrupted abort must not replay it.
 * Keep the whole operation on the same admission line as Bot.submit and send-now. */
export async function abortConversation(harness: Harness, conversation: Conversation, context: Context): Promise<void> {
	await withConversationAdmission(harness, conversation.id, async () => {
		await harness.commit(async tx => {
			const receipt = await tx.doc(TransferDoc, conversation.id);
			receipt.pending = null;
			const state = await tx.doc(WorkDoc, conversation.id);
			if (state.goal) { state.goal.epoch++; delete state.goal.acceptance; delete state.goal.exportAcceptance; }
		}, context);
		await conversation.abort(context);
	});
}

/**
 * Atomically move queued inputs into a durable transfer receipt before aborting the turn.
 * A later send-now retries a pending receipt (including after reopen); it does not require
 * the original inbox items to survive. This is admission idempotency, not exactly-once
 * model/tool side effects. Only the captured runner is stopped: conversation-wide
 * abort would silently withdraw inputs admitted after the transfer transaction.
 * Startup recovery retries receipts without transferring unrelated queued inputs.
 */
export async function sendQueuedNow(harness: Harness, conversation: Conversation, context: Context): Promise<SendNowResult> {
	return serializeTransfer(harness, conversation, context, false);
}

async function serializeTransfer(harness: Harness, conversation: Conversation, context: Context, recoveryOnly: boolean): Promise<SendNowResult> {
	return withConversationAdmission(harness, conversation.id, () => transferQueued(harness, conversation, context, recoveryOnly));
}

async function transferQueued(harness: Harness, conversation: Conversation, context: Context, recoveryOnly: boolean): Promise<SendNowResult> {
	const transfer = await harness.commit(async (tx) => {
		const receipt = await tx.doc(TransferDoc, conversation.id);
		if (receipt.pending) return copyJson(receipt.pending) as Transfer;
		if (recoveryOnly) return null;
		const inbox = await tx.doc(InboxDoc, conversation.id);
		const items = inputItems(inbox);
		if (items.length === 0) return null;
		const runnerId = (await tx.doc(LiveDoc, conversation.id)).run?.taskId;
		const pending: Transfer = { requestId: "queue-send:" + items.map((item) => item.id).join(","), items: copyJson(items) as InputItem[], ...(runnerId === undefined ? {} : { runnerId }) };
		receipt.pending = pending;
		// Both documents and settlements commit together: no between-withdrawals gap.
		for (const item of items) tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
		inbox.items = inbox.items.filter((item) => item.mode === "write");
		return pending;
	}, context);
	if (!transfer) return { sent: 0 };
	// Submission may have committed even if its caller never received the response.
	// In that case do not abort again: that could cancel the replacement itself.
	const existing = await harness.commit((tx) => tx.submissionByRequest(conversation.id, transfer.requestId), context);
	let submissionId = existing?.id;
	if (submissionId === undefined) {
		if (transfer.runnerId !== undefined) {
			await harness.abortTask(transfer.runnerId, context);
			await harness.waitForTask(transfer.runnerId, context);
		}
		submissionId = (await conversation.submit({
			type: "input", content: combine(transfer.items.map((item) => item.content)), requestId: transfer.requestId,
		}, context)).id;
	}
	await harness.commit(async (tx) => {
		const receipt = await tx.doc(TransferDoc, conversation.id);
		if (receipt.pending?.requestId === transfer.requestId) receipt.pending = null;
	}, context);
	return { sent: transfer.items.length, submissionId: Number(submissionId) };
}

/** Retry durable transfers on open; ordinary inboxes are not send-now requests. */
export async function recoverQueuedTransfers(harness: Harness, context: Context): Promise<void> {
	let cursor: Cursor | undefined;
	do {
		const page = await harness.commit(tx => tx.scanConversations({}, 128, cursor), context);
		for (const record of page.items) {
			if ((await harness.snapshot(TransferDoc, record.id, context))?.pending) {
				const conversation = await harness.conversation(record.id, context);
				if (conversation) await serializeTransfer(harness, conversation, context, true);
			}
		}
		cursor = page.next;
	} while (cursor);
}
