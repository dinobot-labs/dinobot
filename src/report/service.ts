import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { JsonValue } from "@earendil-works/chord";
import { projectEntries, type Projection, type Tier } from "./bundle.ts";
import { CONSENT_TEXT, CONSENT_TEXT_SHA256, CONSENT_VERSION, type ConsentReceipt, currentReceipt, DEFAULT_REPORT_URL, newReceipt } from "./consent.ts";
import type { DetectionRule } from "./detect.ts";
import type { ReportClient, ReportMode } from "./diagnostics.ts";
import { pidAlive } from "./diagnostics.ts";
import { redactValue, type RedactionCounts } from "./redact.ts";

/**
 * Client side of dinobot session reports (ADR 0073). State lives in `<dataDir>/report/`:
 * `state.json` (install identity, consent receipts, outbox and sent records; mode 0600) and
 * `outbox/<id>.gz` (built bundles awaiting upload). Nothing leaves the machine without a current
 * consent receipt of the person the report belongs to; the YAML config cannot enable reporting.
 */

export const SCHEMA = "dinobot.report/v1";
export const CONTENT_TYPE = "application/vnd.dinobot.report+gzip";
export const AUTO_DELAY_MS = 30_000;
export const AUTO_COOLDOWN_MS = 30 * 60_000;
export const AUTO_DAILY_MAX = 10;
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000] as const;
export const SENT_RETENTION_MS = 90 * 86_400_000;
const LIMIT_COMPRESSED = 10 * 1024 * 1024;
const LIMIT_ENTRIES = 20_000;
const LIMIT_LINE = 512 * 1024;
const NOTE_CHARS = 2_000;
/** Cross-process state lock (ADR 0103): the daemon and an offline `dinobot report` share state.json. */
export const STATE_LOCK_STALE_MS = 30_000;
const STATE_LOCK_WAIT_MS = 20_000;

/** "owner" is the local TUI owner (install-wide); "<channel>:<userId>" a person in a messenger channel. */
export type Owner = "owner" | `${string}:${string}`;

export type ReportStatus = "draft" | "pending" | "sent" | "failed" | "deleted";

export type ReportRecord = {
	id: string;
	owner: Owner;
	kind: "manual" | "auto";
	tier: Tier;
	channel: string;
	threadKey: string;
	reporter: string;
	excludeOthers: boolean;
	trigger?: { rule: string; entryId?: string };
	note?: string;
	deleteToken: string;
	status: ReportStatus;
	createdAt: string;
	notBefore: string;
	attempts: number;
	nextAttemptAt?: string;
	sentAt?: string;
	error?: string;
	/** Bundle file under outbox/ once built (manual: at preview; auto: at send time). */
	bundle?: string;
	redactions?: Record<string, number>;
	entries?: number;
	/** The thread's model ref when the bundle was built. */
	model?: string;
	/** Number of leading diagnostic lines in the bundle; kept when the bundle is trimmed to the size limit. */
	diagnostics?: number;
	client?: string;
};

type State = {
	version: 1;
	install?: { id: string; key: string };
	owner?: ConsentReceipt;
	auto: boolean;
	withdrawnAt?: string;
	users: Record<string, ConsentReceipt>;
	reports: ReportRecord[];
	autoHistory: Record<string, string>;
};

export type CaptureResult = { root: number; entries: readonly JsonValue[]; model?: string };

export type ReportServiceOptions = {
	readonly dataDir: string;
	readonly url?: string;
	readonly fetch?: typeof fetch;
	readonly now?: () => Date;
	readonly version: string;
	readonly os?: string;
	/** Visible export of a thread: root conversation id, entries (incl. subagents) and the thread's model ref. Absent offline. */
	readonly capture?: (channel: string, threadKey: string, options?: { mustExist?: boolean }) => Promise<CaptureResult>;
	/** Diagnostic entry lines (src/report/diagnostics.ts), already scrubbed; only for the install owner's manual reports. */
	readonly diagnostics?: (request: DiagnosticRequest) => Promise<{ lines: string[]; redactions: RedactionCounts }>;
	readonly log?: (message: string) => void;
};

export type Preview = {
	readonly id: string;
	readonly path: string;
	readonly entries: number;
	/** Leading diagnostic lines (ADR 0103). */
	readonly diagnostics: number;
	readonly compressedBytes: number;
	readonly redactions: Record<string, number>;
	readonly omitted: Projection["omitted"];
};

