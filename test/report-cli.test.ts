import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { reportProtocol, uploadedContent } from "./fixtures/report-protocol.ts";
import { CONSENT_VERSION } from "../src/report/consent.ts";

/**
 * `dinobot report` as a real process against a synthetic loopback HTTP protocol double, not a private backend. The manifest is
 * one the daemon refuses to boot (Telegram token file with mode 0644, missing fields) and nothing listens on api.port.
 */

const TOKEN = "987654321:AAHcliTelegramTokenValue0123456789abcdefgh";
let root: string;
let manifest: string;
let dataDir: string;
let worker: ReturnType<typeof Bun.serve>;
const env = reportProtocol();

async function closedPort(): Promise<number> {
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
	const port = server.port!;
	await server.stop(true);
	return port;
}

async function writeManifest(port: number) {
	await writeFile(manifest, ["bot:", "  enabled: true", `  dataDir: ${JSON.stringify(dataDir)}`, "  model: { provider: anthropic, modelId: claude-sonnet-4-6 }", "  toolMode: codemode-only", `api: { port: ${port} }`, "channels:", "  telegram:", "    mode: polling", `    botTokenFile: ${JSON.stringify(join(root, "tg.token"))}`, "plugins: {}", ""].join("\n"));
}

async function cli(...args: string[]) {
	const child = Bun.spawn([process.execPath, resolve("src/main.ts"), "report", ...args, "--config", manifest], {
		cwd: root,
		env: { ...process.env, DINOBOT_REPORT_URL: `http://127.0.0.1:${worker.port}`, DINOBOT_REPORT_NETWORK: "off", DINOBOT_NO_UPDATE_CHECK: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	let json: any;
	try {
		json = JSON.parse(out.trim().split("\n").at(-1) ?? "");
	} catch {
		json = undefined;
	}
	return { out, err, code, json };
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "dinobot-report-cli-"));
	dataDir = join(root, "data");
	manifest = join(root, "dinobot.yaml");
	await mkdir(dataDir, { recursive: true });
	await writeFile(join(root, "tg.token"), `${TOKEN}\n`);
	await chmod(join(root, "tg.token"), 0o644);
	await writeFile(join(dataDir, "dinobot.log"), `Daemon startup failed: Unable to read Telegram bot credential (token ${TOKEN})\n`);
	await writeManifest(await closedPort());
	worker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => env.handle(request) });
});

afterAll(async () => {
	await worker.stop(true);
	await rm(root, { recursive: true, force: true });
});

