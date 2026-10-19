import type { Context } from "@earendil-works/chord";
import { AgentDoc, type ConversationId, type Harness, InboxDoc, LiveDoc } from "@earendil-works/pi-durable";
import { AgentsDoc, ProgressDoc } from "../extensions/subagents.ts";
import { type Claim, liveClaims } from "./claims.ts";
import type { SessionIndex } from "./search.ts";
import { withConversationAdmission } from "./queue.ts";
import { deleteThread, type DeleteThreadResult, listThreads } from "./threads.ts";

/**
 * What each thread is doing right now, read from the durable live state pi-durable keeps per conversation:
 * `pi.live.run` exists exactly while a run is active, `pi.live.tools` lists the current tool round, and `pi.inbox`
 * holds input waiting for the next boundary. Nothing here is cached, so a read is as fresh as the last commit.
 */
export type SessionState = "idle" | "generating" | "running_tools" | "retrying";

export type SessionSubagent = { taskId: string; description: string; subagentType: string; currentTool?: string; startedAt: number };

export type SessionStatus = {
	thread: string;
	conversationId: number;
	busy: boolean;
	state: SessionState;
	runningTools: string[];
	queued: number;
	subagents: SessionSubagent[];
	model?: string;
	/** Working folder bound to the conversation (realpath, set when the thread was created). */
	cwd?: string;
	lastActivityAt?: number;
	lastRole?: string;
	lastText?: string;
	claims: Claim[];
};

export type SessionsSnapshot = { at: number; sessions: SessionStatus[]; claims: Claim[] };

const LAST_TEXT_CHARS = 160;

export async function sessionsSnapshot(harness: Harness, index: SessionIndex, context: Context, now = Date.now()): Promise<SessionsSnapshot> {
	const threads = Object.entries(await listThreads(harness, context));
	const claims = await liveClaims(harness, context, now);
	const latest = index.latest(threads.map(([, id]) => id));
	const sessions = await Promise.all(threads.map(async ([thread, conversationId]) => {
		const status = await conversationStatus(harness, conversationId, context);
		const last = latest.get(conversationId);
		return {
			thread,
			conversationId,
			...status,
			...(last ? { lastActivityAt: last.at, lastRole: last.role, lastText: oneLine(last.text) } : {}),
			claims: claims.filter((claim) => claim.holder === thread),
		} satisfies SessionStatus;
	}));
	// An idle thread that never received a message is an abandoned opening, not a session worth listing.
	const listed = sessions.filter((session) => session.lastActivityAt !== undefined || session.busy || session.queued > 0 || session.subagents.length > 0);
	listed.sort((a, b) => Number(b.busy) - Number(a.busy) || (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.thread.localeCompare(b.thread));
	return { at: now, sessions: listed, claims };
}

/**
 * Delete `key` (and its `/new` archives) from the session list on its conversation's admission line, so no input is
 * admitted between the activity check and the unlink. Running subagents count as busy. See {@link deleteThread}.
 */
export async function deleteSession(harness: Harness, key: string, context: Context): Promise<DeleteThreadResult> {
	const threads = await listThreads(harness, context);
	const id = threads[key];
	if (id === undefined) return { status: "not_found" };
	return withConversationAdmission(harness, id, async () => {
		const ids = Object.entries(await listThreads(harness, context)).filter(([candidate]) => candidate === key || candidate.startsWith(`${key}#`)).map(([, conversation]) => conversation);
		const statuses = await Promise.all(ids.map((conversation) => conversationStatus(harness, conversation, context)));
		return deleteThread(harness, key, id, context, { busy: statuses.some((status) => status.subagents.length > 0) });
	});
}

export async function conversationStatus(harness: Harness, conversationId: ConversationId, context: Context) {
	const [live, inbox, agent, agents] = await Promise.all([
		harness.snapshot(LiveDoc, conversationId, context),
		harness.snapshot(InboxDoc, conversationId, context),
		harness.snapshot(AgentDoc, conversationId, context),
		harness.snapshot(AgentsDoc, conversationId, context),
	]);
	const runningTools = (live?.tools ?? []).filter((tool) => tool.status === "running").map((tool) => tool.name);
	const busy = live?.run !== undefined;
	const state: SessionState = !busy
		? "idle"
		: runningTools.length > 0
			? "running_tools"
			: live?.generation?.retry
				? "retrying"
				: "generating";
	const subagents: SessionSubagent[] = [];
	for (const ref of agents?.agents ?? []) {
		const progress = (await harness.snapshot(ProgressDoc, conversationId, String(ref.runnerId), context))?.subagent;
		if (progress?.status !== "running") continue;
		subagents.push({
			taskId: progress.taskId, description: progress.description, subagentType: progress.subagentType,
			startedAt: progress.startedAt, ...(progress.currentTool ? { currentTool: progress.currentTool } : {}),
		});
	}
	return {
		busy,
		state,
		runningTools,
		queued: inbox?.items.filter((item) => item.mode !== "write").length ?? 0,
		subagents,
		...(agent?.model ? { model: `${agent.model.provider}/${agent.model.modelId}` } : {}),
		...(typeof agent?.cwd === "string" ? { cwd: agent.cwd } : {}),
	};
}

/** Quarantine never lapses with the TTL; show its cause where a holder would otherwise look merely busy. */
function quarantine(claim: Claim): string {
	return claim.quarantined === undefined ? "" : `, quarantined: ${claim.quarantined}`;
}

function oneLine(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > LAST_TEXT_CHARS ? `${line.slice(0, LAST_TEXT_CHARS - 3)}...` : line;
}

function ago(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
	if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
	return `${Math.round(seconds / 86_400)}d ago`;
}

/** Plain-text rendering shared by the `session_list` tool and the `/sessions` command. */
export function formatSessions(snapshot: SessionsSnapshot, options: { self?: string } = {}): string {
	if (snapshot.sessions.length === 0) return "No threads yet.";
	const lines: string[] = [];
	for (const session of snapshot.sessions) {
		const activity = [
			session.state,
			...(session.runningTools.length ? [`tools: ${session.runningTools.join(", ")}`] : []),
			...(session.queued ? [`${session.queued} queued`] : []),
			...(session.subagents.length ? [`${session.subagents.length} subagent${session.subagents.length > 1 ? "s" : ""} running`] : []),
			...(session.lastActivityAt ? [ago(snapshot.at - session.lastActivityAt)] : []),
		].join(" | ");
		lines.push(`${session.busy ? "*" : "-"} ${session.thread}${session.thread === options.self ? " (this thread)" : ""}  [${activity}]`);
		for (const subagent of session.subagents) {
			lines.push(`    subagent ${subagent.taskId} (${subagent.subagentType}): ${subagent.description}${subagent.currentTool ? ` - ${subagent.currentTool}` : ""}`);
		}
		for (const claim of session.claims) lines.push(`    claim ${claim.key} (token ${claim.token}${quarantine(claim)}): ${claim.intent}`);
		if (session.lastText) lines.push(`    last ${session.lastRole}: ${session.lastText}`);
	}
	const foreign = snapshot.claims.filter((claim) => !snapshot.sessions.some((session) => session.thread === claim.holder));
	for (const claim of foreign) lines.push(`- ${claim.holder}  [claim ${claim.key} (token ${claim.token}${quarantine(claim)}): ${claim.intent}]`);
	return lines.join("\n");
}