export type DiagnosticRequest = { readonly trigger: string; readonly client: ReportClient; readonly mode?: ReportMode; readonly context?: unknown };

export type SubmitInput = {
	readonly owner: Owner;
	readonly trigger: string;
	readonly client: ReportClient;
	readonly note?: string;
	/** With threadKey: the conversation to include when a capture is available (daemon mode). */
	readonly channel?: string;
	readonly threadKey?: string;
	readonly reporter?: string;
	readonly context?: unknown;
};

export type SubmitResult = {
	readonly id: string;
	readonly shortId: string;
	readonly status: "sent" | "pending" | "failed";
	readonly error?: string;
	/** Entry lines in the bundle (diagnostic lines plus conversation entries). */
	readonly entries: number;
	readonly diagnostics: number;
	readonly compressedBytes: number;
	readonly redactions: Record<string, number>;
};

export class ConsentRequiredError extends Error {
	readonly code = "consent_required";
	constructor() {
		super("consent required: agree to the current report consent first (dinobot report consent)");
	}
}

export type ConsentInfo = { version: string; text: string; textSha256: string; consented: boolean; receipt?: ConsentReceipt; auto: boolean };

export type AutoResult = { scheduled: true; id: string; sendAt: string } | { scheduled: false; reason: "no_consent" | "auto_off" | "cooldown" | "daily_limit" };

const token = () => randomBytes(32).toString("base64url");
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const shortId = (id: string) => id.slice(0, 8);
const RULE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
function validRule(rule: string): string {
	if (!RULE.test(rule)) throw new Error(`invalid report trigger ${JSON.stringify(rule.slice(0, 80))}`);
	return rule;
}

export class ReportService {
	private readonly dir: string;
	private readonly statePath: string;
	private readonly outbox: string;
	private readonly url: string;
	private readonly fetch: typeof fetch;
	private readonly now: () => Date;
	private chain: Promise<unknown> = Promise.resolve();
	private timer: ReturnType<typeof setInterval> | undefined;
	private flushing: Promise<void> | undefined;
	private flushAgain = false;
	private readonly uploading = new Set<string>();
	private readonly lockPath: string;

	constructor(private readonly options: ReportServiceOptions) {
		this.dir = join(options.dataDir, "report");
		this.statePath = join(this.dir, "state.json");
		this.outbox = join(this.dir, "outbox");
		this.lockPath = join(this.dir, "state.lock");
		this.url = (options.url ?? DEFAULT_REPORT_URL).replace(/\/+$/, "");
		this.fetch = options.fetch ?? globalThis.fetch;
		this.now = options.now ?? (() => new Date());
	}

	// ---- state ---------------------------------------------------------------------------------

	/**
	 * Serialise every state mutation; reads inside see the latest committed file. In-process calls queue on a promise chain;
	 * across processes (daemon + offline CLI) the load-modify-save runs under `report/state.lock`.
	 */
	private locked<T>(fn: (state: State) => Promise<T> | T): Promise<T> {
		const run = this.chain.then(() =>
			this.withFileLock(async () => {
				const state = await this.load();
				const result = await fn(state);
				await this.save(state);
				return result;
			}),
		);
		this.chain = run.catch(() => undefined);
		return run;
	}