describe("dinobot report (no daemon)", () => {
	test("consent → agree → offline send → status; exit codes and JSON shapes", async () => {
		const consent = await cli("consent", "--json");
		expect(consent.code).toBe(0);
		expect(consent.json).toMatchObject({ version: CONSENT_VERSION, consented: false, auto: false });
		expect(consent.json.text).toContain("진단 정보(보고할 때만)");

		const early = await cli("send", "--json");
		expect(early.code).toBe(3);
		expect(early.json).toEqual({ error: "consent_required", version: CONSENT_VERSION });

		const wrong = await cli("agree", "report-consent-ko-v1", "--json");
		expect(wrong.code).toBe(2);
		expect(wrong.json).toEqual({ error: "version", version: CONSENT_VERSION });

		const agree = await cli("agree", CONSENT_VERSION, "--json");
		expect(agree.code).toBe(0);
		expect(agree.json.receipt).toMatchObject({ version: CONSENT_VERSION, collect: true, transfer: true, age14: true });

		const contextFile = join(root, "context.json");
		await writeFile(contextFile, JSON.stringify({ appVersion: "1.0.0", lastDaemonFailure: `exit 1 ${TOKEN}` }));
		const sent = await cli("send", "--json", "--note", "텔레그램 붙이면 데몬이 꺼져요", "--trigger", "daemon-start-failed", "--client", "desktop", "--context-file", contextFile);
		expect({ code: sent.code, err: sent.err }).toEqual({ code: 0, err: "" });
		expect(sent.json).toMatchObject({ status: "sent", mode: "offline", daemon: "daemon refused" });
		expect(Object.keys(sent.json).sort()).toEqual(["compressedBytes", "daemon", "diagnostics", "entries", "id", "mode", "redactions", "shortId", "status"]);
		expect(sent.json.shortId).toBe(sent.json.id.slice(0, 8));

		const state = JSON.parse(await readFile(join(dataDir, "report", "state.json"), "utf8")) as { reports: Array<{ id: string; deleteToken: string }> };
		const token = state.reports.find((r) => r.id === sent.json.id)!.deleteToken;
		const text = await uploadedContent(env, sent.json.id, token);
		const lines = text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
		expect(lines[0]).toMatchObject({ trigger: { rule: "daemon-start-failed" }, note: "텔레그램 붙이면 데몬이 꺼져요" });
		const sections = lines.slice(1).map((line) => line.section);
		expect(sections).toEqual(expect.arrayContaining(["report", "system", "runtime", "install", "config", "daemon", "logs", "dataDir", "channels", "network", "context"]));
		expect(lines.find((line) => line.section === "report")!.data).toMatchObject({ mode: "offline", client: "desktop", trigger: "daemon-start-failed" });
		expect(lines.find((line) => line.section === "context")!.data.client).toMatchObject({ appVersion: "1.0.0", offlineCli: { reason: "daemon refused" } });
		expect(lines.find((line) => line.section === "logs")!.data.text).toContain("Unable to read Telegram bot credential");
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain("AAHcliTelegramTokenValue");

		const status = await cli("status", "--json");
		expect(status.code).toBe(0);
		expect(status.json.consent).toMatchObject({ version: CONSENT_VERSION, consented: true });
		expect(status.json.consent.text).toBeUndefined();
		expect(status.json.reports).toEqual([expect.objectContaining({ id: sent.json.id, status: "sent", kind: "manual", trigger: "daemon-start-failed" })]);
	}, 60_000);

	test("a live daemon gets the report (mode daemon); a hung one (timeout) falls back to offline", async () => {
		const received: unknown[] = [];
		const daemon = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (request) => {
				const path = new URL(request.url).pathname;
				if (path === "/healthz") return new Response("ok");
				if (path === "/v1/report" && request.method === "POST") {
					received.push(await request.json());
					return Response.json({ id: "00000000-0000-4000-8000-000000000000", shortId: "00000000", status: "sent", entries: 20, diagnostics: 12, compressedBytes: 999, redactions: {} });
				}
				return new Response("not found", { status: 404 });
			},
		});
		try {
			await writeManifest(daemon.port!);
			const viaDaemon = await cli("send", "--json", "--thread", "tui:main", "--trigger", "button", "--client", "desktop");
			expect(viaDaemon.code).toBe(0);
			expect(viaDaemon.json).toMatchObject({ mode: "daemon", status: "sent", shortId: "00000000" });
			expect(received).toEqual([{ trigger: "button", client: "desktop", channel: "tui", thread: "main" }]);
		} finally {
			await daemon.stop(true);
		}

		const hung = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Promise<Response>(() => undefined) });
		try {
			await writeManifest(hung.port!);
			const fallback = await cli("send", "--json", "--trigger", "daemon-down");
			expect(fallback.code).toBe(0);
			expect(fallback.json).toMatchObject({ mode: "offline", status: "sent", daemon: "daemon timeout" });
		} finally {
			await hung.stop(true);
		}
	}, 60_000);

	test("usage errors exit 2", async () => {
		expect((await cli("send", "--trigger", "nope")).code).toBe(2);
		expect((await cli("frobnicate")).code).toBe(2);
		expect((await cli("send", "--thread", "nocolon")).code).toBe(2);
	}, 30_000);
});
