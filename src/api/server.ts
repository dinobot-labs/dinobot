import { parseAskChoice } from "../channels/ask-buttons.ts";
import type { AskChoice } from "../channels/types.ts";
import { sseStream } from "./sse.ts";
import { exportVisible } from "../core/visible-export.ts";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AgentDoc, InboxDoc } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { type ConversationId, type DocumentWatch, watchEvents } from "@earendil-works/pi-durable";
import { type Commands, type PromptAnswer } from "../commands/index.ts";
import type { SlashCommand, ThreadModelState } from "../commands/types.ts";
import type { Bot } from "../core/bot.ts";
import { acquire, ClaimsDoc, clampTtl, liveClaims, normalizeKey, release } from "../core/claims.ts";
import { quarantineReport, reconcileQuarantine, type ReconcileRequest } from "../core/claim-reconcile.ts";
import { RunDoc } from "../core/dag.ts";
import { activeDagView } from "../core/dag-view.ts";
import { ResearchDoc } from "../core/research.ts";
import { activeResearchView } from "../core/research-view.ts";
import { parseInboundImages } from "../core/message-images.ts";
import type { InboundImage } from "../channels/types.ts";
import { abortConversation, queuedInputs, sendQueuedNow, withdrawQueued } from "../core/queue.ts";
import { deleteSession, sessionsSnapshot } from "../core/sessions.ts";
import { busyThreads, type DaemonControl, type ShutdownResult } from "../core/daemon-info.ts";
import type { RestartResult } from "../core/daemon-restart.ts";
import { currentThreadModel } from "../core/reasoning.ts";
import type { ClientSnapshotEvent, DagStatusEvent, QueueStatusEvent, SubagentProgress, SubagentProgressEvent, WorkflowStatusEvent } from "../core/ui-contract.ts";
import { listThreads } from "../core/threads.ts";
import { detectFrustration } from "../report/detect.ts";
import { CONSENT_VERSION } from "../report/consent.ts";
import { REPORT_CLIENTS, REPORT_TRIGGERS, type ReportClient } from "../report/diagnostics.ts";
import { ConsentRequiredError, type ReportService } from "../report/service.ts";
import { AgentsDoc, ProgressDoc } from "../extensions/subagents.ts";
import { createUsageService, type UsageService } from "./usage.ts";

/**
 * Client API for local front ends (the TUI, later the desktop app). Bound to loopback and unauthenticated:
 * it is for the person running dinobot on their own machine, not for channels.
 *
 *   GET  /healthz
 *   POST /v1/threads/:channel/:thread/workspace        { cwd } -> { cwd, requestedCwd }; initializes new threads only
 *   GET  /v1/threads                                   -> { threads: [{ key, conversationId }] }
 *   DELETE /v1/threads/:channel/:thread                -> 200 { status: deleted, removed, releasedClaims } | 404 not_found
 *        | 409 { status: busy | moved | quarantined }; unlinks the thread and its /new archives from every listing
 *   POST /v1/threads/:channel/:thread/messages         { text, userId?, messageId?, whenBusy? } -> { submissionId }
 *   GET  /v1/threads/:channel/:thread/events           SSE agent events + durable subagent_progress, workflow_status, dag_status and queue_status, snapshot first
 *   POST /v1/threads/:channel/:thread/abort            stop the running answer and withdraw queued input
 *   POST /v1/threads/:channel/:thread/queue/send       deliver every queued input now in a fresh run -> { sent, submissionId? }
 *   POST /v1/threads/:channel/:thread/queue/:id/withdraw -> { status: withdrawn, item } | { status: already_placed | settled | not_found }
 *   GET  /v1/conversations/:id/events                  same stream for one conversation by id (a subagent's transcript)
 *   GET  /v1/threads/:channel/:thread/model            -> ThreadModelState { model, thinkingLevel, supportedThinkingLevels, fast, fastSupported, signedIn, contextWindow?, maxTokens? }
 *   GET  /v1/commands                                  -> { commands: CommandInfo[] } of surface "tui"
 *   GET  /v1/commands/:name/arguments?channel=&thread= -> { arguments: CommandArgument[] } (defaults tui, main)
 *   POST /v1/threads/:channel/:thread/commands         { name, args?, userId? } -> text/event-stream of CommandEvents
 *   POST /v1/command-runs/:runId/prompts/:promptId     { value } | { cancel: true } -> 204
 *   GET  /v1/search?q=&limit=&exclude=                 -> SearchResult (session_search over every thread)
 *   GET  /v1/sessions                                  -> SessionsSnapshot (live status of every thread + claims)
 *   GET  /v1/sessions/events                           SSE SessionsSnapshot on every change, first one at once
 *   GET  /v1/usage?refresh=1                           -> UsageResponse { at, summary, limits } (ADR 0099): every conversation's
 *        usage ledger summed (cached 30 s) and stored accounts with provider limit windows (OAuth fetch, cached 60 s per
 *        account; refresh lowers that to 10 s). Read-only: tokens are never refreshed or returned.
 *   GET  /v1/claims                                    -> { claims }
 *   POST /v1/claims                                    { key, holder, intent, ttlSeconds? } -> 200 granted/renewed | 409 conflict
 *   DELETE /v1/claims?holder=&key=                     -> { released } (key omitted: every claim of holder)
 *   GET  /v1/claims/quarantine                         -> QuarantineReport (cause, OS evidence and safe next action per quarantined claim)
 *   POST /v1/claims/quarantine/reconcile               { tokens: [{ key, holder, token }], actor, note } -> 200 reconciled | 409 refused
 *        Evidence-gated, not authority-gated: releases only the exact token closure whose native processes the OS proves quiescent.
 *   GET  /v1/daemon                                    -> DaemonInfo (pid, version, manifest realpath + sha256, owner, startedAt, busy threads, setup state); 404 without control
 *   POST /v1/daemon/shutdown                           { pid } -> 202 { status: stopping } | 409 { status: refused, error: external | pid | busy, busy? }; 404 without control
 *        Only a TUI-started daemon (owner "tui") with no busy thread stops, and only when pid names this process;
 *        the graceful stop (same path as SIGTERM) begins shortly after the response is sent.
 *   POST /v1/daemon/restart                            { pid } -> 202 { status: restarting, successorPid, busy } | 409 { status: refused, error: pid | stopping | supervised }
 *                                                      | 500 { status: failed, error: successor, detail }; 404 without control
 *        Used by `dinobot update`: any owner, busy or not (running work is interrupted). The successor is started first and
 *        this daemon stops only once it is ready; on failure this daemon keeps running untouched.
 *   GET  /v1/report/consent                            -> { version, text, textSha256, consented, receipt?, auto } of the local owner (ADR 0103)
 *   POST /v1/report/consent                            { version, collect: true, transfer: true, age14: true, auto? } -> 200 { receipt }
 *                                                      | 409 { error: version } | 400; 404 { error: report_disabled } without reports
 *   POST /v1/report                                    { trigger?, client?, note?, channel?, thread?, context? } -> 200 SubmitResult
 *        { id, shortId, status: sent | pending | failed, error?, entries, diagnostics, compressedBytes, redactions } | 403 { error: consent_required }
 *        Diagnostics in daemon mode (live state, conversation of channel/thread when given), stored and uploaded at once.
 */
