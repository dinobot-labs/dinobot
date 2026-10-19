import type { SessionsSnapshot } from "./sessions.ts";
import type { SetupState } from "../setup/state.ts";

/** "tui": started in the background by the TUI (`ensureDaemon`), so the TUI may restart it. "external": anything else. */
export type DaemonOwner = "tui" | "external";

/** Identity of a running daemon, served at `GET /v1/daemon`. */
export type DaemonInfo = {
	readonly pid: number;
	readonly version: string;
	/** realpath of the manifest the daemon booted from */
	readonly manifestPath: string;
	/** sha256 (hex) of the exact manifest text it booted from */
	readonly manifestSha256: string;
	readonly owner: DaemonOwner;
	readonly startedAt: string;
	/** thread keys with a running run, queued input, or running subagents */
	readonly busy: readonly string[];
	readonly setup: SetupState;
};

/** What the client API needs from the daemon process to describe, stop and restart it. */
export type DaemonControl = {
	info(): Promise<Omit<DaemonInfo, "busy">>;
	shutdown(reason: string): void;
	/** Start and await a ready successor (src/core/daemon-restart.ts); the caller then stops this daemon. Absent: 404. */
	startSuccessor?(): Promise<import("./daemon-restart.ts").SuccessorStart>;
};

/** Pure: threads that make a restart unsafe. */
export function busyThreads(snapshot: SessionsSnapshot): string[] {
	return snapshot.sessions
		.filter((session) => session.busy || session.queued > 0 || session.subagents.length > 0)
		.map((session) => session.thread);
}

export type ShutdownResult =
	| { readonly status: "stopping" }
	| { readonly status: "refused"; readonly error: "external" | "pid" | "busy"; readonly busy?: readonly string[] };
