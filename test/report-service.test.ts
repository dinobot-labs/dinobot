import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, stat, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type ClientApi, startClientApi } from "../src/api/server.ts";
import type { AuthService } from "../src/auth/types.ts";
import { createCommands } from "../src/commands/index.ts";
import type { CommandEvent } from "../src/commands/types.ts";
import { type Bot, openBot } from "../src/core/bot.ts";
import { CONSENT_VERSION } from "../src/report/consent.ts";
import { createReportService } from "../src/report/daemon.ts";
import { AUTO_DELAY_MS, AUTO_COOLDOWN_MS, type ReportService } from "../src/report/service.ts";
import { ApiClient } from "../src/tui/client.ts";

import { protocolHttp } from "./fixtures/protocol-http.ts";
import { reportProtocol, uploadedContent } from "./fixtures/report-protocol.ts";
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

/** Real public client and bot against a synthetic loopback HTTP protocol fixture. */
async function setup(options: { failStatus?: number[] } = {}) {
	dir = await mkdtemp(join(tmpdir(), "dinobot-report-"));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
	const models = createModels();
	models.setProvider(faux.provider);
	bot = await openBot({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [] }, context);
	const env = reportProtocol();
	const failures = [...(options.failStatus ?? [])];
	const requests: Array<{ method: string; path: string; status: number }> = [];
	const serverFetch = protocolHttp(async (input) => {
		const request = typeof input === "string" || input instanceof URL ? new Request(input.toString()) : new Request(input);
		const forced = request.method === "POST" && new URL(request.url).pathname === "/v1/reports" ? failures.shift() : undefined;
		const response = forced ? new Response("forced", { status: forced }) : await env.handle(request);
		requests.push({ method: request.method, path: new URL(request.url).pathname, status: response.status });
		return response;
	});
	let nowMs = Date.parse("2026-10-09T12:00:00.000Z");
	const clock = { advance: (ms: number) => (nowMs += ms) };
	const service = createReportService(bot, dir, "0.7.2", context, { url: ORIGIN, fetch: serverFetch, now: () => new Date(nowMs) });
	return { faux, models, env, service, requests, clock, dir };
}

async function converse(text: string, options: { channel?: string; thread?: string; userId?: string; reply?: string } = {}) {
	return bot!.handle({ channel: options.channel ?? "tui", threadKey: options.thread ?? "main", messageId: crypto.randomUUID(), userId: options.userId ?? "roach", text }, context);
}

const serverContent = uploadedContent;

async function localState(root: string) {
	return JSON.parse(await readFile(join(root, "report", "state.json"), "utf8")) as { reports: Array<{ id: string; deleteToken: string; status: string; trigger?: { rule: string; entryId?: string } }>; install?: { id: string } };
}

describe("consent gate", () => {
	test("nothing is prepared, scheduled or sent without a consent receipt", async () => {
		const { service, env } = await setup();
		await expect(service.prepare({ owner: "owner", channel: "tui", threadKey: "main", reporter: "roach", excludeOthers: false })).rejects.toThrow("consent required");
		expect(await service.scheduleAuto({ channel: "tui", threadKey: "main", reporter: "roach", rule: "profanity.ko" })).toEqual({ scheduled: false, reason: "no_consent" });
		expect(await service.setAuto(true)).toBe(false);
		await service.flush();
		expect(env.uploads.size).toBe(0);
	});
});

describe("manual report", () => {
	test("preview → confirm → client uploads its redacted gzip projection over HTTP", async () => {
		const { faux, service, env, dir: root } = await setup();
		faux.setResponses([fauxAssistantMessage("확인했습니다")]);
		await converse("배포가 또 실패했어. OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx 내 번호는 010-2222-3333");
		await service.recordConsent("owner", false);
		const preview = await service.prepare({ owner: "owner", channel: "tui", threadKey: "main", reporter: "roach", excludeOthers: false, note: "연락은 me@example.com" });
		const previewText = await readFile(preview.path, "utf8");
		expect(previewText).toContain("배포가 또 실패했어");
		expect(previewText).not.toContain("sk-proj-abcdefghijklmnopqrstuvwx");
		expect(previewText).not.toContain("010-2222-3333");
		expect(previewText).not.toContain('user=\\"roach\\"');
		expect(env.uploads.size).toBe(0); // a draft sends nothing

		await service.confirm("owner", preview.id);
		await service.flush();
		const state = await localState(root);
		const record = state.reports.find((r) => r.id === preview.id)!;
		expect(record.status).toBe("sent");
		const content = await serverContent(env, preview.id, record.deleteToken);
		const [manifestLine, ...entryLines] = content.trim().split("\n");
		const manifest = JSON.parse(manifestLine!) as Record<string, unknown>;
		expect(manifest).toMatchObject({ kind: "manual", tier: "T2", trigger: null, client: { dinobotVersion: "0.7.2", model: "faux/faux-1" }, consent: { version: CONSENT_VERSION, collect: true, transfer: true, age14: true } });
		expect(String(manifest.note)).not.toContain("me@example.com");
		const entries = entryLines.map((line) => JSON.parse(line) as { kind: string });
		expect(entries.map((e) => e.kind)).toEqual(["pi.user", "pi.assistant"]); // system prompt never included
		expect(content).toContain("확인했습니다");
		expect(content).not.toContain("sk-proj-abcdefghijklmnopqrstuvwx");
		if (process.platform !== "win32") expect((await stat(join(root, "report", "state.json"))).mode & 0o777).toBe(0o600); // POSIX permissions; not Windows ACL acceptance
		await expect(stat(preview.path)).rejects.toThrow(); // preview file removed after confirm
	});

	test("discarded draft is never sent", async () => {
		const { faux, service, env, requests } = await setup();
		faux.setResponses([fauxAssistantMessage("ok")]);
		await converse("hello");
		await service.recordConsent("owner", false);
		const preview = await service.prepare({ owner: "owner", channel: "tui", threadKey: "main", reporter: "roach", excludeOthers: false });
		await service.discard("owner", preview.id);
		await service.flush();
		expect(requests).toHaveLength(0);
		expect(env.uploads.size).toBe(0);
	});
});