export type ClientApi = { readonly url: URL; stop(): Promise<void> };

/** Delay between answering a shutdown request and stopping, so the 202 reaches the client before the server closes. */
const SHUTDOWN_DELAY_MS = 100;

export function startClientApi(bot: Bot, port: number, context: Context, commands: Commands, report?: ReportService, control?: DaemonControl, usage?: UsageService): ClientApi {
	// Without a credential store (tests, embedders) the summary still works and limits list no provider.
	const usageService = usage ?? createUsageService({ harness: bot.harness, index: bot.index, context });
	const unknownCommand = (name: string) => Response.json({ error: `unknown command /${name}` }, { status: 404 });
	const reportDisabled = () => Response.json({ error: "report_disabled" }, { status: 404 });
	const noControl = () => Response.json({ error: "daemon control is not available on this server" }, { status: 404 });
	let stopping = false;
	/** A restart is waiting for its successor; a plain shutdown now would leave the successor running alone. */
	let restarting = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port,
		routes: {
			"/healthz": new Response("ok"),
			"/v1/daemon": {
				GET: async () => {
					if (!control) return noControl();
					const info = await control.info();
					return Response.json({ ...info, busy: busyThreads(await sessionsSnapshot(bot.harness, bot.index, context)) });
				},
			},
			"/v1/daemon/restart": {
				POST: async (request) => {
					if (!control?.startSuccessor) return noControl();
					const body = await request.json().catch(() => undefined) as { pid?: unknown } | undefined;
					if (typeof body !== "object" || body === null || !Number.isSafeInteger(body.pid) || (body.pid as number) <= 0) {
						return Response.json({ error: "body must be { pid: positive integer }" }, { status: 400 });
					}
					const reply = (result: RestartResult, status: number) => Response.json(result, { status });
					if (body.pid !== process.pid) return reply({ status: "refused", error: "pid" }, 409);
					if (stopping || restarting) return reply({ status: "refused", error: "stopping" }, 409);
					// Claimed before any await: concurrent requests start at most one successor.
					restarting = true;
					let started: Awaited<ReturnType<NonNullable<DaemonControl["startSuccessor"]>>>;
					try { started = await control.startSuccessor(); } catch (error) {
						started = { ok: false, error: "successor", detail: error instanceof Error ? error.message : String(error) };
					}
					restarting = false;
					if (!started.ok) {
						return started.error === "supervised"
							? reply({ status: "refused", error: "supervised", supervisor: started.supervisor }, 409)
							: reply({ status: "failed", error: "successor", detail: started.detail }, 500);
					}
					stopping = true;
					let busy: string[] = [];
					try { busy = busyThreads(await sessionsSnapshot(bot.harness, bot.index, context)); } catch { /* informational only */ }
					setTimeout(() => control.shutdown("restart requested by update"), SHUTDOWN_DELAY_MS);
					return reply({ status: "restarting", successorPid: started.pid, busy }, 202);
				},
			},
			"/v1/daemon/shutdown": {
				POST: async (request) => {
					if (!control) return noControl();
					const body = await request.json().catch(() => undefined) as { pid?: unknown } | undefined;
					if (typeof body !== "object" || body === null || !Number.isSafeInteger(body.pid) || (body.pid as number) <= 0) {
						return Response.json({ error: "body must be { pid: positive integer }" }, { status: 400 });
					}
					const refuse = (result: ShutdownResult) => Response.json(result, { status: 409 });
					if ((await control.info()).owner !== "tui") return refuse({ status: "refused", error: "external" });
					if (body.pid !== process.pid) return refuse({ status: "refused", error: "pid" });
					if (restarting) return refuse({ status: "refused", error: "busy", busy: [] });
					if (!stopping) {
						const busy = busyThreads(await sessionsSnapshot(bot.harness, bot.index, context));
						if (busy.length > 0 && !stopping) return refuse({ status: "refused", error: "busy", busy });
						// Re-checked after the await: concurrent requests schedule one stop.
						if (!stopping) {
							stopping = true;
							setTimeout(() => control.shutdown("restart requested"), SHUTDOWN_DELAY_MS);
						}
					}
					return Response.json({ status: "stopping" } satisfies ShutdownResult, { status: 202 });
				},
			},
			"/v1/report/consent": {
				GET: async () => (report ? Response.json(await report.consentInfo("owner")) : reportDisabled()),
				POST: async (request) => {
					if (!report) return reportDisabled();
					const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined;
					if (typeof body !== "object" || body === null || typeof body.version !== "string") return Response.json({ error: "body must be { version, collect: true, transfer: true, age14: true, auto? }" }, { status: 400 });
					if (body.version !== CONSENT_VERSION) return Response.json({ error: "version", version: CONSENT_VERSION }, { status: 409 });
					if (body.collect !== true || body.transfer !== true || body.age14 !== true) return Response.json({ error: "collect, transfer and age14 must all be true" }, { status: 400 });
					if (body.auto !== undefined && typeof body.auto !== "boolean") return Response.json({ error: "auto must be a boolean" }, { status: 400 });
					return Response.json({ receipt: await report.recordConsent("owner", body.auto === true) });
				},
			},
			"/v1/report": {
				POST: async (request) => {
					if (!report) return reportDisabled();
					const body = parseReport(await request.json().catch(() => undefined));
					if (typeof body === "string") return Response.json({ error: body }, { status: 400 });
					try {
						return Response.json(await report.submit({ owner: "owner", reporter: "local", ...body }));
					} catch (error) {
						if (error instanceof ConsentRequiredError) return Response.json({ error: "consent_required", version: CONSENT_VERSION }, { status: 403 });
						return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
					}
				},
			},
            "/v1/conversations/:id/export/verify": { POST: async request => {
                const id=Number(request.params.id);if(!Number.isSafeInteger(id)||id<=0) return Response.json({error:"invalid_conversation"},{status:400});
                try { const body=await request.json() as {receipt:import("../core/visible-export.ts").VisibleExport;epoch:number;goalHash:string};return Response.json(await bot.work.verifyGoalExport(id as ConversationId,body.receipt,body.epoch,body.goalHash,context)); }
                catch(error) {return Response.json({error:String(error)},{status:409});}
            } },
            "/v1/conversations/:id/export": { GET: async request => {
                const id=Number(request.params.id);
                if(!Number.isSafeInteger(id)||id<=0) return Response.json({error:"invalid_conversation"},{status:400});
                const query=new URL(request.url).searchParams;
                try { return Response.json(await exportVisible(bot.harness,id as ConversationId,context,query.get("cursor")??undefined,query.has("limit")?Number(query.get("limit")):undefined)); }
                catch(error) { return Response.json({error:String(error)},{status:400}); }
            } },
			"/v1/threads/:channel/:thread/workspace": {
				POST: async (request) => {
					const body = await request.json().catch(() => null) as { cwd?: unknown } | null;
					if (typeof body?.cwd !== "string" || !isAbsolute(body.cwd)) return Response.json({ error: "cwd must be an absolute directory path" }, { status: 400 });
					let cwd: string;
					try { cwd = await realpath(body.cwd); if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory"); }
					catch { return Response.json({ error: "cwd must be an existing directory" }, { status: 400 }); }
					const conversation = await bot.conversation(request.params.channel, request.params.thread, context, cwd);
					const agent = await bot.harness.snapshot(AgentDoc, conversation.id, context);
					return Response.json({ cwd: agent?.cwd, requestedCwd: cwd });
				},
			},
			"/v1/threads": {
				GET: async () => {
					const threads = await listThreads(bot.harness, context);
					return Response.json({
						threads: Object.entries(threads).map(([key, conversationId]) => ({ key, conversationId })),
					});
				},
			},
			"/v1/threads/:channel/:thread": {
				DELETE: async (request) => {
					const outcome = await deleteSession(bot.harness, `${request.params.channel}:${request.params.thread}`, context);
					return Response.json(outcome, { status: outcome.status === "deleted" ? 200 : outcome.status === "not_found" ? 404 : 409 });
				},
			},
			"/v1/threads/:channel/:thread/messages": {
				POST: async (request) => {
					const body = parseSend(await request.json().catch(() => undefined));
					if (typeof body === "string") return Response.json({ error: body }, { status: 400 });
					const prepared = await bot.prepareChoice(
						{
							channel: request.params.channel,
							threadKey: request.params.thread,
							messageId: body.messageId ?? crypto.randomUUID(),
							userId: body.userId ?? "local",
							text: body.text,
							...(body.choice ? { choice: body.choice } : {}),
							...(body.images.length > 0 ? { images: body.images } : {}),
						},
						context,
					);
					if (!prepared.ok) return Response.json({ error: prepared.notice }, { status: 409 });
					const submission = await bot.submit(prepared.message, context, body.whenBusy);
					// The client API is the local owner's TUI (single user): the only surface where automatic
					// reports may run (ADR 0073). The service enforces consent, auto opt-in and cooldown.
					const rule = report && !body.choice ? detectFrustration(body.text) : undefined;
					const auto = rule && report
						? await report.scheduleAuto({ channel: request.params.channel, threadKey: request.params.thread, reporter: prepared.message.userId, rule }).catch(() => undefined)
						: undefined;
					return Response.json({ submissionId: submission.id, ...(auto?.scheduled ? { autoReport: { id: auto.id, sendAt: auto.sendAt, rule } } : {}) });
				},
			},
			"/v1/threads/:channel/:thread/abort": {
				POST: async (request) => {
					const conversation = await bot.conversation(request.params.channel, request.params.thread, context);
					await bot.research.cancelActive(conversation.id, "User aborted the run.", context);
					await abortConversation(bot.harness, conversation, context);
					const state = await bot.work.snapshot(conversation.id, context);
					if (state.activeId) await bot.work.settle(conversation.id, state.activeId, "cancelled", "User aborted the run.", context);
					return new Response(null, { status: 204 });
				},
			},
			"/v1/threads/:channel/:thread/queue/send": {
				POST: async (request) => {
					const conversation = await bot.conversation(request.params.channel, request.params.thread, context);
					return Response.json(await sendQueuedNow(bot.harness, conversation, context));
				},
			},
			"/v1/threads/:channel/:thread/queue/:submission/withdraw": {
				POST: async (request) => {
					const id = Number(request.params.submission);
					if (!Number.isSafeInteger(id) || id <= 0) return Response.json({ error: "submission must be a positive integer id" }, { status: 400 });
					const conversation = await bot.conversation(request.params.channel, request.params.thread, context);
					return Response.json(await withdrawQueued(bot.harness, conversation.id, id, context));
				},
			},
			"/v1/threads/:channel/:thread/events": {
				GET: async (request, server) => {
					server.timeout(request, 0); // long-lived stream: no idle timeout
					const conversation = await bot.conversation(request.params.channel, request.params.thread, context);
					return eventStream(bot, conversation.id, context);
				},
			},
			"/v1/threads/:channel/:thread/model": {
				GET: async (request) => {
					const state = await currentThreadModel(bot, request.params.channel, request.params.thread, context);
					return Response.json({ ...state, signedIn: await signedIn(bot.models, state.model), ...modelLimits(bot.models, state.model) } satisfies ThreadModelState);
				},
			},
			"/v1/threads/:channel/:thread/research/:mission/report": {
				GET: async (request) => {
					const conversation = await bot.conversation(request.params.channel, request.params.thread, context);
					const file = new URL(request.url).searchParams.get("file") ?? "report.md";
					try {
						const content = await bot.research.readReport(conversation.id, request.params.mission, file, context);
						return Response.json({ content });
					} catch (error) {
						return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
					}
				},
			},
			"/v1/search": {
				GET: async (request) => {
					const query = new URL(request.url).searchParams;
					const q = query.get("q") ?? "";
					if (q.trim() === "") return Response.json({ error: "q must be a non-empty query" }, { status: 400 });
					const limit = Number(query.get("limit") ?? "5");
					if (!Number.isInteger(limit) || limit < 1 || limit > 50) return Response.json({ error: "limit must be an integer from 1 to 50" }, { status: 400 });
					const exclude = query.get("exclude");
					return Response.json(await bot.index.search(q, { limit, ...(exclude ? { excludeThread: exclude } : {}) }, context));
				},
			},
			"/v1/sessions": {
				GET: async () => Response.json(await sessionsSnapshot(bot.harness, bot.index, context)),
			},
			"/v1/usage": {
				GET: async (request) => {
					const refresh = new URL(request.url).searchParams.get("refresh");
					try {
						return Response.json(await usageService.read({ refresh: refresh === "1" || refresh === "true" }));
					} catch (error) {
						return Response.json({ error: `usage unavailable: ${error instanceof Error ? error.message : String(error)}` }, { status: 500 });
					}
				},
			},
			"/v1/sessions/events": {
				GET: (request, server) => {
					server.timeout(request, 0);
					return sessionsStream(bot, context);
				},
			},
			"/v1/claims": {
				GET: async () => Response.json({ claims: await liveClaims(bot.harness, context) }),
				POST: async (request) => {
					const body = parseClaim(await request.json().catch(() => undefined));
					if (typeof body === "string") return Response.json({ error: body }, { status: 400 });
					const outcome = await bot.harness.commit(async (tx) => acquire(await tx.doc(ClaimsDoc), body, Date.now()), context);
					return Response.json(outcome, { status: outcome.status === "conflict" ? 409 : 200 });
				},
				DELETE: async (request) => {
					const query = new URL(request.url).searchParams;
					const holder = query.get("holder") ?? "";
					if (holder === "") return Response.json({ error: "holder must be a non-empty thread key" }, { status: 400 });
					const rawKey = query.get("key");
					const key = rawKey === null ? undefined : normalizeKey(rawKey);
					if (key !== undefined && typeof key !== "string") return Response.json({ error: key.error }, { status: 400 });
					const released = await bot.harness.commit(async (tx) => release(await tx.doc(ClaimsDoc), holder, key, Date.now()), context);
					return Response.json({ released });
				},
			},
			"/v1/claims/quarantine": {
				GET: async () => Response.json(await quarantineReport(bot.harness, context)),
			},
			"/v1/claims/quarantine/reconcile": {
				POST: async (request) => {
					const body = parseReconcile(await request.json().catch(() => undefined));
					if (typeof body === "string") return Response.json({ error: body }, { status: 400 });
					const outcome = await reconcileQuarantine(bot.harness, body, context);
					return Response.json(outcome, { status: outcome.status === "reconciled" ? 200 : 409 });
				},
			},
			"/v1/commands": {
				GET: () => Response.json({ commands: commands.list("tui") }),
			},
			"/v1/commands/:name/arguments": {
				GET: async (request) => {
					const command = commands.find(request.params.name, "tui");
					if (command === undefined) return unknownCommand(request.params.name);
					const query = new URL(request.url).searchParams;
					const scope = { channel: query.get("channel") || "tui", threadKey: query.get("thread") || "main" };
					return Response.json({ arguments: (await command.arguments?.(context, scope)) ?? [] });
				},
			},
			"/v1/threads/:channel/:thread/commands": {
				POST: async (request, server) => {
					const body = parseCommand(await request.json().catch(() => undefined));
					if (typeof body === "string") return Response.json({ error: body }, { status: 400 });
					const command = commands.find(body.name, "tui");
					if (command === undefined) return unknownCommand(body.name);
					server.timeout(request, 0); // prompts wait on the person
					return commandStream(commands, command, body, request, context);
				},
			},
			"/v1/command-runs/:runId/prompts/:promptId": {
				POST: async (request) => {
					const answer = parseAnswer(await request.json().catch(() => undefined));
					if (typeof answer === "string") return Response.json({ error: answer }, { status: 400 });
					if (!commands.answer(request.params.runId, request.params.promptId, answer)) {
						return Response.json({ error: "no such pending prompt" }, { status: 404 });
					}
					return new Response(null, { status: 204 });
				},
			},
			"/v1/conversations/:id/events": {
				GET: async (request, server) => {
					const parsed = Number(request.params.id);
					if (!Number.isSafeInteger(parsed) || parsed <= 0 || String(parsed) !== request.params.id) {
						return Response.json({ error: "conversation id must be a positive integer" }, { status: 400 });
					}
					const id = parsed as ConversationId;
					const conversation = await bot.harness.conversation(id, context);
					if (conversation === undefined) return Response.json({ error: `conversation ${parsed} not found` }, { status: 404 });
					server.timeout(request, 0);
					return eventStream(bot, id, context);
				},
			},
		},
	});
	return { url: server.url, stop: () => server.stop(true) };
}

