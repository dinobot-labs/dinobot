import { describe, expect, test } from "bun:test";
import {
	SLACK_APP_NAME_MAX,
	SLACK_BOT_EVENTS,
	SLACK_BOT_SCOPES,
	SlackSetupError,
	buildSlackManifest,
	cleanSlackToken,
	slackAppName,
	slackCreateAppUrl,
	tokenProblem,
	verifySlackAppToken,
	verifySlackBotToken,
	type ProbeSocket,
} from "../src/setup/slack.ts";

// 순수 헬퍼 테스트: 네트워크·웹소켓은 모두 주입한 모의로 검증한다.

describe("slackAppName", () => {
	test("empty falls back to dinobot; trims; caps at 35 chars", () => {
		expect(slackAppName("")).toBe("dinobot");
		expect(slackAppName("   ")).toBe("dinobot");
		expect(slackAppName("  my bot  ")).toBe("my bot");
		expect(slackAppName("가".repeat(SLACK_APP_NAME_MAX + 5))).toBe("가".repeat(SLACK_APP_NAME_MAX));
	});
});

describe("buildSlackManifest / slackCreateAppUrl", () => {
	test("manifest matches the channel's needs and the URL carries it prefilled", () => {
		const manifest = buildSlackManifest("dinobot");
		expect(manifest.settings.socket_mode_enabled).toBe(true);
		expect(manifest.settings.interactivity.is_enabled).toBe(true);
		expect(manifest.oauth_config.scopes.bot).toEqual([...SLACK_BOT_SCOPES]);
		expect(manifest.settings.event_subscriptions.bot_events).toEqual([...SLACK_BOT_EVENTS]);
		expect(manifest.features.bot_user.display_name).toBe("dinobot");

		const url = slackCreateAppUrl(manifest);
		expect(url.startsWith("https://api.slack.com/apps?new_app=1&manifest_json=")).toBe(true);
		const embedded = JSON.parse(decodeURIComponent(url.slice("https://api.slack.com/apps?new_app=1&manifest_json=".length)));
		expect(embedded).toEqual(manifest);
	});

	test("the name flows into the manifest", () => {
		expect(buildSlackManifest("helper").display_information.name).toBe("helper");
		expect(buildSlackManifest("").display_information.name).toBe("dinobot");
	});
});

describe("cleanSlackToken / tokenProblem", () => {
	test("strips copy residue", () => {
		expect(cleanSlackToken("  'xoxb-1,' ")).toBe("xoxb-1");
		expect(cleanSlackToken("\txapp-2`")).toBe("xapp-2");
	});

	test("catches the common wrong-field mistakes before hitting the network", () => {
		expect(tokenProblem("bot", "")).toBe("empty");
		expect(tokenProblem("bot", "xapp-1")).toBe("appInBot");
		expect(tokenProblem("bot", "xoxp-1")).toBe("userInBot");
		expect(tokenProblem("bot", "nope")).toBe("botFormat");
		expect(tokenProblem("bot", "xoxb-fine-1")).toBeUndefined();
		expect(tokenProblem("app", "")).toBe("empty");
		expect(tokenProblem("app", "xoxb-1")).toBe("botInApp");
		expect(tokenProblem("app", "xoxp-1")).toBe("userInApp");
		expect(tokenProblem("app", "nope")).toBe("appFormat");
		expect(tokenProblem("app", "xapp-fine-1")).toBeUndefined();
	});
});

// ── mock Slack API ─────────────────────────────────────────

type SlackScript = { readonly method: string; readonly ok?: boolean; readonly error?: string; readonly body?: Record<string, unknown>; readonly scopes?: string };

function slackFetch(script: readonly SlackScript[]) {
	const calls: string[] = [];
	let index = 0;
	const fetcher = async (url: string): Promise<Response> => {
		const method = new URL(url).pathname.split("/").pop()!;
		calls.push(method);
		const step = script[Math.min(index++, script.length - 1)]!;
		expect(step.method).toBe(method);
		if (step.ok === false) return Response.json({ ok: false, error: step.error ?? "unknown" });
		return new Response(JSON.stringify({ ok: true, ...step.body }), { headers: step.scopes !== undefined ? { "x-oauth-scopes": step.scopes } : {} });
	};
	return { fetcher, calls };
}

const FULL_SCOPES = SLACK_BOT_SCOPES.join(",");

const AUTH_OK = {
	method: "auth.test",
	body: { team: "Faux Workspace", team_id: "T01234", user_id: "U9999", bot_id: "B8888", user: "dinobot", url: "https://foux.slack.com/" },
	scopes: FULL_SCOPES,
};

