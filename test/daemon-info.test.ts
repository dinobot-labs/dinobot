import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type ClientApi, startClientApi } from "../src/api/server.ts";
import type { AuthService } from "../src/auth/types.ts";
import { createCommands } from "../src/commands/index.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { busyThreads, type DaemonControl, type DaemonInfo, type DaemonOwner } from "../src/core/daemon-info.ts";
import type { SessionStatus, SessionsSnapshot } from "../src/core/sessions.ts";
import { readSetupState, writeSetupState } from "../src/setup/state.ts";
import { ApiClient, HttpError } from "../src/tui/client.ts";

const context = BACKGROUND_CONTEXT;

function session(thread: string, patch: Partial<SessionStatus> = {}): SessionStatus {
	return { thread, conversationId: 1, busy: false, state: "idle", runningTools: [], queued: 0, subagents: [], claims: [], ...patch };
}

function snapshot(...sessions: SessionStatus[]): SessionsSnapshot {
	return { at: 0, sessions, claims: [] };
}

describe("busyThreads", () => {
	test("no sessions and idle sessions are not busy", () => {
		expect(busyThreads(snapshot())).toEqual([]);
		expect(busyThreads(snapshot(session("tui:a"), session("slack:b", { lastActivityAt: 5 })))).toEqual([]);
	});

	test("a running run, queued input or a running subagent each make a thread busy", () => {
		const result = busyThreads(snapshot(
			session("tui:idle"),
			session("tui:run", { busy: true, state: "generating" }),
			session("tui:queued", { queued: 1 }),
			session("tui:subagent", { subagents: [{ taskId: "t1", description: "d", subagentType: "general", startedAt: 1 }] }),
		));
		expect(result).toEqual(["tui:run", "tui:queued", "tui:subagent"]);
	});
});

describe("setup state", () => {
	let dir: string | undefined;
	afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

	test("missing or invalid files read as {}; writes are atomic 0600 JSON", async () => {
		dir = await mkdtemp(join(tmpdir(), "dinobot-setup-state-"));
		expect(await readSetupState(dir)).toEqual({});
		await writeFile(join(dir, "setup.json"), "not json");
		expect(await readSetupState(dir)).toEqual({});
		await writeFile(join(dir, "setup.json"), "[1]");
		expect(await readSetupState(dir)).toEqual({});
		await writeFile(join(dir, "setup.json"), JSON.stringify({ startedAt: 5, completedAt: "2026-01-01T00:00:00.000Z" }));
		expect(await readSetupState(dir)).toEqual({ completedAt: "2026-01-01T00:00:00.000Z" });

		await writeSetupState(dir, { startedAt: "2026-01-02T00:00:00.000Z" });
		expect(await readSetupState(dir)).toEqual({ startedAt: "2026-01-02T00:00:00.000Z" });
		expect(JSON.parse(await readFile(join(dir, "setup.json"), "utf8"))).toEqual({ startedAt: "2026-01-02T00:00:00.000Z" });
		if (process.platform !== "win32") expect((await stat(join(dir, "setup.json"))).mode & 0o777).toBe(0o600);
		const nested = join(dir, "nested", "data");
		await writeSetupState(nested, { startedAt: "a", completedAt: "b" });
		expect(await readSetupState(nested)).toEqual({ startedAt: "a", completedAt: "b" });
	});
});

const fakeAuth: AuthService = {
	credentials: {} as AuthService["credentials"],
	providers: async () => [],
	login: async () => { throw new Error("no login"); },
	logout: async () => false,
	status: async () => [],
	accounts: async () => [],
	useAccount: async () => { throw new Error("no accounts"); },
};