async function eventStream(bot: Bot, conversationId: ConversationId, context: Context): Promise<Response> {
	await bot.harness.commit(async (tx) => { await tx.doc(AgentsDoc, conversationId); await tx.doc(RunDoc, conversationId); await tx.doc(ResearchDoc, conversationId); }, context);
	/** The shown run as committed now; a watch value only advances when its delivery arrives. */
	const currentDag = async () => {
		const [runs, researchState] = await Promise.all([
			bot.harness.snapshot(RunDoc, conversationId, context),
			bot.harness.snapshot(ResearchDoc, conversationId, context),
		]);
		const dag = activeDagView(runs);
		const research = activeResearchView(researchState);
		if (!research) return dag;
		if (dag) return { ...dag, research };
		return { id: research.id, revision: research.revision, status: "compiling" as const,
			replanBudget: 0, requirements: [], levels: 0, nodes: [], updatedAt: 0, research };
	};
	// Every watch acquired so far is stopped when a later setup step fails.
	const acquired: { stop(): Promise<unknown> }[] = [];
	const setup = await (async () => {
		const agents = await bot.harness.watchDoc(AgentsDoc, conversationId, context);
		if (!agents) throw new Error("Subagent linkage watch is missing");
		acquired.push(agents);
		const runs = await bot.harness.watchDoc(RunDoc, conversationId, context);
		if (!runs) throw new Error("DAG run watch is missing");
		acquired.push(runs);
		const research = await bot.harness.watchDoc(ResearchDoc, conversationId, context);
		if (!research) throw new Error("Research mission watch is missing");
		acquired.push(research);
		const initialWorkflow = await bot.work.status(conversationId, context);
		const workflowWatch = await bot.work.watch(conversationId, context);
		if (!workflowWatch) throw new Error("Workflow watch is missing");
		acquired.push(workflowWatch);
		const inbox = await bot.harness.watchDoc(InboxDoc, conversationId, context);
		if (!inbox) throw new Error("Queued input watch is missing");
		acquired.push(inbox);
		const events = await watchEvents(bot.harness, conversationId, context);
		acquired.push(events);
		const initialDag = await currentDag();
		return { agents, runs, research, initialWorkflow, workflowWatch, inbox, events, initialDag };
	})().catch(async (error: unknown) => {
		await Promise.allSettled(acquired.map((watch) => watch.stop()));
		return error instanceof Error ? error : new Error(String(error));
	});
	if (setup instanceof Error) return Response.json({ error: `event stream setup failed: ${setup.message}` }, { status: 503 });
	const { agents, runs, research, initialWorkflow, workflowWatch, inbox, events, initialDag } = setup;
	const progressWatches = new Map<string, DocumentWatch<{ subagent?: SubagentProgress; answer?: string }>>();
	/** Re-sends each watched child's current progress; a replacement snapshot resets the client's subagent map. */
	const republish = new Map<string, () => void>();
	let stopped = false;
	let syncing = Promise.resolve();
	let workflowSync = Promise.resolve();
	/** DAG publications and replacement snapshots run in this one chain, so an older view never follows a newer one. */
	let dagSync = Promise.resolve();
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		await Promise.allSettled(acquired.map((watch) => Promise.resolve().then(() => watch.stop())));
		await Promise.allSettled([syncing, workflowSync, dagSync]);
		await Promise.allSettled([...progressWatches.values()].map((watch) => Promise.resolve().then(() => watch.stop())));
	};
	const encoder = new TextEncoder();
	const body = sseStream({
		start(controller) {
			const send = (event: unknown) => { if (!stopped) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); };
			let lastWorkflow = JSON.stringify(initialWorkflow);
			let lastDag = JSON.stringify(initialDag);
			const initialQueue = queuedInputs(inbox.value);
			let lastQueue = JSON.stringify(initialQueue);
			/** The queue as of the inbox watch; a replacement snapshot carries it and later changes follow as queue_status. */
			const currentQueue = () => {
				const queue = queuedInputs(inbox.value);
				lastQueue = JSON.stringify(queue);
				return queue;
			};
			const syncQueue = () => {
				const queue = queuedInputs(inbox.value);
				const serialized = JSON.stringify(queue);
				if (serialized === lastQueue) return;
				lastQueue = serialized;
				send({ type: "queue_status", items: queue } satisfies QueueStatusEvent);
			};
			const serialDag = (task: () => Promise<void>) => {
				dagSync = dagSync.then(async () => { if (!stopped) await task(); }).catch((error) => { if (!stopped) controller.error(error); void stop(); });
				return dagSync;
			};
			const syncDag = () => serialDag(async () => {
				const dag = await currentDag();
				const serialized = JSON.stringify(dag);
				if (serialized === lastDag) return;
				lastDag = serialized;
				send({ type: "dag_status", dag } satisfies DagStatusEvent);
			});
			const syncWorkflow = () => {
				workflowSync = workflowSync.then(async () => {
					if (stopped) return;
					const workflow = await bot.work.status(conversationId, context);
					const serialized = JSON.stringify(workflow);
					if (serialized === lastWorkflow) return;
					lastWorkflow = serialized;
					send({ type: "workflow_status", workflow } satisfies WorkflowStatusEvent);
				}).catch((error) => { if (!stopped) controller.error(error); void stop(); });
				return workflowSync;
			};
			const sync = async (refs: typeof agents.value) => {
				for (const ref of refs?.agents ?? []) {
					const key = String(ref.runnerId);
					if (stopped || progressWatches.has(key)) continue;
					const watch = await bot.harness.watchDoc(ProgressDoc, conversationId, key, context);
					if (!watch) throw new Error(`Subagent ${ref.taskId} progress watch is missing`);
					progressWatches.set(key, watch);
					if (stopped) { await watch.stop(); return; }
					const publish = (value: typeof watch.value) => {
						if (!stopped && value?.subagent) send({
							type: "subagent_progress", subagents: [value.subagent],
							...(ref.callId === undefined ? {} : { callId: ref.callId }),
						} satisfies SubagentProgressEvent);
					};
					publish(watch.value);
					if (stopped) { await watch.stop(); return; }
					republish.set(key, () => publish(watch.value));
					watch.start(async (value) => { publish(value); });
				}
			};
			send({ ...events.snapshot, workflow: initialWorkflow, dag: initialDag, queue: initialQueue } satisfies ClientSnapshotEvent);
			// Do not schedule watch publications behind a large initial frame. The
			// stream start must return now so byte pulls can drain that frame.
			void controller.drained().then(() => {
				if (stopped) return;
				events.start(async (batch) => {
					for (const event of batch) {
						if (event.type === "snapshot") {
							const workflow = await bot.work.status(conversationId, context);
							lastWorkflow = JSON.stringify(workflow);
							await serialDag(async () => {
								const dag = await currentDag();
								lastDag = JSON.stringify(dag);
								send({ ...event, workflow, dag, queue: currentQueue() } satisfies ClientSnapshotEvent);
								await controller.drained();
								for (const replay of republish.values()) replay();
							});
						} else {
							send(event);
							await controller.drained();
						}
					}
					await syncWorkflow();
				});
				workflowWatch.start(async () => { await syncWorkflow(); });
				inbox.start(async () => { syncQueue(); });
				syncQueue();
				if (stopped) return;
				runs.start(async () => { await syncDag(); });
				research.start(async () => { await syncDag(); });
				void syncDag();
				void syncWorkflow();
				syncing = sync(agents.value);
				agents.start(async (value) => { await syncing; syncing = sync(value); await syncing; });
				void syncing.catch((error) => { controller.error(error); void stop(); });
				void events.closed.then(() => { if (!stopped) controller.close(); void stop(); }).catch((error) => { if (!stopped) controller.error(error); void stop(); });
			}).catch((error) => { controller.error(error); void stop(); });
		},
		cancel: stop,
	});
	return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function commandStream(
	commands: Commands,
	command: SlashCommand,
	body: CommandBody,
	request: Request & { params: { channel: string; thread: string } },
	context: Context,
): Response {
	const abort = new AbortController();
	const onAbort = () => abort.abort();
	request.signal.addEventListener("abort", onAbort, { once: true });
	if (request.signal.aborted) abort.abort();
	const run = commands.run(command, body.args ?? "", {
		surface: "tui",
		channel: request.params.channel,
		threadKey: request.params.thread,
		userId: body.userId ?? "local",
		...(body.locale !== undefined ? { locale: body.locale } : {}),
		context,
		signal: abort.signal,
	});
	const events = run.events[Symbol.asyncIterator]();
	const encoder = new TextEncoder();
	const stream = sseStream({
		async pull(controller) {
			const next = await events.next();
			if (next.done) controller.close();
			else controller.enqueue(encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`));
		},
		async cancel() {
			request.signal.removeEventListener("abort", onAbort);
			abort.abort();
			await events.return?.();
		},
	});
	return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

const SESSIONS_DEBOUNCE_MS = 250;
const SESSIONS_REFRESH_MS = 30_000;

/** Recompute on commits, at most every SESSIONS_DEBOUNCE_MS, and on a slow timer so lapsed claims drop out; send only changes. */
function sessionsStream(bot: Bot, context: Context): Response {
	const encoder = new TextEncoder();
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let refresh: ReturnType<typeof setInterval> | undefined;
	let unsubscribe = () => {};
	const stop = () => {
		stopped = true;
		unsubscribe();
		if (timer) clearTimeout(timer);
		if (refresh) clearInterval(refresh);
	};
	const body = sseStream({
		start(controller) {
			let last = "";
			let running = Promise.resolve();
			const publish = () => {
				timer = undefined;
				running = running.then(async () => {
					if (stopped) return;
					const snapshot = await sessionsSnapshot(bot.harness, bot.index, context);
					const key = JSON.stringify({ ...snapshot, at: 0 });
					if (stopped || key === last) return;
					last = key;
					controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "sessions", ...snapshot })}\n\n`));
				}).catch((error) => {
					if (!stopped) controller.error(error);
					stop();
				});
			};
			unsubscribe = bot.harness.subscribeCommits(() => {
				if (!stopped && !timer) timer = setTimeout(publish, SESSIONS_DEBOUNCE_MS);
			});
			refresh = setInterval(publish, SESSIONS_REFRESH_MS);
			publish();
		},
		cancel: stop,
	});
	return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

