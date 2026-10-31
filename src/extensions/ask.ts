import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineExtension, defineTool, type Harness, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { askNodeKeys, askNodeRefs, RunDoc } from "../core/dag.ts";
import { clone } from "../core/json.ts";
import {
	ASK_KINDS, AUTHORITY_DEFAULT, type AskKind, type AskRecord, AsksDoc, askId, describeAsk, expireAsks, findHumanMessage, HUMAN_DEADLINE_MAX_MS,
	HUMAN_DEADLINE_MS, HUMAN_KINDS, HUMAN_MIN_OPTIONS, HUMAN_MAX_OPTIONS, HUMAN_OPEN_CHOICE_LIMIT, isTerminal, LinkDoc, MAIN_DEADLINE_MAX_MS, MAIN_DEADLINE_MIN_MS, MAIN_DEADLINE_MS, resolveAsk,
} from "../core/ask.ts";
import type { WorkService } from "../core/verification.ts";

export const ASK_TOOL = "ask";
export const ANSWER_TOOL = "answer";

const text = (value: string, isError = false) => ({ isError, content: [{ type: "text" as const, text: value }] });

/** Wait until the record is terminal or its deadline passes; the deadline is enforced by CAS, so a restart cannot skip it. */
export async function awaitResolution(api: Pick<ToolExecutionApi, "watchDoc" | "snapshot" | "commit">, owner: ConversationId, id: string, deadlineAt: number, context: Context): Promise<AskRecord> {
	const watch = await api.watchDoc(AsksDoc, owner, context);
	if (!watch) throw new Error("Ask record store is missing");
	const settled = Promise.withResolvers<AskRecord>();
	const found = watch.value?.asks.find((ask) => ask.id === id);
	if (found && isTerminal(found)) { await watch.stop(); return clone(found); }
	let timer: ReturnType<typeof setTimeout> | undefined;
	const onAbort = () => settled.reject(context.abortSignal?.reason ?? new Error("aborted"));
	context.abortSignal?.addEventListener("abort", onAbort, { once: true });
	watch.start(async (value) => {
		const record = value?.asks.find((ask) => ask.id === id);
		if (record && isTerminal(record)) settled.resolve(clone(record));
	});
	// A resolution committed between acquisition and start is observed by this re-read.
	const current = (await api.snapshot(AsksDoc, owner, context))?.asks.find((ask) => ask.id === id);
	if (current && isTerminal(current)) settled.resolve(clone(current));
	const expire = async () => {
		try {
			const record = await api.commit(async (tx) => {
				const doc = await tx.doc(AsksDoc, owner);
				expireAsks(doc, Date.now());
				return clone(doc.asks.find((ask) => ask.id === id));
			}, context);
			if (record && isTerminal(record)) settled.resolve(record);
			else if (!record) settled.reject(new Error(`Ask ${id} disappeared`));
			else timer = setTimeout(expire, Math.max(1, record.deadlineAt - Date.now()));
		} catch (error) {
			settled.reject(error);
		}
	};
	timer = setTimeout(expire, Math.max(0, deadlineAt - Date.now()));
	try {
		return await settled.promise;
	} finally {
		if (timer) clearTimeout(timer);
		context.abortSignal?.removeEventListener("abort", onAbort);
		await watch.stop();
	}
}

