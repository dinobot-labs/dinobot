import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { protocolHttp } from "./fixtures/protocol-http.ts";
import { reportProtocol, uploadedContent } from "./fixtures/report-protocol.ts";
import { type ClientApi, startClientApi } from "../src/api/server.ts";
import type { AuthService } from "../src/auth/types.ts";
import { createCommands } from "../src/commands/index.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { CONSENT_VERSION } from "../src/report/consent.ts";
import { createReportService } from "../src/report/daemon.ts";

/** ADR 0103 daemon client API: GET/POST /v1/report/consent and POST /v1/report with diagnostics, live state and the thread. */

const context = BACKGROUND_CONTEXT;
const ORIGIN = "https://report.test";
let dir: string | undefined;
let bot: Bot | undefined;
let api: ClientApi | undefined;
afterEach(async () => {
	await api?.stop();
	await bot?.close(context);
	if (dir) await rm(dir, { recursive: true, force: true });
	dir = bot = api = undefined;
});

test("consent and one-step report through the client API", async () => {
	dir = await mkdtemp(join(tmpdir(), "dinobot-report-api-"));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	bot = await openBot({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [] }, context);
	const env = reportProtocol();
	const serverFetch = protocolHttp((request) => env.handle(request));
	const service = createReportService(bot, dir, "0.9.1", context, { url: ORIGIN, fetch: serverFetch }, { live: async () => ({ pid: process.pid, channels: ["telegram"], busy: [] }) });
	const fakeAuth = { providers: async () => [], status: async () => [], accounts: async () => [] } as unknown as AuthService;
	api = startClientApi(bot, 0, context, createCommands({ bot, models, auth: fakeAuth, plugins: [], report: service }), service);
	const url = (path: string) => new URL(path, api!.url).toString();
	const post = (path: string, body: unknown) => fetch(url(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

	const before = (await (await fetch(url("/v1/report/consent"))).json()) as Record<string, unknown>;
	expect(before).toMatchObject({ version: CONSENT_VERSION, consented: false, auto: false });
	expect(String(before.text)).toContain("진단 정보(보고할 때만)");
	expect(String(before.text)).toContain("보고 버튼(데스크톱)과 dinobot report 명령");
	expect(before.textSha256).toMatch(/^[0-9a-f]{64}$/);

	const refused = await post("/v1/report", { trigger: "button", client: "desktop" });
	expect(refused.status).toBe(403);
	expect(await refused.json()).toMatchObject({ error: "consent_required" });

	expect((await post("/v1/report/consent", { version: "report-consent-ko-v1", collect: true, transfer: true, age14: true })).status).toBe(409);
	expect((await post("/v1/report/consent", { version: CONSENT_VERSION, collect: true, transfer: false, age14: true })).status).toBe(400);
	const agreed = await post("/v1/report/consent", { version: CONSENT_VERSION, collect: true, transfer: true, age14: true, auto: false });
	expect(agreed.status).toBe(200);
	expect(((await agreed.json()) as { receipt: { version: string } }).receipt.version).toBe(CONSENT_VERSION);
	expect(((await (await fetch(url("/v1/report/consent"))).json()) as { consented: boolean }).consented).toBe(true);

	expect((await post("/v1/report", { trigger: "bogus" })).status).toBe(400);
	expect((await post("/v1/report", { channel: "tui" })).status).toBe(400);

	// A thread that does not exist is reported as such and not created.
	const missing = (await (await post("/v1/report", { trigger: "button", client: "desktop", channel: "tui", thread: "never" })).json()) as { status: string; entries: number; diagnostics: number };
	expect(missing).toMatchObject({ status: "sent" });
	expect(missing.entries).toBe(missing.diagnostics);
	expect(((await (await fetch(url("/v1/threads"))).json()) as { threads: Array<{ key: string }> }).threads.map((t) => t.key)).not.toContain("tui:never");

	faux.setResponses([fauxAssistantMessage("텔레그램을 붙였습니다")]);
	await bot.handle({ channel: "tui", threadKey: "main", messageId: crypto.randomUUID(), userId: "local", text: "텔레그램 연결해 줘" }, context);
	const res = await post("/v1/report", { trigger: "button", client: "desktop", note: "연결하자마자 끊겨요", channel: "tui", thread: "main", context: { appVersion: "1.2.3", lastDaemonFailure: "exit 1" } });
	expect(res.status).toBe(200);
	const result = (await res.json()) as { id: string; shortId: string; status: string; entries: number; diagnostics: number; compressedBytes: number; redactions: Record<string, number> };
	expect(result).toMatchObject({ status: "sent", shortId: result.id.slice(0, 8) });
	expect(result.entries).toBeGreaterThan(result.diagnostics);
	expect(result.compressedBytes).toBeGreaterThan(0);

	const state = JSON.parse(await readFile(join(dir, "report", "state.json"), "utf8")) as { reports: Array<{ id: string; deleteToken: string }> };
	const token = state.reports.find((r) => r.id === result.id)!.deleteToken;
	const content = await uploadedContent(env, result.id, token);
	const lines = content.trim().split("\n").map((line) => JSON.parse(line) as { kind?: string; section?: string; data?: Record<string, unknown>; trigger?: unknown });
	expect(lines[0]).toMatchObject({ kind: "manual", tier: "T2", trigger: { rule: "button" } });
	const sections = lines.filter((line) => line.kind === "diagnostic").map((line) => line.section);
	expect(sections).toEqual(expect.arrayContaining(["report", "live", "context", "config", "daemon"]));
	expect(lines.find((line) => line.section === "report")!.data).toMatchObject({ mode: "daemon", client: "desktop" });
	expect(lines.find((line) => line.section === "context")!.data).toMatchObject({ client: { appVersion: "1.2.3" } });
	expect(lines.some((line) => line.kind === "pi.user")).toBe(true);
	expect(lines.some((line) => line.kind === "pi.assistant")).toBe(true);
});