type ClaimBody = { key: string; holder: string; intent: string; ttlMs: number };

function parseReconcile(body: unknown): ReconcileRequest | string {
	if (typeof body !== "object" || body === null) return "body must be a JSON object";
	const record = body as Record<string, unknown>;
	if (!Array.isArray(record.tokens) || record.tokens.length === 0 || record.tokens.length > 1000) return "tokens must be a non-empty array of { key, holder, token }";
	const tokens: ReconcileRequest["tokens"] = [];
	for (const token of record.tokens as unknown[]) {
		const t = token as Record<string, unknown> | null;
		if (typeof t !== "object" || t === null || typeof t.key !== "string" || typeof t.holder !== "string" || !Number.isSafeInteger(t.token)) return "each token must be { key: string, holder: string, token: integer }";
		tokens.push({ key: t.key, holder: t.holder, token: t.token as number });
	}
	if (typeof record.actor !== "string" || record.actor.trim() === "") return "actor must name who reconciles";
	if (typeof record.note !== "string" || record.note.trim() === "") return "note must state why";
	return { tokens, actor: record.actor, note: record.note };
}

function parseClaim(body: unknown): ClaimBody | string {
	if (typeof body !== "object" || body === null) return "body must be a JSON object";
	const record = body as Record<string, unknown>;
	if (typeof record.key !== "string") return "key must be a string";
	const key = normalizeKey(record.key);
	if (typeof key !== "string") return key.error;
	if (typeof record.holder !== "string" || record.holder.trim() === "") return "holder must be a non-empty thread key such as tui:main";
	if (typeof record.intent !== "string" || record.intent.trim() === "") return "intent must be a non-empty string";
	if (record.ttlSeconds !== undefined && (typeof record.ttlSeconds !== "number" || !(record.ttlSeconds > 0))) {
		return "ttlSeconds must be a positive number";
	}
	return {
		key,
		holder: record.holder.trim(),
		intent: record.intent.trim(),
		ttlMs: clampTtl(record.ttlSeconds === undefined ? undefined : record.ttlSeconds * 1000),
	};
}

