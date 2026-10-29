/**
 * PM ledger model (ADR 0105): pure types, the event reducer, transition guards, progress and turn-end findings.
 * Nothing here reads the clock, the disk, git or the host; callers pass facts in, so every rule is checkable by tests.
 */

export const ITEM_STATUSES = ["todo", "doing", "review", "done", "blocked", "excluded"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const TERMINAL: ReadonlySet<ItemStatus> = new Set(["done", "excluded"]);
export const LEDGER_STATUSES = ["active", "paused", "closed"] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export type CheckSpec = { readonly command: string; readonly timeoutSec: number };
export type CheckRun = {
	readonly check: string;
	readonly commit: string;
	readonly exitCode: number | null;
	readonly passed: boolean;
	/** Why a run that exited 0 still did not pass (tree changed during the run, timeout). */
	readonly invalid?: string;
	readonly at: number;
	readonly durationMs: number;
	readonly outputSha256: string;
	readonly outputTail: string;
};
export type Item = {
	readonly id: string;
	readonly title: string;
	readonly area?: string;
	readonly size?: "S" | "M" | "L";
	readonly deps: readonly string[];
	/** Required checks; absent: the ledger's defaultChecks. */
	readonly checks?: readonly string[];
	readonly status: ItemStatus;
	readonly worker?: string;
	readonly commit?: string;
	readonly reason?: string;
	readonly runs: readonly CheckRun[];
	readonly createdAt: number;
	readonly startedAt?: number;
	readonly doneAt?: number;
};
export type Decision = { readonly id: string; readonly text: string; readonly at: number; readonly items: readonly string[] };
export type Ledger = {
	readonly id: string;
	readonly title: string;
	readonly owner: string;
	readonly status: LedgerStatus;
	readonly repo?: string;
	readonly integrationRef?: string;
	readonly wipLimit: number;
	readonly checks: Readonly<Record<string, CheckSpec>>;
	readonly defaultChecks: readonly string[];
	readonly items: readonly Item[];
	readonly decisions: readonly Decision[];
	readonly createdAt: number;
};

/** One recorded change. The reducer applies it without re-checking external facts; guards ran before it was recorded. */
export type Op =
	| { readonly op: "create"; readonly ledger: Omit<Ledger, "items" | "decisions" | "status"> }
	| { readonly op: "add_items"; readonly items: readonly Omit<Item, "status" | "runs" | "createdAt">[] }
	| { readonly op: "transition"; readonly item: string; readonly to: ItemStatus; readonly worker?: string; readonly commit?: string; readonly reason?: string }
	| { readonly op: "check_run"; readonly item: string; readonly run: CheckRun }
	| { readonly op: "decision"; readonly text: string; readonly items: readonly string[] }
	| { readonly op: "ledger_status"; readonly status: LedgerStatus; readonly reason?: string };
export type Event = Op & { readonly seq: number; readonly at: number; readonly actor: string; readonly prev: string; readonly hash: string };

export const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const COMMIT = /^[0-9a-f]{7,64}$/;
/**
 * Longest one check may run. pm tools are plugin tools, so in codemode-only mode a check runs inside a codemode cell,
 * whose ceiling is CODEMODE_LIMITS.maxTimeoutMs (960 s); a longer check would be aborted with the cell and never recorded.
 */
export const CHECK_TIMEOUT_MAX_SEC = 900;
/** Effective timeout of a configured check: ledgers created before the ceiling may hold larger values. */
export function checkTimeoutSec(spec: CheckSpec): number {
	return Math.min(spec.timeoutSec, CHECK_TIMEOUT_MAX_SEC);
}

export function requiredChecks(ledger: Ledger, item: Item): readonly string[] {
	return item.checks ?? ledger.defaultChecks;
}

export function reduce(state: Ledger | undefined, event: Event): Ledger {
	if (event.op === "create") {
		if (state !== undefined) throw new Error(`event ${event.seq}: create on an existing ledger`);
		return { ...event.ledger, status: "active", items: [], decisions: [] };
	}
	if (state === undefined) throw new Error(`event ${event.seq}: ${event.op} before create`);
	switch (event.op) {
		case "add_items":
			return { ...state, items: [...state.items, ...event.items.map((item) => ({ ...item, status: "todo" as const, runs: [], createdAt: event.at }))] };
		case "transition":
			return {
				...state,
				items: state.items.map((item) => {
					if (item.id !== event.item) return item;
					const next: Item = { ...item, status: event.to };
					const out = { ...next } as { -readonly [K in keyof Item]: Item[K] };
					if (event.to === "doing") { if (event.worker !== undefined) out.worker = event.worker; out.startedAt = event.at; delete out.reason; }
					if (event.to === "todo") { delete out.worker; delete out.startedAt; }
					if (event.commit !== undefined) out.commit = event.commit;
					if (event.reason !== undefined) out.reason = event.reason;
					if (event.to === "done") out.doneAt = event.at;
					return out;
				}),
			};
		case "check_run":
			return { ...state, items: state.items.map((item) => (item.id === event.item ? { ...item, runs: [...item.runs, event.run] } : item)) };
		case "decision":
			return { ...state, decisions: [...state.decisions, { id: `D${state.decisions.length + 1}`, text: event.text, at: event.at, items: event.items }] };
		case "ledger_status":
			return { ...state, status: event.status };
	}
}

/** Directed edges a transition may take; anything else is rejected. `done` and `excluded` are final. */
export const TRANSITIONS: Readonly<Record<ItemStatus, readonly ItemStatus[]>> = {
	todo: ["doing", "excluded", "blocked"],
	doing: ["review", "done", "blocked", "todo"],
	review: ["done", "doing", "blocked", "todo"],
	blocked: ["todo", "excluded"],
	done: [],
	excluded: [],
};

export type Facts = {
	/** Subagents of the owner conversation; undefined when the host cannot tell (then worker liveness is not checked). */
	readonly subagents?: readonly { readonly taskId: string; readonly status: string }[];
	/** Commit facts from git; undefined when the ledger has no repo. */
	readonly commit?: { readonly exists: boolean; readonly reachable?: boolean };
};

/** Every reason the transition is not allowed now; empty means allowed. */
export function transitionErrors(
	ledger: Ledger,
	request: { readonly item: string; readonly to: ItemStatus; readonly worker?: string; readonly commit?: string; readonly reason?: string },
	facts: Facts,
): string[] {
	const errors: string[] = [];
	if (ledger.status !== "active") errors.push(`ledger ${ledger.id} is ${ledger.status}`);
	const item = ledger.items.find((candidate) => candidate.id === request.item);
	if (!item) return [...errors, `unknown item ${request.item}`];
	if (!TRANSITIONS[item.status].includes(request.to)) {
		return [...errors, `${item.id}: ${item.status} -> ${request.to} is not an allowed transition (allowed: ${TRANSITIONS[item.status].join(", ") || "none, final"})`];
	}
	const worker = (id: string | undefined) => (id === undefined ? undefined : facts.subagents?.find((agent) => agent.taskId === id));
	if (request.to === "doing") {
		if (!request.worker) errors.push(`${item.id}: doing needs worker (the subagent taskId doing it)`);
		else if (facts.subagents !== undefined) {
			const agent = worker(request.worker);
			if (!agent) errors.push(`${item.id}: worker ${request.worker} is not a subagent of this conversation`);
			else if (agent.status !== "running") errors.push(`${item.id}: worker ${request.worker} is ${agent.status}, not running`);
		}
		const holder = ledger.items.find((other) => other.id !== item.id && other.status === "doing" && other.worker === request.worker);
		if (request.worker && holder) errors.push(`${item.id}: worker ${request.worker} already holds ${holder.id}`);
		const pending = item.deps.filter((dep) => !TERMINAL.has(ledger.items.find((other) => other.id === dep)?.status ?? "todo"));
		if (pending.length) errors.push(`${item.id}: dependencies not done: ${pending.join(", ")}`);
		const doing = ledger.items.filter((other) => other.status === "doing" && other.id !== item.id).length;
		if (doing >= ledger.wipLimit) errors.push(`${item.id}: WIP limit ${ledger.wipLimit} reached (${doing} doing)`);
	} else if (request.worker !== undefined) errors.push(`${item.id}: worker is only set when moving to doing`);
	if ((request.to === "blocked" || request.to === "excluded" || request.to === "todo") && !request.reason?.trim()) errors.push(`${item.id}: ${request.to} needs a reason`);
	if (request.to === "review" || request.to === "done") {
		const commit = request.commit ?? item.commit;
		if (!commit) errors.push(`${item.id}: ${request.to} needs the commit that delivers it`);
		else if (!COMMIT.test(commit)) errors.push(`${item.id}: commit ${commit} is not a hex object id`);
		else if (facts.commit !== undefined) {
			if (!facts.commit.exists) errors.push(`${item.id}: commit ${commit} does not exist in ${ledger.repo}`);
			else if (request.to === "done" && facts.commit.reachable === false) errors.push(`${item.id}: commit ${commit} is not reachable from ${ledger.integrationRef}`);
		}
		const current = worker(item.worker);
		if (current?.status === "running") errors.push(`${item.id}: worker ${item.worker} is still running; collect its result first`);
		if (request.to === "done" && commit && COMMIT.test(commit)) {
			for (const check of requiredChecks(ledger, item)) {
				const runs = item.runs.filter((run) => run.check === check && sameCommit(run.commit, commit));
				const last = runs.at(-1);
				if (!last) errors.push(`${item.id}: required check ${check} has no run on ${commit}`);
				else if (!last.passed) errors.push(`${item.id}: latest run of required check ${check} on ${commit} did not pass (exit ${last.exitCode}${last.invalid ? `, ${last.invalid}` : ""})`);
			}
		}
	}
	return errors;
}

/** Abbreviated and full ids of one object compare by prefix; both are lowercase hex. */
export function sameCommit(a: string, b: string): boolean {
	return a.length <= b.length ? b.startsWith(a) : a.startsWith(b);
}

export function addItemsErrors(ledger: Ledger, items: readonly { id: string; deps?: readonly string[]; checks?: readonly string[] }[]): string[] {
	const errors: string[] = [];
	const known = new Set(ledger.items.map((item) => item.id));
	const batch = new Set<string>();
	for (const item of items) {
		if (!ID.test(item.id)) errors.push(`item id ${JSON.stringify(item.id)} must match ${ID}`);
		if (known.has(item.id) || batch.has(item.id)) errors.push(`duplicate item ${item.id}`);
		batch.add(item.id);
		for (const check of item.checks ?? []) if (!(check in ledger.checks)) errors.push(`${item.id}: unknown check ${check}`);
	}
	const all = new Set([...known, ...batch]);
	for (const item of items) for (const dep of item.deps ?? []) if (!all.has(dep)) errors.push(`${item.id}: unknown dependency ${dep}`);
	if (errors.length) return errors;
	const deps = new Map<string, readonly string[]>([...ledger.items.map((item): [string, readonly string[]] => [item.id, item.deps]), ...items.map((item): [string, readonly string[]] => [item.id, item.deps ?? []])]);
	const cycle = findCycle(deps);
	if (cycle) errors.push(`dependency cycle: ${cycle.join(" -> ")}`);
	return errors;
}

function findCycle(deps: ReadonlyMap<string, readonly string[]>): string[] | undefined {
	const state = new Map<string, 1 | 2>();
	const path: string[] = [];
	const visit = (id: string): string[] | undefined => {
		if (state.get(id) === 2) return undefined;
		if (state.get(id) === 1) return [...path.slice(path.indexOf(id)), id];
		state.set(id, 1);
		path.push(id);
		for (const dep of deps.get(id) ?? []) {
			const found = visit(dep);
			if (found) return found;
		}
		path.pop();
		state.set(id, 2);
		return undefined;
	};
	for (const id of deps.keys()) {
		const found = visit(id);
		if (found) return found;
	}
	return undefined;
}

export function ready(ledger: Ledger): Item[] {
	const status = new Map(ledger.items.map((item) => [item.id, item.status]));
	return ledger.items.filter((item) => item.status === "todo" && item.deps.every((dep) => TERMINAL.has(status.get(dep) ?? "todo")));
}

/** Longest dependency chain (item count) among items that are not final. */
export function criticalPath(ledger: Ledger): number {
	const open = new Map(ledger.items.filter((item) => !TERMINAL.has(item.status)).map((item) => [item.id, item]));
	const memo = new Map<string, number>();
	const depth = (id: string): number => {
		const known = memo.get(id);
		if (known !== undefined) return known;
		const item = open.get(id);
		if (!item) return 0;
		memo.set(id, 1); // acyclic by construction; guards a corrupted file
		const value = 1 + Math.max(0, ...item.deps.map(depth));
		memo.set(id, value);
		return value;
	};
	return Math.max(0, ...[...open.keys()].map(depth));
}

export type Progress = {
	readonly total: number;
	readonly counts: Readonly<Record<ItemStatus, number>>;
	readonly percentDone: number;
	readonly ready: readonly string[];
	readonly doing: readonly { readonly id: string; readonly worker?: string }[];
	readonly blocked: readonly { readonly id: string; readonly reason?: string }[];
	readonly criticalPath: number;
	readonly eta?: {
		readonly hours: number;
		readonly basis: string;
		readonly throughputPerHour: number;
		readonly medianItemHours?: number;
	};
};

const HOUR = 3_600_000;

/**
 * Counts, the ready frontier and an ETA from recorded timestamps only: remaining / throughput over the last
 * `windowHours` of done items, but never less than the critical path times the median item duration.
 */
export function progress(ledger: Ledger, now: number, windowHours = 6): Progress {
	const active = ledger.items.filter((item) => item.status !== "excluded");
	const counts = Object.fromEntries(ITEM_STATUSES.map((status) => [status, ledger.items.filter((item) => item.status === status).length])) as Record<ItemStatus, number>;
	const done = active.filter((item) => item.status === "done");
	const remaining = active.length - done.length;
	const base = {
		total: active.length,
		counts,
		percentDone: active.length === 0 ? 100 : Math.round((1000 * done.length) / active.length) / 10,
		ready: ready(ledger).map((item) => item.id),
		doing: ledger.items.filter((item) => item.status === "doing").map((item) => ({ id: item.id, ...(item.worker ? { worker: item.worker } : {}) })),
		blocked: ledger.items.filter((item) => item.status === "blocked").map((item) => ({ id: item.id, ...(item.reason ? { reason: item.reason } : {}) })),
		criticalPath: criticalPath(ledger),
	};
	if (remaining === 0 || done.length === 0) return base;
	const recent = done.filter((item) => (item.doneAt ?? 0) >= now - windowHours * HOUR);
	const first = Math.min(...active.map((item) => item.startedAt ?? item.createdAt));
	const [count, hours, label] = recent.length >= 3 ? [recent.length, windowHours, `last ${windowHours}h`] : [done.length, Math.max((now - first) / HOUR, 1 / 60), "since start"];
	const throughput = count / hours;
	const durations = done.flatMap((item) => (item.startedAt !== undefined && item.doneAt !== undefined ? [(item.doneAt - item.startedAt) / HOUR] : [])).sort((a, b) => a - b);
	const median = durations.length ? durations[Math.floor(durations.length / 2)]! : undefined;
	const byRate = remaining / throughput;
	const byPath = median === undefined ? 0 : base.criticalPath * median;
	const hoursLeft = Math.max(byRate, byPath);
	return {
		...base,
		eta: {
			hours: Math.round(hoursLeft * 10) / 10,
			basis: byPath > byRate ? `critical path ${base.criticalPath} x median ${median!.toFixed(2)}h` : `${remaining} remaining / ${throughput.toFixed(2)} per hour (${label})`,
			throughputPerHour: Math.round(throughput * 100) / 100,
			...(median !== undefined ? { medianItemHours: Math.round(median * 100) / 100 } : {}),
		},
	};
}

export type Finding = { readonly rule: "unrecorded_worker" | "orphan_doing" | "idle_capacity" | "all_final" | "integrity"; readonly text: string };

/**
 * What must happen before the owner may end its turn. Pure: `subagents` are the owner's subagents from host records.
 * - unrecorded_worker: an item is doing but its worker finished; record review/done/blocked/todo.
 * - orphan_doing: an item is doing with a worker the host does not know.
 * - idle_capacity: fewer running workers than the WIP limit while ready items wait.
 * - all_final: every item is done/excluded but the ledger is still active.
 */
export function turnFindings(ledger: Ledger, subagents: readonly { readonly taskId: string; readonly status: string }[]): Finding[] {
	if (ledger.status !== "active") return [];
	const findings: Finding[] = [];
	const byId = new Map(subagents.map((agent) => [agent.taskId, agent]));
	for (const item of ledger.items.filter((candidate) => candidate.status === "doing")) {
		const agent = item.worker === undefined ? undefined : byId.get(item.worker);
		if (!agent) findings.push({ rule: "orphan_doing", text: `${item.id} is doing with worker ${item.worker ?? "(none)"}, which is not a subagent of this conversation: requeue it (pm_transition to todo with a reason) or restart it` });
		else if (agent.status !== "running") findings.push({ rule: "unrecorded_worker", text: `${item.id}: worker ${item.worker} ${agent.status}; collect its answer (task_output) and record it with pm_transition (review/done with commit and checks, blocked or todo with a reason)` });
	}
	const running = ledger.items.filter((item) => item.status === "doing" && byId.get(item.worker ?? "")?.status === "running").length;
	const frontier = ready(ledger);
	if (frontier.length > 0 && running < ledger.wipLimit && !findings.length) {
		const slots = Math.min(ledger.wipLimit - running, frontier.length);
		findings.push({ rule: "idle_capacity", text: `${running}/${ledger.wipLimit} workers running and ${frontier.length} items are ready (${frontier.slice(0, 8).map((item) => item.id).join(", ")}${frontier.length > 8 ? ", ..." : ""}): start ${slots} more (task with run_in_background, then pm_transition to doing with the worker taskId), or pause the ledger with a reason` });
	}
	if (ledger.items.length > 0 && ledger.items.every((item) => TERMINAL.has(item.status))) findings.push({ rule: "all_final", text: `every item is done or excluded: run the final integration check, then close the ledger (pm_set_status closed)` });
	return findings;
}

export function renderMarkdown(ledger: Ledger, now: number): string {
	const p = progress(ledger, now);
	const cell = (value: string | undefined) => (value ?? "").replaceAll("|", "\\|").replaceAll("\n", " ");
	const lines = [
		`# ${ledger.title}`,
		"",
		`Generated from pm ledger \`${ledger.id}\` at ${new Date(now).toISOString()}. Do not edit: the ledger is authoritative.`,
		"",
		`- Status: ${ledger.status}, WIP limit ${ledger.wipLimit}`,
		`- Progress: ${p.counts.done}/${p.total} done (${p.percentDone}%), ${p.counts.doing} doing, ${p.counts.review} review, ${p.counts.blocked} blocked, ${p.counts.todo} todo, ${p.counts.excluded} excluded`,
		`- Critical path: ${p.criticalPath}${p.eta ? `, ETA ${p.eta.hours}h (${p.eta.basis})` : ""}`,
		"",
		"| ID | Title | Area | Deps | Status | Worker | Commit | Checks |",
		"|---|---|---|---|---|---|---|---|",
		...ledger.items.map((item) => {
			const checks = requiredChecks(ledger, item).map((check) => {
				const last = item.runs.filter((run) => run.check === check && item.commit !== undefined && sameCommit(run.commit, item.commit)).at(-1);
				return `${check}:${last ? (last.passed ? "pass" : "fail") : "-"}`;
			});
			return `| ${cell(item.id)} | ${cell(item.title)} | ${cell(item.area)} | ${cell(item.deps.join(", "))} | ${item.status}${item.reason ? ` (${cell(item.reason)})` : ""} | ${cell(item.worker)} | ${cell(item.commit)} | ${checks.join(" ")} |`;
		}),
		"",
		"## Decisions",
		...(ledger.decisions.length ? ledger.decisions.map((decision) => `- ${decision.id} (${new Date(decision.at).toISOString().slice(0, 10)}) ${decision.text}${decision.items.length ? ` [${decision.items.join(", ")}]` : ""}`) : ["- none"]),
		"",
	];
	return lines.join("\n");
}