	/**
	 * Exclusive-create lock file holding `{pid, at, nonce}`. A lock is stale when its pid is dead or it is older than
	 * STATE_LOCK_STALE_MS (critical sections take milliseconds). Breaking renames the stale file aside first and checks that
	 * the renamed file is the one judged stale; a fresh lock taken by mistake is linked back (link fails if the path is taken).
	 */
	private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
		const nonce = randomUUID();
		const content = JSON.stringify({ pid: process.pid, at: Date.now(), nonce });
		const deadline = Date.now() + STATE_LOCK_WAIT_MS;
		for (;;) {
			try {
				const handle = await open(this.lockPath, "wx", 0o600);
				try {
					await handle.writeFile(content);
				} finally {
					await handle.close();
				}
				break;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				// Windows reports EPERM/EBUSY while another process renames or deletes the file.
				if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY") throw error;
				if (code === "EEXIST" && (await this.breakStaleLock())) continue;
				if (Date.now() > deadline) throw new Error(`report state is locked by another process (${this.lockPath})`);
				await Bun.sleep(5 + Math.random() * 20);
			}
		}
		try {
			return await fn();
		} finally {
			const current = await readFile(this.lockPath, "utf8").catch(() => undefined);
			if (current === content) await unlink(this.lockPath).catch(() => undefined);
		}
	}

	/** True when the lock path was freed (released meanwhile or a stale lock was removed); false when a live holder has it. */
	private async breakStaleLock(): Promise<boolean> {
		let observed: string;
		let mtimeMs: number;
		try {
			observed = await readFile(this.lockPath, "utf8");
			mtimeMs = (await stat(this.lockPath)).mtimeMs;
		} catch {
			return true;
		}
		let holder: { pid?: unknown; at?: unknown } | undefined;
		try {
			holder = JSON.parse(observed) as { pid?: unknown; at?: unknown };
		} catch {
			holder = undefined; // being written right now, or garbage
		}
		const age = Date.now() - (typeof holder?.at === "number" ? holder.at : mtimeMs);
		const alive = typeof holder?.pid === "number" && pidAlive(holder.pid);
		if (holder ? alive && age <= STATE_LOCK_STALE_MS : age <= STATE_LOCK_STALE_MS) return false;
		const aside = `${this.lockPath}.stale.${randomUUID()}`;
		try {
			await rename(this.lockPath, aside);
		} catch {
			return false;
		}
		const moved = await readFile(aside, "utf8").catch(() => undefined);
		if (moved !== observed) await link(aside, this.lockPath).catch(() => undefined);
		await unlink(aside).catch(() => undefined);
		this.options.log?.(`report: removed a stale state lock (${holder ? `pid ${String(holder.pid)}` : "unreadable"})`);
		return true;
	}

	private async load(): Promise<State> {
		try {
			const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as State;
			if (parsed.version !== 1) throw new Error(`unsupported report state version ${String(parsed.version)}`);
			return { ...parsed, users: parsed.users ?? {}, reports: parsed.reports ?? [], autoHistory: parsed.autoHistory ?? {} };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, auto: false, users: {}, reports: [], autoHistory: {} };
			throw error;
		}
	}

	private async save(state: State): Promise<void> {
		await mkdir(this.outbox, { recursive: true, mode: 0o700 });
		const tmp = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(tmp, JSON.stringify(state, null, "\t"), { mode: 0o600 });
		await rename(tmp, this.statePath);
		await chmod(this.statePath, 0o600).catch(() => undefined);
	}

	private receipt(state: State, owner: Owner): ConsentReceipt | undefined {
		const receipt = owner === "owner" ? state.owner : state.users[owner];
		return currentReceipt(receipt) ? receipt : undefined;
	}

	// ---- consent -------------------------------------------------------------------------------

	async consent(owner: Owner): Promise<{ receipt?: ConsentReceipt; auto: boolean }> {
		return this.locked((state) => {
			const receipt = this.receipt(state, owner);
			return receipt ? { receipt, auto: owner === "owner" && state.auto } : { auto: false };
		});
	}

	/** The current consent text and this owner's receipt (GET /v1/report/consent, `dinobot report consent --json`). */
	async consentInfo(owner: Owner): Promise<ConsentInfo> {
		const { receipt, auto } = await this.consent(owner);
		return { version: CONSENT_VERSION, text: CONSENT_TEXT, textSha256: CONSENT_TEXT_SHA256, consented: receipt !== undefined, ...(receipt ? { receipt } : {}), auto };
	}

	async recordConsent(owner: Owner, auto: boolean): Promise<ConsentReceipt> {
		return this.locked((state) => {
			const receipt = newReceipt(this.now());
			state.install ??= { id: randomUUID(), key: token() };
			if (owner === "owner") {
				state.owner = receipt;
				state.auto = auto;
				delete state.withdrawnAt;
			} else state.users[owner] = receipt;
			return receipt;
		});
	}

	async setAuto(on: boolean): Promise<boolean> {
		return this.locked((state) => {
			if (on && !this.receipt(state, "owner")) return false;
			state.auto = on;
			return true;
		});
	}

	// ---- manual reports ------------------------------------------------------------------------

	/** Build the bundle now so the person can inspect exactly what would be sent. Stays a draft until confirmed. */
	async prepare(input: { owner: Owner; channel: string; threadKey: string; reporter: string; excludeOthers: boolean; note?: string; trigger?: string; context?: unknown }): Promise<Preview> {
		await this.locked((state) => {
			if (!this.receipt(state, input.owner)) throw new Error("consent required: run /report setup first");
		});
		const id = randomUUID();
		const record: ReportRecord = {
			id,
			owner: input.owner,
			kind: "manual",
			tier: "T2",
			channel: input.channel,
			threadKey: input.threadKey,
			reporter: input.reporter,
			excludeOthers: input.excludeOthers,
			...(input.note?.trim() ? { note: input.note.trim().slice(0, NOTE_CHARS) } : {}),
			...(input.trigger ? { trigger: { rule: validRule(input.trigger) } } : {}),
			...(input.owner === "owner" ? { client: "tui" } : {}),
			deleteToken: token(),
			status: "draft",
			createdAt: this.now().toISOString(),
			notBefore: this.now().toISOString(),
			attempts: 0,
		};
		const built = await this.build(record, { context: input.context, mode: "daemon" });
		if (built.projection.entries.length === 0) {
			await this.discard(input.owner, id);
			throw new Error("보낼 대화가 없습니다. 이 대화에는 아직 기록이 없어서 보고를 만들지 않았습니다.");
		}
		await this.locked((state) => {
			state.reports.push({ ...record, bundle: built.file, redactions: built.redactions, entries: built.entries, diagnostics: built.diagnostics, ...(built.model ? { model: built.model } : {}) });
		});
		return { id, path: join(this.outbox, `${id}.preview.ndjson`), entries: built.entries, diagnostics: built.diagnostics, compressedBytes: built.bytes, redactions: built.redactions, omitted: built.projection.omitted };
	}

	/**
	 * One-step report (button, CLI, POST /v1/report): diagnostics plus the conversation when one is named and can be
	 * captured, stored as pending and uploaded at once. A failed upload stays pending for the outbox retries.
	 */
	async submit(input: SubmitInput): Promise<SubmitResult> {
		const rule = validRule(input.trigger);
		await this.locked((state) => {
			if (!this.receipt(state, input.owner)) throw new ConsentRequiredError();
		});
		const now = this.now().toISOString();
		const id = randomUUID();
		const record: ReportRecord = {
			id,
			owner: input.owner,
			kind: "manual",
			tier: "T2",
			channel: input.channel ?? input.client,
			threadKey: input.threadKey ?? "",
			reporter: input.reporter ?? "reporter",
			excludeOthers: input.owner !== "owner",
			trigger: { rule },
			client: input.client,
			...(input.note?.trim() ? { note: input.note.trim().slice(0, NOTE_CHARS) } : {}),
			deleteToken: token(),
			status: "pending",
			createdAt: now,
			notBefore: now,
			attempts: 0,
		};
		const built = await this.build(record, { context: input.context, optionalConversation: true, ...(this.options.capture ? { mode: "daemon" as const } : { mode: "offline" as const }) });
		await this.locked((state) => {
			state.reports.push({ ...record, bundle: built.file, redactions: built.redactions, entries: built.entries, diagnostics: built.diagnostics, ...(built.model ? { model: built.model } : {}) });
		});
		try {
			await this.uploadOne(id);
		} catch (error) {
			this.options.log?.(`report ${shortId(id)}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const after = await this.locked((state) => state.reports.find((r) => r.id === id));
		const status = after?.status === "sent" ? "sent" : after?.status === "pending" ? "pending" : "failed";
		return { id, shortId: shortId(id), status, ...(after?.error && status !== "sent" ? { error: after.error } : {}), entries: built.entries, diagnostics: built.diagnostics, compressedBytes: built.bytes, redactions: built.redactions };
	}

	/** A setup apply that failed within `maxAgeMs` (written by the TUI, src/tui/app.ts recordSetupFailure). */
	async recentSetupFailure(maxAgeMs = 3_600_000): Promise<{ at: string; status: string } | undefined> {
		try {
			const parsed = JSON.parse(await readFile(join(this.dir, "last-setup.json"), "utf8")) as { at?: unknown; status?: unknown };
			if (typeof parsed.at !== "string" || typeof parsed.status !== "string") return undefined;
			return this.now().getTime() - Date.parse(parsed.at) <= maxAgeMs ? { at: parsed.at, status: parsed.status } : undefined;
		} catch {
			return undefined;
		}
	}

	async drafts(owner: Owner): Promise<string[]> {
		return this.locked((state) => state.reports.filter((r) => r.owner === owner && r.status === "draft").map((r) => r.id));
	}

	async confirm(owner: Owner, id: string): Promise<void> {
		await this.locked((state) => {
			const record = state.reports.find((r) => r.id === id && r.owner === owner && r.status === "draft");
			if (!record) throw new Error("no such draft report");
			record.status = "pending";
			record.notBefore = this.now().toISOString();
		});
		await rm(join(this.outbox, `${id}.preview.ndjson`), { force: true });
		void this.flush();
	}

	async discard(owner: Owner, id: string): Promise<void> {
		await this.locked(async (state) => {
			const index = state.reports.findIndex((r) => r.id === id && r.owner === owner && r.status === "draft");
			if (index >= 0) state.reports.splice(index, 1);
		});
		await rm(join(this.outbox, `${id}.gz`), { force: true });
		await rm(join(this.outbox, `${id}.preview.ndjson`), { force: true });
	}

	// ---- automatic reports ---------------------------------------------------------------------

	/** Schedule a bounded T1 report of a TUI thread after a detected frustration signal. */
	async scheduleAuto(input: { channel: string; threadKey: string; reporter: string; rule: DetectionRule }): Promise<AutoResult> {
		return this.locked((state) => {
			if (!this.receipt(state, "owner")) return { scheduled: false, reason: "no_consent" } as const;
			if (!state.auto) return { scheduled: false, reason: "auto_off" } as const;
			const now = this.now();
			const key = `${input.channel}:${input.threadKey}`;
			const last = state.autoHistory[key];
			if (last && now.getTime() - Date.parse(last) < AUTO_COOLDOWN_MS) return { scheduled: false, reason: "cooldown" } as const;
			const today = state.reports.filter((r) => r.kind === "auto" && now.getTime() - Date.parse(r.createdAt) < 86_400_000).length;
			if (today >= AUTO_DAILY_MAX) return { scheduled: false, reason: "daily_limit" } as const;
			const id = randomUUID();
			const sendAt = new Date(now.getTime() + AUTO_DELAY_MS).toISOString();
			state.autoHistory[key] = now.toISOString();
			state.reports.push({
				id,
				owner: "owner",
				kind: "auto",
				tier: "T1",
				channel: input.channel,
				threadKey: input.threadKey,
				reporter: input.reporter,
				excludeOthers: false,
				trigger: { rule: input.rule },
				deleteToken: token(),
				status: "pending",
				createdAt: now.toISOString(),
				notBefore: sendAt,
				attempts: 0,
			});
			return { scheduled: true, id, sendAt } as const;
		});
	}

	// ---- listing, undo, withdrawal -------------------------------------------------------------

	async list(owner: Owner): Promise<ReportRecord[]> {
		return this.locked((state) => {
			this.prune(state);
			return state.reports.filter((r) => (owner === "owner" || r.owner === owner) && r.status !== "draft").map((r) => ({ ...r }));
		});
	}

	/** Cancel a pending report locally, or erase a sent one on the server. Accepts a short id prefix. */
	async undo(owner: Owner, idOrPrefix: string): Promise<{ id: string; result: "cancelled" | "deleted" | "already_deleted" }> {
		const prefix = idOrPrefix.trim().toLowerCase();
		if (prefix.length < 4) throw new Error("give at least the first 4 characters of the report id");
		const record = await this.locked((state) => {
			const matches = state.reports.filter((r) => r.id.startsWith(prefix) && (owner === "owner" || r.owner === owner) && r.status !== "draft");
			if (matches.length === 0) throw new Error(`no report ${prefix}`);
			if (matches.length > 1) throw new Error(`${prefix} matches ${matches.length} reports; give more characters`);
			const found = matches[0]!;
			if (found.status === "pending" || found.status === "failed") {
				found.status = "deleted";
				delete found.bundle;
				return { ...found, local: true as const };
			}
			return { ...found, local: false as const };
		});
		if (record.local) {
			await rm(join(this.outbox, `${record.id}.gz`), { force: true });
			return { id: record.id, result: "cancelled" };
		}
		if (record.status === "deleted") return { id: record.id, result: "already_deleted" };
		const res = await this.fetch(`${this.url}/v1/reports/${record.id}`, { method: "DELETE", headers: { authorization: `Bearer ${record.deleteToken}` } });
		if (res.status !== 204 && res.status !== 404) throw new Error(`delete failed: HTTP ${res.status} ${await res.text()}`);
		await this.locked((state) => {
			const found = state.reports.find((r) => r.id === record.id);
			if (found) found.status = "deleted";
		});
		return { id: record.id, result: "deleted" };
	}

	/**
	 * Withdraw consent. The local owner withdraws for the whole install: the server erases every report
	 * of this install and refuses the old consent. A channel person erases their own reports.
	 */
	async withdraw(owner: Owner): Promise<{ deleted: number }> {
		const snapshot = await this.locked((state) => ({ install: state.install, mine: state.reports.filter((r) => r.owner === owner || owner === "owner").map((r) => ({ ...r })) }));
		let deleted = 0;
		if (owner === "owner") {
			if (snapshot.install) {
				const res = await this.fetch(`${this.url}/v1/installs/${snapshot.install.id}/withdraw`, { method: "POST", headers: { authorization: `Bearer ${snapshot.install.key}` } });
				if (res.status === 200) deleted = ((await res.json()) as { deleted?: number }).deleted ?? 0;
				else if (res.status !== 404) throw new Error(`withdraw failed: HTTP ${res.status} ${await res.text()}`);
			}
		} else {
			for (const record of snapshot.mine.filter((r) => r.status === "sent")) {
				const res = await this.fetch(`${this.url}/v1/reports/${record.id}`, { method: "DELETE", headers: { authorization: `Bearer ${record.deleteToken}` } });
				if (res.status !== 204 && res.status !== 404) throw new Error(`delete ${shortId(record.id)} failed: HTTP ${res.status}`);
				deleted++;
			}
		}
		await this.locked((state) => {
			// Tokens of erased reports are useless; forget the records with their bundles.
			state.reports = owner === "owner" ? [] : state.reports.filter((r) => r.owner !== owner);
			if (owner === "owner") {
				delete state.owner;
				state.users = {};
				state.auto = false;
				state.withdrawnAt = this.now().toISOString();
			} else delete state.users[owner];
		});
		for (const r of snapshot.mine) await rm(join(this.outbox, `${r.id}.gz`), { force: true });
		return { deleted };
	}

	// ---- upload --------------------------------------------------------------------------------

	start(intervalMs = 10_000): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.flush(), intervalMs);
		this.timer.unref?.();
		void this.flush();
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.flushing;
	}

	/**
	 * Upload every due pending report. Concurrent calls share the running pass; a call that arrives
	 * during a pass schedules exactly one more pass, so work queued meanwhile is never skipped.
	 */
	flush(): Promise<void> {
		if (this.flushing) {
			this.flushAgain = true;
			return this.flushing;
		}
		this.flushing = (async () => {
			do {
				this.flushAgain = false;
				await this.flushOnce();
			} while (this.flushAgain);
		})().finally(() => {
			this.flushing = undefined;
		});
		return this.flushing;
	}

	private async flushOnce(): Promise<void> {
		const now = this.now().getTime();
		const due = await this.locked((state) => {
			this.prune(state);
			return state.reports.filter((r) => r.status === "pending" && Date.parse(r.notBefore) <= now && (!r.nextAttemptAt || Date.parse(r.nextAttemptAt) <= now)).map((r) => r.id);
		});
		for (const id of due) {
			try {
				await this.uploadOne(id);
			} catch (error) {
				this.options.log?.(`report ${shortId(id)}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	private async uploadOne(id: string): Promise<void> {
		// submit() and a flush pass may reach the same report; one upload at a time per process.
		if (this.uploading.has(id)) return;
		this.uploading.add(id);
		try {
			await this.uploadOnce(id);
		} finally {
			this.uploading.delete(id);
		}
	}

	private async uploadOnce(id: string): Promise<void> {
		const ready = await this.locked((state) => {
			const record = state.reports.find((r) => r.id === id);
			if (!record || record.status !== "pending") return undefined;
			const receipt = this.receipt(state, record.owner);
			if (!receipt || !state.install) {
				record.status = "failed";
				record.error = "consent missing or outdated";
				return undefined;
			}
			return { record: { ...record }, receipt, install: state.install };
		});
		if (!ready) return;
		let { record } = ready;
		let file = record.bundle;
		if (!file) {
			const built = await this.build(record);
			file = built.file;
			record = { ...record, bundle: file, redactions: built.redactions, entries: built.entries, ...(built.model ? { model: built.model } : {}), ...(built.projection.lastUserEntryId !== undefined && record.trigger ? { trigger: { ...record.trigger, entryId: String(built.projection.lastUserEntryId) } } : {}) };
			const stillPending = await this.locked((state) => {
				const found = state.reports.find((r) => r.id === id);
				if (!found || found.status !== "pending") return false; // undone while building
				Object.assign(found, { bundle: record.bundle, redactions: record.redactions, entries: record.entries, ...(record.model ? { model: record.model } : {}), ...(record.trigger ? { trigger: record.trigger } : {}) });
				return true;
			});
			if (!stillPending) {
				await rm(join(this.outbox, file), { force: true });
				return;
			}
		}
		const body = await this.finalBody(record, ready.receipt, ready.install, file);
		let outcome: { ok: true } | { ok: false; retry: boolean; error: string };
		try {
			const res = await this.fetch(`${this.url}/v1/reports`, {
				method: "POST",
				headers: { "content-type": CONTENT_TYPE, "x-dinobot-body-sha256": sha256(body) },
				body,
			});
			if (res.status === 202 || res.status === 200) outcome = { ok: true };
			else outcome = { ok: false, retry: res.status === 429 || res.status >= 500, error: `HTTP ${res.status} ${(await res.text()).slice(0, 300)}` };
		} catch (error) {
			outcome = { ok: false, retry: true, error: error instanceof Error ? error.message : String(error) };
		}
		await this.locked((state) => {
			const found = state.reports.find((r) => r.id === id);
			if (!found) return;
			if (found.status !== "pending") return; // undone during upload: undo/delete handles the server copy
			if (outcome.ok) {
				found.status = "sent";
				found.sentAt = this.now().toISOString();
				delete found.error;
				delete found.nextAttemptAt;
				delete found.bundle;
			} else {
				found.attempts++;
				found.error = outcome.error;
				const delay = RETRY_DELAYS_MS[found.attempts - 1];
				if (outcome.retry && delay !== undefined) found.nextAttemptAt = new Date(this.now().getTime() + delay).toISOString();
				else found.status = "failed";
			}
		});
		if (outcome.ok) await rm(join(this.outbox, file), { force: true });
		// A report undone while its upload was in flight must not survive on the server.
		const after = await this.locked((state) => state.reports.find((r) => r.id === id));
		if (outcome.ok === false || !after || after.status !== "deleted") return;
		await this.fetch(`${this.url}/v1/reports/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${record.deleteToken}` } }).catch(() => undefined);
	}

	/** Manifest first, then the stored entries; gzip; total size enforced by dropping the oldest entries. */
	private async finalBody(record: ReportRecord, receipt: ConsentReceipt, install: { id: string; key: string }, file: string): Promise<Uint8Array> {
		const entriesText = (await import("node:zlib")).gunzipSync(await readFile(join(this.outbox, file))).toString("utf8");
		const manifest = {
			schema: SCHEMA,
			reportId: record.id,
			installId: install.id,
			installKeySha256: sha256(install.key),
			deleteTokenSha256: sha256(record.deleteToken),
			createdAt: record.createdAt,
			kind: record.kind,
			tier: record.tier,
			trigger: record.trigger ?? null,
			client: { dinobotVersion: this.options.version, os: (this.options.os ?? process.platform).slice(0, 64), ...(record.model && /^[\x20-\x7e]{1,128}$/.test(record.model) ? { model: record.model } : {}) },
			consent: receipt,
			...(record.note ? { note: redactValue(record.note) as string } : {}),
		};
		const all = entriesText === "" ? [] : entriesText.split("\n");
		// Diagnostics lead the bundle and are kept; the conversation is trimmed first, then log parts.
		let head = all.slice(0, record.diagnostics ?? 0);
		let lines = all.slice(record.diagnostics ?? 0);
		for (;;) {
			const body = gzipSync([JSON.stringify(manifest), ...head, ...lines].join("\n") + "\n");
			if (body.byteLength <= LIMIT_COMPRESSED) return new Uint8Array(body);
			if (lines.length > 0) {
				lines = lines.slice(Math.ceil(lines.length / 4)); // keep the most recent three quarters
				continue;
			}
			const log = head.findIndex((line) => line.startsWith('{"kind":"diagnostic","section":"logs"'));
			if (log < 0) return new Uint8Array(body);
			head = [...head.slice(0, log), ...head.slice(log + 1)];
		}
	}

	/**
	 * Diagnostics (the install owner's manual reports only: a channel person cannot consent for the owner's machine), then
	 * the captured, projected conversation; stored as outbox/<id>.gz (entry lines only, no manifest).
	 */
	private async build(record: ReportRecord, extra: { context?: unknown; mode?: ReportMode; optionalConversation?: boolean } = {}): Promise<{ file: string; bytes: number; projection: Projection; redactions: Record<string, number>; entries: number; diagnostics: number; model?: string }> {
		const redactions: Record<string, number> = {};
		const add = (counts: RedactionCounts) => {
			for (const [kind, n] of Object.entries(counts)) redactions[kind] = (redactions[kind] ?? 0) + (n ?? 0);
		};
		let head: string[] = [];
		if (record.kind === "manual" && record.owner === "owner" && this.options.diagnostics) {
			try {
				const collected = await this.options.diagnostics({ trigger: record.trigger?.rule ?? "manual", client: (record.client ?? "tui") as ReportClient, ...(extra.mode ? { mode: extra.mode } : {}), ...(extra.context !== undefined ? { context: extra.context } : {}) });
				head = collected.lines;
				add(collected.redactions);
			} catch (error) {
				head = [JSON.stringify({ kind: "diagnostic", section: "report", error: redactValue(error instanceof Error ? error.message : String(error)) })];
			}
		}
		let projection: Projection = { entries: [], redactions: {}, omitted: { nudges: 0, participants: 0, summaries: 0, truncated: 0, outsideWindow: 0 } };
		let model: string | undefined;
		if (this.options.capture && record.channel && record.threadKey) {
			try {
				const captured = await this.options.capture(record.channel, record.threadKey, extra.optionalConversation ? { mustExist: true } : undefined);
				projection = projectEntries(captured.entries, { tier: record.tier, root: captured.root, reporter: record.reporter, excludeOthers: record.excludeOthers });
				model = captured.model;
			} catch (error) {
				if (!extra.optionalConversation) throw error;
				head.push(JSON.stringify({ kind: "diagnostic", section: "conversation", error: redactValue(error instanceof Error ? error.message : String(error)) }));
			}
		}
		add(projection.redactions);
		let lines = projection.entries.map((entry) => {
			const line = JSON.stringify(entry);
			return line.length <= LIMIT_LINE ? line : JSON.stringify({ id: entry.id, conversationId: entry.conversationId, kind: entry.kind, truncated: true });
		});
		if (lines.length + head.length > LIMIT_ENTRIES) lines = lines.slice(Math.max(0, lines.length - (LIMIT_ENTRIES - head.length)));
		lines = [...head, ...lines];
		const text = lines.join("\n");
		const file = `${record.id}.gz`;
		await mkdir(this.outbox, { recursive: true, mode: 0o700 });
		const gz = gzipSync(text);
		await writeFile(join(this.outbox, file), gz, { mode: 0o600 });
		if (record.status === "draft") await writeFile(join(this.outbox, `${record.id}.preview.ndjson`), text + "\n", { mode: 0o600 });
		return { file, bytes: gz.byteLength, projection, redactions, entries: lines.length, diagnostics: head.length, ...(model ? { model } : {}) };
	}

	/** Forget local records whose server copy has expired anyway; tokens are useless after that. */
	private prune(state: State): void {
		const cutoff = this.now().getTime() - SENT_RETENTION_MS;
		state.reports = state.reports.filter((r) => Date.parse(r.createdAt) >= cutoff || r.status === "pending");
	}
}
