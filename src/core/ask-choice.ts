import type { Context } from "@earendil-works/chord";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import type { AskPrompt, InboundMessage } from "../channels/types.ts";
import { AsksDoc } from "./ask.ts";
import { DagSeenDoc } from "./dag.ts";

export type PreparedChoice = { ok: true; message: InboundMessage } | { ok: false; notice: string };
export function choiceText(askId: string, option: string): string { return `[ask ${askId}] choice: ${option}`; }
/** Validate without admitting an input or resolving an ask. */
export async function prepareChoice(harness: Pick<Harness, "snapshot">, conversationId: ConversationId, message: InboundMessage, now: number, context: Context): Promise<PreparedChoice> {
 if (!message.choice) return { ok: true, message };
 const { askId, option } = message.choice;
 const ask = (await harness.snapshot(AsksDoc, conversationId, context))?.asks.find((a) => a.id === askId);
 if (!ask || ask.to !== "human") return { ok: false, notice: "이 선택지는 이 대화의 질문이 아니거나 더 이상 존재하지 않습니다." };
 if (ask.state !== "open") return { ok: false, notice: `이 질문은 이미 처리되었습니다 (${ask.state}${ask.answer !== undefined ? `: ${ask.answer}` : ""}).` };
 if (ask.deadlineAt <= now) return { ok: false, notice: `이 질문은 마감되어 기본값(${ask.default})으로 처리됩니다.` };
 if (!ask.options || !Number.isInteger(option) || option < 0 || option >= ask.options.length) return { ok: false, notice: "알 수 없는 선택지입니다." };
 return { ok: true, message: { ...message, text: choiceText(ask.id, ask.options[option]!) } };
}
/**
 * Open human choices to show with an answer: those opened since `since`, plus `include`. ADR 0096: a DAG ask node's
 * human question is shown exactly once — with the answer of the turn whose model saw it in a dag_step result, or else
 * with the answer of the wake it causes (`include`) — so one opened by the driver during another turn waits for its wake.
 */
export async function humanAskPrompts(harness: Pick<Harness, "snapshot">, conversationId: ConversationId, since: number, context: Context, include: readonly string[] = []): Promise<AskPrompt[]> {
 const seen = new Set((await harness.snapshot(DagSeenDoc, conversationId, context))?.asks ?? []);
 return ((await harness.snapshot(AsksDoc, conversationId, context))?.asks ?? [])
  .filter((a) => a.to === "human" && a.state === "open" && (include.includes(a.id) || (a.createdAt >= since && (a.node === undefined || seen.has(a.id)))) && (a.options?.length ?? 0) >= 2)
  .sort((a, b) => a.createdAt - b.createdAt).slice(0, 3)
  .map((a) => ({ id: a.id, question: a.question, options: [...a.options!], default: a.default, deadlineAt: a.deadlineAt }));
}