type CommandBody = { name: string; args?: string; userId?: string; locale?: string };

function parseCommand(body: unknown): CommandBody | string {
	if (typeof body !== "object" || body === null) return "body must be a JSON object";
	const record = body as Record<string, unknown>;
	if (typeof record.name !== "string" || record.name === "") return "name must be a non-empty string";
	if (record.args !== undefined && typeof record.args !== "string") return "args must be a string";
	if (record.userId !== undefined && (typeof record.userId !== "string" || record.userId === "")) {
		return "userId must be a non-empty string";
	}
	if (record.locale !== undefined && (typeof record.locale !== "string" || record.locale.length > 64)) return "locale must be a string of at most 64 characters";
	return record as CommandBody;
}

function parseAnswer(body: unknown): PromptAnswer | string {
	if (typeof body !== "object" || body === null) return "body must be a JSON object";
	const record = body as Record<string, unknown>;
	if (record.cancel === true) return { cancel: true };
	if (typeof record.value === "string") return { value: record.value };
	return 'body must be { value: string } or { cancel: true }';
}

type SendBody = { choice?: AskChoice; text: string; userId?: string; messageId?: string; whenBusy?: "followUp" | "steer"; images: readonly InboundImage[] };

/** Parse the send body; exported for the admission tests. The images field obeys the shared message bounds. */
type ReportBody = { trigger: string; client: ReportClient; note?: string; channel?: string; threadKey?: string; context?: unknown };