describe("verifySlackBotToken", () => {
	test("derives team, bot user, app id and reports no missing scopes", async () => {
		const { fetcher, calls } = slackFetch([AUTH_OK, { method: "bots.info", body: { bot: { app_id: "A01234", name: "dinobot" } } }]);
		const bot = await verifySlackBotToken("xoxb-777", { fetch: fetcher });
		expect(bot).toEqual({ teamId: "T01234", teamName: "Faux Workspace", teamUrl: "https://foux.slack.com/", botUserId: "U9999", botName: "dinobot", appId: "A01234", missingScopes: [] });
		expect(calls).toEqual(["auth.test", "bots.info"]);
	});

	test("lists missing scopes from the auth.test header; survives bots.info failure", async () => {
		const { fetcher } = slackFetch([{ ...AUTH_OK, scopes: "chat:write,files:read" }, { method: "bots.info", ok: false, error: "internal" }]);
		const bot = await verifySlackBotToken("xoxb-777", { fetch: fetcher });
		expect(bot.missingScopes).toEqual(SLACK_BOT_SCOPES.filter((scope) => !["chat:write", "files:read"].includes(scope)));
		expect(bot.appId).toBeUndefined();
		expect(bot.botName).toBe("dinobot");
	});

	test("maps Slack errors and user tokens to kinds without a value leak", async () => {
		const invalid = slackFetch([{ method: "auth.test", ok: false, error: "invalid_auth" }]);
		await expect(verifySlackBotToken("xoxb-bad", { fetch: invalid.fetcher })).rejects.toMatchObject({ name: "SlackSetupError", kind: "invalidAuth" });
		const revoked = slackFetch([{ method: "auth.test", ok: false, error: "token_revoked" }]);
		await expect(verifySlackBotToken("xoxb-bad", { fetch: revoked.fetcher })).rejects.toMatchObject({ kind: "revoked" });
		// A user token passes auth.test but has no bot id.
		const user = slackFetch([{ method: "auth.test", body: { team: "T1", team_id: "T01234", user_id: "U9999", user: "human" }, scopes: FULL_SCOPES }]);
		await expect(verifySlackBotToken("xoxp-1", { fetch: user.fetcher })).rejects.toMatchObject({ kind: "unexpected" });
	});

	test("network failures become the network kind", async () => {
		await expect(verifySlackBotToken("xoxb-777", { fetch: async () => { throw new Error("offline"); } })).rejects.toMatchObject({ kind: "network" });
	});
});

// ── fake Socket Mode websocket ─────────────────────────────

class FakeSocket implements ProbeSocket {
	static instances: FakeSocket[] = [];
	readonly url: string;
	private readonly listeners = new Map<string, ((event: { readonly data?: unknown }) => void)[]>();
	readonly sent: string[] = [];
	closed = false;

	constructor(url: string, private readonly hello: Record<string, unknown> | undefined) {
		this.url = url;
		FakeSocket.instances.push(this);
		queueMicrotask(() => {
			if (this.hello !== undefined) this.emit("message", { data: JSON.stringify(this.hello) });
		});
	}

	addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	emit(type: string, event: { readonly data?: unknown }): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.closed = true;
		this.emit("close", {});
	}
}

describe("verifySlackAppToken", () => {
	test("opens a socket and confirms Socket Mode with the hello frame's app id", async () => {
		const { fetcher, calls } = slackFetch([{ method: "apps.connections.open", body: { url: "wss://wss-primary.slack.com/link/" } }]);
		const hello = { type: "hello", connection_info: { app_id: "A01234" } };
		const app = await verifySlackAppToken("xapp-666", { fetch: fetcher, WebSocket: class extends FakeSocket { constructor(url: string) { super(url, hello); } }, helloTimeoutMs: 1_000 });
		expect(app).toEqual({ appId: "A01234" });
		expect(calls).toEqual(["apps.connections.open"]);
		expect(FakeSocket.instances.at(-1)!.closed).toBe(true);
	});

	test("no hello frame means Socket Mode is off", async () => {
		const { fetcher } = slackFetch([{ method: "apps.connections.open", body: { url: "wss://wss-primary.slack.com/link/" } }]);
		await expect(
			verifySlackAppToken("xapp-666", { fetch: fetcher, WebSocket: class extends FakeSocket { constructor(url: string) { super(url, undefined); } }, helloTimeoutMs: 30 }),
		).rejects.toMatchObject({ kind: "socketModeOff" });
	});

	test("rejects a non-Slack socket URL and maps scope errors", async () => {
		const badUrl = slackFetch([{ method: "apps.connections.open", body: { url: "wss://evil.example.com/" } }]);
		await expect(verifySlackAppToken("xapp-666", { fetch: badUrl.fetcher })).rejects.toMatchObject({ kind: "unexpected" });
		const scope = slackFetch([{ method: "apps.connections.open", ok: false, error: "missing_scope" }]);
		await expect(verifySlackAppToken("xapp-666", { fetch: scope.fetcher })).rejects.toMatchObject({ kind: "missingScope" });
		const badShape = slackFetch([{ method: "apps.connections.open", body: {} }]);
		await expect(verifySlackAppToken("xapp-666", { fetch: badShape.fetcher })).rejects.toMatchObject({ kind: "unexpected" });
	});

	test("SlackSetupError carries the kind but never the token", async () => {
		const error = new SlackSetupError("invalidAuth", "invalid_auth");
		expect(error.message).not.toContain("xoxb");
		expect(error.kind).toBe("invalidAuth");
	});
});
