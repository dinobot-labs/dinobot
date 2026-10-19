import type { CommandArgument, CommandEvent, CommandInfo, ThreadModelState } from "../commands/types.ts";
import type { AskChoice, InboundImage } from "../channels/types.ts";
import type { DaemonInfo, ShutdownResult } from "../core/daemon-info.ts";
import type { SendNowResult, WithdrawResult } from "../core/queue.ts";
import type { SessionsSnapshot } from "../core/sessions.ts";
import type { DeleteThreadResult } from "../core/threads.ts";
import type { ClientEvent } from "../core/ui-contract.ts";
import { HttpError, streamSse } from "./sse.ts";
export { HttpError } from "./sse.ts";

export type ThreadSummary = { readonly key: string; readonly conversationId: number };

export class ApiClient {
	private readonly workspaces = new Map<string, Promise<string>>();
	/** `locale` (e.g. `ko_KR.UTF-8`) is sent with every command so `/setup` speaks the terminal's language. */
	constructor(readonly base: URL, readonly initialCwd?: string, readonly locale?: string) {}

	/** Initialize before any route can create this thread. Existing sessions retain their cwd. */
	async workspace(channel: string, thread: string, signal?: AbortSignal): Promise<string | undefined> {
		if (!this.initialCwd || signal?.aborted) return undefined;
		const path = threadPath(channel, thread);
		let pending = this.workspaces.get(path);
		if (!pending) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 45_000);
			pending = this.request("POST", `${path}/workspace`, { cwd: this.initialCwd }, controller.signal)
				.then(body => (body as { cwd: string }).cwd).finally(() => clearTimeout(timer));
			this.workspaces.set(path, pending);
			void pending.catch(() => { if (this.workspaces.get(path) === pending) this.workspaces.delete(path); });
		}
		if (!signal) return pending;
		// Cancel this waiter, not the shared initialization also used by send/model requests.
		return new Promise((resolve, reject) => {
			const cancelled = () => { signal.removeEventListener("abort", cancelled); resolve(undefined); };
			signal.addEventListener("abort", cancelled, { once: true });
			void pending.then(
				value => { signal.removeEventListener("abort", cancelled); resolve(signal.aborted ? undefined : value); },
				error => { signal.removeEventListener("abort", cancelled); if (signal.aborted) resolve(undefined); else reject(error); },
			);
			if (signal.aborted) cancelled();
		});
	}

	async healthy(): Promise<boolean> {
		return fetch(new URL("/healthz", this.base)).then(
			(response) => response.ok,
			() => false,
		);
	}

	/** Identity of the running daemon; undefined when it predates `GET /v1/daemon` (HTTP 404). Other failures throw. */
	async daemonInfo(): Promise<DaemonInfo | undefined> {
		try {
			return (await this.request("GET", "/v1/daemon")) as DaemonInfo;
		} catch (error) {
			if (error instanceof HttpError && error.status === 404) return undefined;
			throw error;
		}
	}

	/** Ask a TUI-started, idle daemon whose process id is `pid` to stop gracefully. 409 refusals are returned, not thrown. */
	async shutdownDaemon(pid: number): Promise<ShutdownResult> {
		const path = "/v1/daemon/shutdown";
		const response = await fetch(new URL(path, this.base), {
			method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pid }),
		});
		if (response.status === 202) {
			await response.body?.cancel();
			return { status: "stopping" };
		}
		if (response.status === 409) return (await response.json()) as ShutdownResult;
		throw new HttpError(response.status, `POST ${path}: HTTP ${response.status} ${await response.text()}`);
	}

	async threads(): Promise<ThreadSummary[]> {
		const body = (await this.request("GET", "/v1/threads")) as { threads: ThreadSummary[] };
		return body.threads;
	}

	/** `autoReport` is present when the daemon scheduled an automatic session report for this message (ADR 0073). */
	async send(channel: string, thread: string, text: string, userId: string, whenBusy?: "followUp" | "steer", images?: readonly InboundImage[], choice?: AskChoice): Promise<SendResult | void> {
		await this.workspace(channel, thread);
		const body = (await this.request("POST", `${threadPath(channel, thread)}/messages`, {
			text, userId,
			...(whenBusy ? { whenBusy } : {}),
			...(choice ? { choice } : {}),
			...(images !== undefined && images.length > 0 ? { images } : {}),
		})) as { autoReport?: { id?: unknown; sendAt?: unknown; rule?: unknown } } | undefined;
		const auto = body?.autoReport;
		if (auto && typeof auto.id === "string" && typeof auto.sendAt === "string") return { autoReport: { id: auto.id, sendAt: auto.sendAt, rule: typeof auto.rule === "string" ? auto.rule : "" } };
		return {};
	}

	/** Deliver every queued input now: the running turn stops and the queued inputs start a fresh one. */
	async sendQueued(channel: string, thread: string): Promise<SendNowResult> {
		await this.workspace(channel, thread);
		return (await this.request("POST", `${threadPath(channel, thread)}/queue/send`)) as SendNowResult;
	}

	/** Take one queued input back before it reaches the model; `withdrawn` carries its original text. */
	async withdrawQueued(channel: string, thread: string, id: number): Promise<WithdrawResult> {
		await this.workspace(channel, thread);
		return (await this.request("POST", `${threadPath(channel, thread)}/queue/${id}/withdraw`)) as WithdrawResult;
	}

	/** Remove a thread (and its `/new` archives) from the session list. 404 and 409 refusals are returned, not thrown. */
	async deleteThread(channel: string, thread: string): Promise<DeleteThreadResult> {
		const path = threadPath(channel, thread);
		const response = await fetch(new URL(path, this.base), { method: "DELETE" });
		if (response.ok || response.status === 409 || (response.status === 404 && response.headers.get("content-type")?.includes("json"))) {
			const body = (await response.json()) as Partial<DeleteThreadResult>;
			if (typeof body.status === "string") return body as DeleteThreadResult;
		}
		throw new HttpError(response.status, `DELETE ${path}: HTTP ${response.status}`);
	}

	async abort(channel: string, thread: string): Promise<void> {
		await this.workspace(channel, thread);
		await this.request("POST", `${threadPath(channel, thread)}/abort`);
	}

	/** Subscribe until aborted, reconnecting transport failures with a fresh replacement snapshot. */
	async events(channel: string, thread: string, onEvent: (event: ClientEvent) => void, signal: AbortSignal): Promise<void> {
		if (signal.aborted) return;
		await this.workspace(channel, thread, signal);
		await this.stream(`${threadPath(channel, thread)}/events`, onEvent, signal);
	}

	/** Same stream for one conversation by id, e.g. a subagent's child conversation. */
	async conversationEvents(conversationId: number, onEvent: (event: ClientEvent) => void, signal: AbortSignal): Promise<void> {
		await this.stream(`/v1/conversations/${conversationId}/events`, onEvent, signal);
	}

	/** Live status of every thread: the current snapshot at once, then one on every change. */
	async sessionsEvents(onSnapshot: (snapshot: SessionsSnapshot) => void, signal: AbortSignal): Promise<void> {
		await this.stream<SessionsSnapshot & { type: "sessions" }>("/v1/sessions/events", onSnapshot, signal);
	}

	/** Slash commands enabled for the TUI, sorted by name; disabled ones are already left out. */
	async commands(): Promise<CommandInfo[]> {
		const body = (await this.request("GET", "/v1/commands")) as { commands: CommandInfo[] };
		return body.commands;
	}

	/** Completions for a command's first argument, scoped to the thread so `/model` can mark its current model. */
	async commandArguments(name: string, channel = "tui", thread = "main"): Promise<CommandArgument[]> {
		await this.workspace(channel, thread);
		const query = new URLSearchParams({ channel, thread });
		const body = (await this.request("GET", `/v1/commands/${encodeURIComponent(name)}/arguments?${query}`)) as { arguments: CommandArgument[] };
		return body.arguments;
	}

	/** Runs a command on the daemon and streams its events until `done` or `error` closes the stream; aborting `signal` aborts the run. */
	async runCommand(channel: string, thread: string, name: string, args: string, userId: string, onEvent: (event: CommandEvent) => void, signal: AbortSignal): Promise<void> {
		await this.workspace(channel, thread);
		await this.stream(`${threadPath(channel, thread)}/commands`, onEvent, signal, { name, args, userId, ...(this.locale ? { locale: this.locale } : {}) });
	}

	async answerPrompt(runId: string, promptId: string, answer: { value: string } | { cancel: true }): Promise<void> {
		await this.request("POST", `/v1/command-runs/${encodeURIComponent(runId)}/prompts/${encodeURIComponent(promptId)}`, answer);
	}

	async threadModel(channel: string, thread: string): Promise<ThreadModelState> {
		await this.workspace(channel, thread);
		return (await this.request("GET", `${threadPath(channel, thread)}/model`)) as ThreadModelState;
	}

	async researchReport(channel: string, thread: string, missionId: string, file = "report.md"): Promise<string> {
		await this.workspace(channel, thread);
		const query = new URLSearchParams({ file });
		const body = await this.request("GET", `${threadPath(channel, thread)}/research/${encodeURIComponent(missionId)}/report?${query}`) as { content: string };
		return body.content;
	}

	private async stream<T>(path: string, onEvent: (event: T) => void, signal: AbortSignal, body?: unknown): Promise<void> {
		await streamSse(new URL(path, this.base), onEvent, signal, body);
	}

	private async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
		const response = await fetch(new URL(path, this.base), {
			method,
			...(signal ? { signal } : {}),
			...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		});
		if (!response.ok) throw new HttpError(response.status, `${method} ${path}: HTTP ${response.status} ${await response.text()}`);
		return response.status === 204 ? undefined : response.json();
	}
}

export type SendResult = { autoReport?: { id: string; sendAt: string; rule: string } };

function threadPath(channel: string, thread: string): string {
	return `/v1/threads/${encodeURIComponent(channel)}/${encodeURIComponent(thread)}`;
}