describe("automatic report", () => {
	test("waits AUTO_DELAY, honours cooldown, undo before send uploads nothing, T1 carries the trigger", async () => {
		const { faux, service, env, clock, requests, dir: root } = await setup();
		faux.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2")]);
		await converse("첫 질문");
		await service.recordConsent("owner", true);
		const first = await service.scheduleAuto({ channel: "tui", threadKey: "main", reporter: "roach", rule: "profanity.ko" });
		expect(first.scheduled).toBe(true);
		expect(await service.scheduleAuto({ channel: "tui", threadKey: "main", reporter: "roach", rule: "profanity.ko" })).toEqual({ scheduled: false, reason: "cooldown" });
		await service.flush();
		expect(requests).toHaveLength(0); // still inside the undo window
		if (!first.scheduled) throw new Error("unreachable");
		expect((await service.undo("owner", first.id.slice(0, 8))).result).toBe("cancelled");
		clock.advance(AUTO_DELAY_MS + 1_000);
		await service.flush();
		expect(requests).toHaveLength(0);

		clock.advance(AUTO_COOLDOWN_MS);
		await converse("아 씨발 왜 또 이래");
		const second = await service.scheduleAuto({ channel: "tui", threadKey: "main", reporter: "roach", rule: "profanity.ko" });
		if (!second.scheduled) throw new Error("expected a scheduled report");
		clock.advance(AUTO_DELAY_MS + 1_000);
		await service.flush();
		const record = (await localState(root)).reports.find((r) => r.id === second.id)!;
		expect(record.status).toBe("sent");
		const content = await serverContent(env, second.id, record.deleteToken);
		const manifest = JSON.parse(content.split("\n")[0]!) as { kind: string; tier: string; trigger: { rule: string; entryId: string } };
		expect(manifest).toMatchObject({ kind: "auto", tier: "T1", trigger: { rule: "profanity.ko" } });
		expect(manifest.trigger.entryId).toMatch(/^\d+$/);
		expect(content).toContain("왜 또 이래");
	});

	test("auto off: nothing scheduled", async () => {
		const { service } = await setup();
		await service.recordConsent("owner", false);
		expect(await service.scheduleAuto({ channel: "tui", threadKey: "main", reporter: "roach", rule: "profanity.en" })).toEqual({ scheduled: false, reason: "auto_off" });
	});
});