describe("client API daemon routes", () => {
	let dir: string | undefined;
	let bot: Bot | undefined;
	let api: ClientApi | undefined;

	afterEach(async () => {
		await api?.stop();
		await bot?.close(context);
		if (dir !== undefined) await rm(dir, { recursive: true, force: true });
		dir = bot = api = undefined;
	});

	async function start(owner?: DaemonOwner, startSuccessor?: DaemonControl["startSuccessor"]) {
		dir = await mkdtemp(join(tmpdir(), "dinobot-daemon-info-"));
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		bot = await openBot({
			storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")),
			models,
			defaultModel: { provider: "faux", modelId: "faux-1" },
			toolMode: "direct",
			plugins: [],
		}, context);
		const commands = createCommands({ bot, models, auth: fakeAuth, plugins: [], disabled: ["skills"] });
		const shutdowns: string[] = [];
		const control: DaemonControl | undefined = owner === undefined ? undefined : {
			info: async () => ({
				pid: process.pid, version: "9.9.9", manifestPath: "/etc/dinobot.yaml", manifestSha256: "ab".repeat(32),
				owner, startedAt: "2026-01-01T00:00:00.000Z", setup: { startedAt: "2026-01-01T00:00:01.000Z" },
			}),
			shutdown: (reason) => { shutdowns.push(reason); },
			...(startSuccessor ? { startSuccessor } : {}),
		};
		api = startClientApi(bot, 0, context, commands, undefined, control);
		return { faux, shutdowns, client: new ApiClient(api.url) };
	}

	const shutdown = (body: unknown) => fetch(new URL("/v1/daemon/shutdown", api!.url), {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
	});

	test("without control both routes are 404 and the client reports an older daemon", async () => {
		const { client } = await start();
		const info = await fetch(new URL("/v1/daemon", api!.url));
		expect(info.status).toBe(404);
		expect(await info.json()).toHaveProperty("error");
		expect((await shutdown({ pid: process.pid })).status).toBe(404);
		expect(await client.daemonInfo()).toBeUndefined();
		const error = await client.shutdownDaemon(process.pid).catch((failure: unknown) => failure);
		expect(error).toBeInstanceOf(HttpError);
		expect(error).toMatchObject({ status: 404 });
	});

	test("GET reports identity, setup and no busy threads when idle", async () => {
		const { client } = await start("tui");
		const expected: DaemonInfo = {
			pid: process.pid, version: "9.9.9", manifestPath: "/etc/dinobot.yaml", manifestSha256: "ab".repeat(32),
			owner: "tui", startedAt: "2026-01-01T00:00:00.000Z", busy: [], setup: { startedAt: "2026-01-01T00:00:01.000Z" },
		};
		const response = await fetch(new URL("/v1/daemon", api!.url));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(expected);
		expect(await client.daemonInfo()).toEqual(expected);
	});

	test("bad bodies are 400 and never stop", async () => {
		const { shutdowns } = await start("tui");
		for (const body of [null, {}, { pid: "1" }, { pid: 1.5 }, { pid: -1 }, { pid: 0 }]) {
			expect((await shutdown(body)).status).toBe(400);
		}
		const raw = await fetch(new URL("/v1/daemon/shutdown", api!.url), { method: "POST", body: "{" });
		expect(raw.status).toBe(400);
		await Bun.sleep(200);
		expect(shutdowns).toEqual([]);
	});

	test("an external daemon refuses to stop", async () => {
		const { shutdowns, client } = await start("external");
		const response = await shutdown({ pid: process.pid });
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ status: "refused", error: "external" });
		expect(await client.shutdownDaemon(process.pid)).toEqual({ status: "refused", error: "external" });
		await Bun.sleep(200);
		expect(shutdowns).toEqual([]);
	});

	test("a pid that is not this process is refused", async () => {
		const { shutdowns, client } = await start("tui");
		const response = await shutdown({ pid: process.pid + 1 });
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ status: "refused", error: "pid" });
		expect(await client.shutdownDaemon(process.pid + 1)).toEqual({ status: "refused", error: "pid" });
		await Bun.sleep(200);
		expect(shutdowns).toEqual([]);
	});

	test("a thread with a running answer refuses the stop and is listed as busy", async () => {
		const { faux, shutdowns, client } = await start("tui");
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		faux.setResponses([async () => { started.resolve(); await release.promise; return fauxAssistantMessage("done"); }]);
		await client.send("tui", "work", "hello", "local");
		await started.promise;
		try {
			expect((await client.daemonInfo())?.busy).toEqual(["tui:work"]);
			expect(await client.shutdownDaemon(process.pid)).toEqual({ status: "refused", error: "busy", busy: ["tui:work"] });
			await Bun.sleep(200);
			expect(shutdowns).toEqual([]);
		} finally { release.resolve(); }
		const deadline = Date.now() + 10_000;
		while ((await client.daemonInfo())?.busy.length && Date.now() < deadline) await Bun.sleep(25);
		expect((await client.daemonInfo())?.busy).toEqual([]);
	});

	test("an idle TUI-owned daemon answers 202 and stops once, after the response", async () => {
		const { shutdowns, client } = await start("tui");
		const response = await shutdown({ pid: process.pid });
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ status: "stopping" });
		// The stop is deferred so the response flushes first.
		expect(shutdowns).toEqual([]);
		// A repeated request while stopping does not schedule a second stop.
		expect(await client.shutdownDaemon(process.pid)).toEqual({ status: "stopping" });
		await Bun.sleep(300);
		expect(shutdowns).toEqual(["restart requested"]);
	});

	const restart = (body: unknown) => fetch(new URL("/v1/daemon/restart", api!.url), {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
	});

	test("restart is 404 for a daemon without successor support and 400 for bad bodies", async () => {
		await start("external");
		expect((await restart({ pid: process.pid })).status).toBe(404);
		await api!.stop(); await bot!.close(context); await rm(dir!, { recursive: true, force: true });
		let calls = 0;
		const { shutdowns } = await start("external", async () => { calls++; return { ok: true, pid: 4242 }; });
		for (const body of [{}, { pid: "1" }, { pid: 0 }, null]) expect((await restart(body)).status).toBe(400);
		expect(calls).toBe(0);
		expect(shutdowns).toEqual([]);
	});

	test("an external daemon restarts: the successor starts first, then this daemon stops once", async () => {
		const order: string[] = [];
		let ready!: () => void;
		const { shutdowns, client } = await start("external", async () => {
			order.push("successor");
			await new Promise<void>((resolve) => { ready = resolve; });
			return { ok: true, pid: 4242 };
		});
		const pending = restart({ pid: process.pid });
		while (order.length === 0) await Bun.sleep(5);
		// While the successor is starting, neither a second restart nor a plain shutdown may run.
		const second = await restart({ pid: process.pid });
		expect(second.status).toBe(409);
		expect(await second.json()).toEqual({ status: "refused", error: "stopping" });
		expect(shutdowns).toEqual([]);
		ready();
		const response = await pending;
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ status: "restarting", successorPid: 4242, busy: [] });
		expect(shutdowns).toEqual([]);
		await Bun.sleep(300);
		expect(shutdowns).toEqual(["restart requested by update"]);
		expect(order).toEqual(["successor"]);
		expect((await restart({ pid: process.pid })).status).toBe(409);
		expect(await client.shutdownDaemon(process.pid)).toEqual({ status: "refused", error: "external" });
	});

	test("a TUI shutdown is refused while a restart waits for its successor", async () => {
		let ready!: () => void;
		let calls = 0;
		const { shutdowns, client } = await start("tui", async () => { calls++; await new Promise<void>((resolve) => { ready = resolve; }); return { ok: false, error: "successor", detail: "boom" }; });
		const pending = restart({ pid: process.pid });
		while (calls === 0) await Bun.sleep(5);
		expect(await client.shutdownDaemon(process.pid)).toEqual({ status: "refused", error: "busy", busy: [] });
		ready();
		expect((await pending).status).toBe(500);
		// The failed restart released the guard: a later shutdown works normally.
		expect(await client.shutdownDaemon(process.pid)).toEqual({ status: "stopping" });
		await Bun.sleep(300);
		expect(shutdowns).toEqual(["restart requested"]);
	});

	test("a wrong pid, a supervised daemon and a failed successor never stop this daemon", async () => {
		let next: Awaited<ReturnType<NonNullable<DaemonControl["startSuccessor"]>>> = { ok: false, error: "supervised", supervisor: { kind: "systemd", unit: "dinobot.service" } };
		const { shutdowns } = await start("external", async () => next);
		const wrong = await restart({ pid: process.pid + 1 });
		expect(wrong.status).toBe(409);
		expect(await wrong.json()).toEqual({ status: "refused", error: "pid" });
		const supervised = await restart({ pid: process.pid });
		expect(supervised.status).toBe(409);
		expect(await supervised.json()).toEqual({ status: "refused", error: "supervised", supervisor: { kind: "systemd", unit: "dinobot.service" } });
		next = { ok: false, error: "successor", detail: "the new daemon exited (code 1) before it was ready; see the daemon log" };
		const failed = await restart({ pid: process.pid });
		expect(failed.status).toBe(500);
		expect(await failed.json()).toEqual({ status: "failed", error: "successor", detail: next.detail });
		await Bun.sleep(300);
		expect(shutdowns).toEqual([]);
	});
});