export function askExtension(work: WorkService, getHarness: () => Pick<Harness, "conversation">) {
	return defineExtension({
		name: "ask",
		sections: [section("ask_protocol", async ({ conversationId, read }, context) => {
			const link = await read.snapshot(LinkDoc, conversationId, context);
			if (link?.parent) {
				return [
					"You are a node subagent under an orchestrator. Never address the human. When you need a decision, clarification, permission or an external fact you cannot obtain, call ask (tools.ask in codemode): it goes to the orchestrator only. Supply a default you will proceed with if no answer arrives before the deadline; authority asks default to deny. Identical questions share one record. Do not ask what the task text or repository already answers.",
				].join("\n");
			}
			return [
				"ask protocol: subagents ask you, not the human. task and task_output return early with any open asks from your subagents; resolve them with answer({ask_id, answer}) before waiting again, then collect with task_output. An unanswered ask resolves to its default at its deadline.",
				`You may ask the human with ask({to:"human", kind, ...}). kind acceptance (refs: requirement ids of the active work contract), authority (refs: the irreversible/external action), conflict (refs: two conflicting requirement ids) and external (refs: the inaccessible source) need validated refs. kind decision (options required) and clarification (options optional) need no refs; use them only when the request stays genuinely ambiguous after you checked the code, history and memory, never for something you can decide yourself. Human options are 2-4 short distinct choices, best first; the human sees them as buttons and may still answer in free text. At most 3 decision/clarification questions may be open at once. A human ask returns immediately: relay the question and its numbered options in your reply, then end your turn. When the human answers, call answer({ask_id, answer, quote}) where quote is a verbatim fragment of the human's message; the harness verifies that a human wrote it after the question. A human message of the form "[ask <id>] choice: <option>" is that human pressing a button: call answer({ask_id:"<id>", answer:"<option>", quote:<that whole line>}) before doing anything else. A human message starting "[ask <id>] answer: <text>" is that human's own free-text answer to that ask: call answer({ask_id:"<id>", answer:<text>, quote:<that whole line>}) the same way. Pass relays:<child ask id> to resolve a subagent's ask with the human's answer in one step.`,
			].join("\n");
		})],
		tools: [
			defineTool({
				name: ASK_TOOL,
				description: "Ask the orchestrator (from a subagent) or, from the orchestrator, the human. A subagent ask blocks the asking node only, until answered or defaulted at its deadline (minimum 60 seconds, default 15 minutes, maximum 24 hours). Human asks: acceptance/authority/conflict/external need validated refs; decision (2-4 options) and clarification (optional 2-4 options) need none. Human asks return immediately.",
				parameters: Type.Object({
					question: Type.String({ minLength: 1, maxLength: 4000 }),
					kind: Type.Union(ASK_KINDS.map((kind) => Type.Literal(kind))),
					default: Type.String({ maxLength: 2000 }),
					options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 16 })),
					refs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 16 })),
					to: Type.Optional(Type.Union([Type.Literal("main"), Type.Literal("human")])),
					deadline_ms: Type.Optional(Type.Integer({ minimum: 1000 })),
					relays: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
				}, { additionalProperties: false }),
				replay: "safe",
				execute: async ({ question, kind, default: fallback, options, refs = [], to, deadline_ms, relays }, api, context) => {
					const link = await api.snapshot(LinkDoc, api.conversationId, context);
					const effectiveDefault = kind === "authority" ? AUTHORITY_DEFAULT : fallback;
					if (link?.parent) {
						if (to === "human") return text("Subagents cannot address the human. Ask the orchestrator (omit `to`); it decides whether a human is needed.", true);
						if (relays !== undefined) return text("Only the orchestrator relays asks.", true);
						const parent = link.parent;
						const id = askId(parent, api.conversationId, kind, refs, question);
						const deadlineAt = await api.commit(async (tx) => {
							const doc = await tx.doc(AsksDoc, parent);
							const existing = doc.asks.find((ask) => ask.id === id);
							if (existing) return existing.deadlineAt;
							const now = Date.now();
							const record: AskRecord = {
								id, from: { conversationId: api.conversationId, ...(link.taskId ? { taskId: link.taskId } : {}) }, to: "main", kind, refs: [...refs].sort(),
								question, ...(options?.length ? { options } : {}), default: effectiveDefault,
								createdAt: now, deadlineAt: now + Math.max(MAIN_DEADLINE_MIN_MS, Math.min(deadline_ms ?? MAIN_DEADLINE_MS, MAIN_DEADLINE_MAX_MS)), state: "open",
							};
							doc.asks.push(record);
							return record.deadlineAt;
						}, context);
						const record = await awaitResolution(api, parent, id, deadlineAt, context);
						return {
							content: [{ type: "text", text: `${record.state}: ${record.answer ?? record.default}` }],
							details: { ask: record },
						};
					}
					if (to === "main") return text("This conversation has no orchestrator above it. Decide yourself, or ask the human with to:\"human\" for acceptance/authority/conflict/external.", true);
					if (!HUMAN_KINDS.has(kind)) return text(`kind "${kind}" is not a human-owned variable. Decide yourself; only ${[...HUMAN_KINDS].join("/")} may be asked of a human.`, true);
					const problem = await validateHumanRefs(work, api, api.conversationId, kind, refs, options, context);
					if (problem) return text(problem, true);
					// An authority ask made while a run is active belongs to that run: only that run's ask nodes may reuse it.
					const dag = kind === "authority" ? await api.snapshot(RunDoc, api.conversationId, context) : undefined;
					// The answer covers these contracts; a replan that changes one of them asks again. The run is part of the id, so
					// the same question in a later run opens a new record instead of returning an older run's answer.
					const active = dag?.runs.find((r) => r.id === dag.activeId && r.status !== "cancelled" && r.status !== "verified");
					const id = askId(api.conversationId, api.conversationId, kind, refs, active ? `${question}\n[run ${active.id}]` : question);
					const record = await api.commit(async (tx) => {
						const doc = await tx.doc(AsksDoc, api.conversationId);
						const existing = doc.asks.find((ask) => ask.id === id);
						if (existing) return clone(existing);
						expireAsks(doc, Date.now());
						if ((kind === "decision" || kind === "clarification") && doc.asks.filter((a) => a.to === "human" && a.state === "open" && (a.kind === "decision" || a.kind === "clarification")).length >= HUMAN_OPEN_CHOICE_LIMIT) {
							throw new Error(`At most ${HUMAN_OPEN_CHOICE_LIMIT} decision/clarification questions may be open for the human; wait for answers or decide yourself.`);
						}
						if (relays !== undefined) {
							const child = doc.asks.find((ask) => ask.id === relays);
							if (!child || child.to !== "main") throw new Error(`relays must name an open subagent ask; "${relays}" is unknown`);
							if (isTerminal(child)) throw new Error(`Subagent ask ${relays} is already ${child.state}`);
						}
						const now = Date.now();
                        // Explicit structural proof, not timestamp inference: only one ask gate over exactly these contracts.
                        const gates=active?.plan.nodes.filter(n=>n.kind==="ask" && JSON.stringify(askNodeRefs(active,n.id))===JSON.stringify([...refs].sort())) ?? [];
                        const gate=gates.length===1?gates[0]:undefined;
						const record: AskRecord = {
							id, from: { conversationId: api.conversationId }, to: "human", kind, refs: [...refs].sort(), question,
							...(options?.length ? { options } : {}), default: effectiveDefault, createdAt: now,
							deadlineAt: now + Math.min(deadline_ms ?? HUMAN_DEADLINE_MS, HUMAN_DEADLINE_MAX_MS), state: "open",
							...(relays !== undefined ? { relays } : {}),
							...(active ? { run: active.id, keys: askNodeKeys(active, [...refs].sort()), ...(active.goalBinding?{goalBinding:clone(active.goalBinding)}:{}) } : {}),
                            ...(active && gate ? {node:gate.id,nodeKey:active.nodes[gate.id]!.key} : {}),
						};
						doc.asks.push(record);
						return clone(record);
					}, context);
					return {
						content: [{ type: "text", text: `${describeAsk(record)}\nRelay this question to the human in your reply. When they answer, call answer({ask_id: "${record.id}", answer}). Without an answer it resolves to the default at the deadline.` }],
						details: { ask: record },
					};
				},
			}),
			defineTool({
				name: ANSWER_TOOL,
				description: "Resolve an open ask in this conversation (a subagent's question, or a human ask you relayed). For a human ask, quote a verbatim fragment of the human's message; the harness checks a human wrote it after the question. Exactly one resolution wins; a late answer after the deadline is kept as a fact revision but does not change the defaulted outcome.",
				parameters: Type.Object({ ask_id: Type.String({ minLength: 1, maxLength: 64 }), answer: Type.String({ maxLength: 4000 }), quote: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })) }, { additionalProperties: false }),
				replay: "safe", executionMode: "sequential",
				execute: async ({ ask_id, answer, quote }, api, context) => {
					const link = await api.snapshot(LinkDoc, api.conversationId, context);
					if (link?.parent) return text("Subagents do not answer asks.", true);
					const target = (await api.snapshot(AsksDoc, api.conversationId, context))?.asks.find((ask) => ask.id === ask_id);
					if (!target) return text(`Unknown ask ${ask_id}`, true);
					let human: { entryId: number; userId: string } | undefined;
					if (target.to === "human" && target.state === "open") {
						if (!quote) return text("A human ask needs quote: a verbatim fragment of the human's message that answers it.", true);
						human = await findHumanMessage(getHarness(), api.conversationId, quote, target.createdAt, context);
						if (!human) return text("No human message after the question contains that quote. Relay the question and wait for the human; do not answer for them.", true);
					}
					type Outcome = { error: string; record?: AskRecord } | { error?: undefined; record: AskRecord; relayed?: AskRecord; relayedChanged?: boolean };
					const result = await api.commit(async (tx): Promise<Outcome> => {
						const doc = await tx.doc(AsksDoc, api.conversationId);
						const now = Date.now();
						expireAsks(doc, now);
						const by = human ? `human:${human.userId}` : `agent:${api.conversationId}`;
						const { record, changed } = resolveAsk(doc, ask_id, { state: "answered", answer, by, now });
						if (!record) return { error: `Unknown ask ${ask_id}` };
						if (changed && human) record.sourceEntry = human.entryId;
						if (!changed) {
							if (record.state === "defaulted" && !record.late) record.late = { answer, at: now, by };
							return { error: `Ask ${ask_id} is already ${record.state}${record.answer !== undefined ? ` (${record.answer})` : ""}.${record.late?.answer === answer ? " Your answer is retained as a late fact revision." : ""}`, record: clone(record) };
						}
						const relayed = record.relays ? resolveAsk(doc, record.relays, { state: "answered", answer, by: `${by}:relay`, now }) : undefined;
						return { record: clone(record), ...(relayed?.record ? { relayed: clone(relayed.record), relayedChanged: relayed.changed } : {}) };
					}, context);
					if (result.error !== undefined) return { ...text(result.error, true), ...(result.record ? { details: { ask: result.record } } : {}) };
					const lines = [describeAsk(result.record)];
					if (result.relayed) lines.push(result.relayedChanged ? `relayed → ${describeAsk(result.relayed)}` : `relayed ask ${result.relayed.id} was already ${result.relayed.state}`);
					return { content: [{ type: "text", text: lines.join("\n") }], details: { ask: result.record, ...(result.relayed ? { relayed: result.relayed } : {}) } };
				},
			}),
		],
	});
}