describe("delivery and rights", () => {
	test("retries on 503, then sends; undo after send deletes via the protocol", async () => {
		const { faux, service, env, clock, dir: root } = await setup({ failStatus: [503] });
		faux.setResponses([fauxAssistantMessage("ok")]);
		await converse("hello");
		await service.recordConsent("owner", false);
		const preview = await service.prepare({ owner: "owner", channel: "tui", threadKey: "main", reporter: "roach", excludeOthers: false });
		await service.confirm("owner", preview.id);
		await service.flush();
		let record = (await localState(root)).reports.find((r) => r.id === preview.id)!;
		expect(record.status).toBe("pending");
		clock.advance(61_000);
		await service.flush();
		record = (await localState(root)).reports.find((r) => r.id === preview.id)!;
		expect(record.status).toBe("sent");
		expect((await service.undo("owner", preview.id.slice(0, 8))).result).toBe("deleted");
		expect(env.deleted.has(preview.id)).toBe(true);
	});

	test("terminal 4xx marks failed without retry; outdated consent version is never sent", async () => {
		const { faux, service, requests, dir: root, clock } = await setup({ failStatus: [400] });
		faux.setResponses([fauxAssistantMessage("ok")]);
		await converse("hello");
		await service.recordConsent("owner", false);
		const a = await service.prepare({ owner: "owner", channel: "tui", threadKey: "main", reporter: "roach", excludeOthers: false });
		await service.confirm("owner", a.id);
		await service.flush();
		expect((await localState(root)).reports.find((r) => r.id === a.id)!.status).toBe("failed");

		const b = await service.prepare({ owner: "owner", channel: "tui", threadKey: "main", reporter: "roach", excludeOthers: false });
		const statePath = join(root, "report", "state.json");
		const state = JSON.parse(await readFile(statePath, "utf8")) as { owner: { version: string } };
		state.owner.version = "report-consent-ko-v0";
		await writeFile(statePath, JSON.stringify(state));
		await expect(service.confirm("owner", b.id)).resolves.toBeUndefined();
		clock.advance(1_000);
		const before = requests.length;
		await service.flush();
		expect(requests.length).toBe(before);
		expect((await localState(root)).reports.find((r) => r.id === b.id)!.status).toBe("failed");
	});

	test("withdraw erases every report of the install via the protocol and clears consent", async () => {
		const { faux, service, env } = await setup();
		faux.setResponses([fauxAssistantMessage("ok")]);
		await converse("hello");
		await service.recordConsent("owner", true);
		for (let i = 0; i < 2; i++) {
			const p = await service.prepare({ owner: "owner", channel: "tui", threadKey: "main", reporter: "roach", excludeOthers: false });
			await service.confirm("owner", p.id);
		}
		await service.flush();
		expect((await service.withdraw("owner")).deleted).toBe(2);
		expect([...env.uploads.keys()].filter(id => !env.deleted.has(id))).toHaveLength(0);
		expect((await service.consent("owner")).receipt).toBeUndefined();
		await expect(service.prepare({ owner: "owner", channel: "tui", threadKey: "main", reporter: "roach", excludeOthers: false })).rejects.toThrow("consent required");
	});

	test("channel person: own consent; other participants' messages excluded", async () => {
		const { faux, service, env, dir: root } = await setup();
		faux.setResponses([fauxAssistantMessage("r1"), fauxAssistantMessage("r2")]);
		await converse("alice asks about deploy", { channel: "slack", thread: "t1", userId: "U_ALICE" });
		await converse("bob's confidential numbers", { channel: "slack", thread: "t1", userId: "U_BOB" });
		await expect(service.prepare({ owner: "slack:U_BOB", channel: "slack", threadKey: "t1", reporter: "U_BOB", excludeOthers: true })).rejects.toThrow("consent required");
		await service.recordConsent("slack:U_ALICE", false);
		const preview = await service.prepare({ owner: "slack:U_ALICE", channel: "slack", threadKey: "t1", reporter: "U_ALICE", excludeOthers: true });
		await service.confirm("slack:U_ALICE", preview.id);
		await service.flush();
		const record = (await localState(root)).reports.find((r) => r.id === preview.id)!;
		const content = await serverContent(env, preview.id, record.deleteToken);
		expect(content).toContain("alice asks about deploy");
		expect(content).not.toContain("bob's confidential numbers");
		expect(content).not.toContain("U_BOB");
		expect(content).not.toContain("U_ALICE");
		expect((await service.list("slack:U_BOB"))).toHaveLength(0);
	});
});