/** POST /v1/report body; the trigger and client come from fixed lists (the wire rule of dinobot.report/v1 is stricter anyway). */
export function parseReport(body: unknown): ReportBody | string {
	if (body === undefined) body = {};
	if (typeof body !== "object" || body === null || Array.isArray(body)) return "body must be an object";
	const raw = body as Record<string, unknown>;
	const trigger = raw.trigger ?? "button";
	const client = raw.client ?? "tui";
	if (typeof trigger !== "string" || !(REPORT_TRIGGERS as readonly string[]).includes(trigger)) return `trigger must be one of ${REPORT_TRIGGERS.join(", ")}`;
	if (typeof client !== "string" || !(REPORT_CLIENTS as readonly string[]).includes(client)) return `client must be one of ${REPORT_CLIENTS.join(", ")}`;
	if (raw.note !== undefined && typeof raw.note !== "string") return "note must be a string";
	if ((raw.channel === undefined) !== (raw.thread === undefined)) return "channel and thread go together";
	if (raw.channel !== undefined && (typeof raw.channel !== "string" || typeof raw.thread !== "string" || !raw.channel || !raw.thread)) return "channel and thread must be non-empty strings";
	return {
		trigger,
		client: client as ReportClient,
		...(typeof raw.note === "string" ? { note: raw.note } : {}),
		...(typeof raw.channel === "string" ? { channel: raw.channel, threadKey: raw.thread as string } : {}),
		...(raw.context !== undefined ? { context: raw.context } : {}),
	};
}