async function validateHumanRefs(work: WorkService, harness: Pick<Harness, "snapshot">, conversationId: ConversationId, kind: AskKind, refs: readonly string[], options: readonly string[] | undefined, context: Context): Promise<string | undefined> {
	if (options !== undefined && (options.length < HUMAN_MIN_OPTIONS || options.length > HUMAN_MAX_OPTIONS || options.some((o) => !o.trim()) || new Set(options.map((o) => o.trim())).size !== options.length)) return `human asks take 2-4 distinct non-empty options; got ${options.length}.`;
	if (kind === "decision") return options === undefined ? 'kind "decision" to the human requires 2-4 options.' : undefined;
	if (kind === "clarification") return undefined;
	const distinct = new Set(refs);
	if (kind === "authority") {
		if (distinct.size < 1) return 'kind "authority" requires refs naming the irreversible action.';
		const dag = await harness.snapshot(RunDoc, conversationId, context);
		const run = dag?.runs.find((r) => r.id === dag.activeId);
		if (run) {
			const irreversible = new Set(run.plan.nodes.filter((n) => n.irreversible).map((n) => n.id));
			const bad = [...distinct].filter((ref) => !irreversible.has(ref));
			if (bad.length) return `with an active run, authority refs must be irreversible node ids of run ${run.id}; not irreversible: ${bad.join(", ")}.`;
		}
		return undefined;
	}
	if (kind === "external") return distinct.size >= 1 ? undefined : 'kind "external" requires refs naming the inaccessible source.';
	const state = await work.snapshot(conversationId, context);
	const active = state.works.find((w) => w.id === state.activeId);
	if (!active) return `kind "${kind}" needs an active work contract; register work_plan first or decide yourself.`;
	const known = new Set(active.contract.requirements.map((req) => req.id));
	const unknown = [...distinct].filter((ref) => !known.has(ref));
	if (unknown.length) return `refs must be requirement ids of the active contract; unknown: ${unknown.join(", ")}.`;
	if (kind === "acceptance" && distinct.size < 1) return "kind \"acceptance\" requires at least one requirement id.";
	if (kind === "conflict" && distinct.size < 2) return "kind \"conflict\" requires two distinct requirement ids.";
	return undefined;
}