describe("client API and /report command", () => {
	const fakeAuth = { providers: async () => [], status: async () => [], accounts: async () => [] } as unknown as AuthService;

	async function run(commands: ReturnType<typeof createCommands>, surface: "tui" | "channel", args: string, answers: string[] = [], userId = "roach", channel = "tui") {
		const command = commands.find("report", surface)!;
		const out: string[] = [];
		const handle = commands.run(command, args, { surface, channel, threadKey: surface === "tui" ? "main" : "t1", userId, context });
		for await (const event of handle.events as AsyncIterable<CommandEvent>) {
			if (event.type === "output") out.push(event.text);
			if (event.type === "error") out.push(`error: ${event.message}`);
			if (event.type === "prompt") commands.answer(handle.runId, event.id, { value: answers.shift() ?? "cancel" });
		}
		return out.join("\n");
	}

	test("TUI: checklist consent, preview, send; then the API schedules an auto report on frustration", async () => {
		const { faux, models, service, env, clock } = await setup();
		faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok2"), fauxAssistantMessage("ok3")]);
		await converse("hello there");
		const commands = createCommands({ bot: bot!, models, auth: fakeAuth, plugins: [], report: service as ReportService });
		const declined = await run(commands, "tui", "setup", ['["collect","age14"]']);
		expect(declined).toContain("켜지 않았습니다");
		const sent = await run(commands, "tui", "느려요", ['["collect","transfer","age14","auto"]', "send"]);
		expect(sent).toContain("동의를 기록했습니다");
		expect(sent).toContain("미리보기");
		expect(sent).toContain("보냅니다");
		await service.flush();
		expect(env.posts.length).toBe(1);

		api = startClientApi(bot!, 0, context, commands, service);
		const client = new ApiClient(api.url);
		const calm = await client.send("tui", "main", "고마워요", "roach");
		expect(calm && "autoReport" in calm ? calm.autoReport : undefined).toBeUndefined();
		const angry = await client.send("tui", "main", "아 씨발 왜 또 이래", "roach");
		expect(angry && angry.autoReport?.rule).toBe("profanity.ko");
		const list = await run(commands, "tui", "list");
		expect(list).toContain("자동 · profanity.ko  전송 대기");
		clock.advance(AUTO_DELAY_MS + 1_000);
		await service.flush();
		expect(await run(commands, "tui", "list")).toContain("자동 · profanity.ko  보냄");
	});

	test("channel: consent by explicit version, two-step send", async () => {
		const { faux, models, service, env } = await setup();
		faux.setResponses([fauxAssistantMessage("ok")]);
		await converse("channel question", { channel: "slack", thread: "t1", userId: "U_ALICE" });
		const commands = createCommands({ bot: bot!, models, auth: fakeAuth, plugins: [], report: service });
		expect(await run(commands, "channel", "", [], "U_ALICE", "slack")).toContain(`/report agree ${CONSENT_VERSION}`);
		expect(await run(commands, "channel", "agree yes", [], "U_ALICE", "slack")).toContain("정확한 버전");
		expect(await run(commands, "channel", `agree ${CONSENT_VERSION}`, [], "U_ALICE", "slack")).toContain("동의를 기록했습니다");
		expect(await run(commands, "channel", "auto on", [], "U_ALICE", "slack")).toContain("TUI에서만");
		const drafted = await run(commands, "channel", "느림", [], "U_ALICE", "slack");
		const id = /\/report send ([0-9a-f]{8})/.exec(drafted)?.[1];
		expect(id).toBeDefined();
		expect(env.uploads.size).toBe(0);
		expect(await run(commands, "channel", `send ${id}`, [], "U_ALICE", "slack")).toContain("보냅니다");
		await service.flush();
		expect(env.uploads.size).toBe(1);
	});

	test("TUI: /report on|off toggles automatic reports instead of sending a report noted \"on\" (report 081217d7)", async () => {
		const { faux, models, service, env } = await setup();
		faux.setResponses([fauxAssistantMessage("ok")]);
		await converse("hello there");
		const commands = createCommands({ bot: bot!, models, auth: fakeAuth, plugins: [], report: service as ReportService });
		const on = await run(commands, "tui", "on", ['["collect","transfer","age14"]']);
		expect(on).toContain("자동 보고를 켰습니다");
		expect(on).not.toContain("보고를 만드는 중");
		expect((await service.consent("owner")).auto).toBe(true);
		const off = await run(commands, "tui", "OFF");
		expect(off).toContain("자동 보고를 껐습니다");
		expect((await service.consent("owner")).auto).toBe(false);
		await service.flush();
		expect(await service.list("owner")).toHaveLength(0);
		expect(env.posts.length).toBe(0);
		// A longer note that merely starts with on/off is still a note.
		expect(await run(commands, "tui", "on 누르면 멈춰요", ["cancel"])).toContain("보고를 만드는 중");
	});

	test("an empty thread produces no report: nothing is drafted, queued or uploaded (report 081217d7)", async () => {
		const { faux, models, service, env, dir: root } = await setup();
		faux.setResponses([fauxAssistantMessage("ok")]);
		await converse("hello there");
		const commands = createCommands({ bot: bot!, models, auth: fakeAuth, plugins: [], report: service as ReportService });
		expect(await run(commands, "tui", "setup", ['["collect","transfer","age14"]'])).toContain("동의를 기록했습니다");
		const handle = commands.run(commands.find("report", "tui")!, "느려요", { surface: "tui", channel: "tui", threadKey: "never-used", userId: "roach", context });
		const out: string[] = [];
		for await (const event of handle.events as AsyncIterable<CommandEvent>) {
			if (event.type === "output") out.push(event.text);
			if (event.type === "error") out.push("error: " + event.message);
			if (event.type === "prompt") commands.answer(handle.runId, event.id, { value: "send" });
		}
		expect(out.join("\n")).toContain("보낼 대화가 없습니다");
		await service.flush();
		expect(await service.drafts("owner")).toHaveLength(0);
		expect(await service.list("owner")).toHaveLength(0);
		expect(env.posts.length).toBe(0);
		expect((await localState(root)).reports).toHaveLength(0);
	});
});