export function parseSend(body: unknown): SendBody | string {
	if (typeof body !== "object" || body === null) return "body must be a JSON object";
	const record = body as Record<string, unknown>;
	const choice = record.choice === undefined ? undefined : parseAskChoice(record.choice);
	if (record.choice !== undefined && !choice) return "choice must be {askId, option}";
	const images = parseInboundImages(record.images);
	if (typeof images === "string") return images;
	if (typeof record.text !== "string" || (record.text.trim() === "" && images.length === 0)) {
		return "text must be a non-empty string";
	}
	for (const field of ["userId", "messageId"] as const) {
		if (record[field] !== undefined && (typeof record[field] !== "string" || record[field] === "")) {
			return `${field} must be a non-empty string`;
		}
	}
	if (record.whenBusy !== undefined && record.whenBusy !== "followUp" && record.whenBusy !== "steer") {
		return 'whenBusy must be "followUp" or "steer"';
	}
	return { ...(record as Omit<SendBody, "images">), images };
}

/** Catalog context window and output limit of `provider/modelId`; empty for a model the catalog does not know. */
export function modelLimits(models: Bot["models"], ref: string): Pick<ThreadModelState, "contextWindow" | "maxTokens"> {
	const slash = ref.indexOf("/");
	const model = slash < 0 ? undefined : models.getModel(ref.slice(0, slash), ref.slice(slash + 1));
	const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
	return {
		...(positive(model?.contextWindow) ? { contextWindow: model.contextWindow } : {}),
		...(positive(model?.maxTokens) ? { maxTokens: model.maxTokens } : {}),
	};
}

/** Whether `provider/modelId` can authenticate now (stored login or environment key). Unknown answers count as signed in. */
export async function signedIn(models: Bot["models"], ref: string): Promise<boolean> {
	const slash = ref.indexOf("/");
	const model = models.getModel(ref.slice(0, slash), ref.slice(slash + 1));
	if (!model) return true;
	try {
		return (await models.getAuth(model)) !== undefined;
	} catch {
		return true;
	}
}
