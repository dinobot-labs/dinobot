/**
 * /setup 의 Slack 연결 마법사가 쓰는 순수 도우미(Deepwork 설정 마법사의 흐름을 터미널로 이식).
 *
 * - 앱 이름 → Socket Mode 매니페스트 → Slack 공식 생성 링크(manifest_json 미리 채움): 사용자가 JSON을 복사해 붙일 필요가 없다.
 * - 토큰 붙여 넣기 → 서버 검증: 봇 토큰은 auth.test(+bots.info)로 워크스페이스·봇 사용자·앱 ID·빠진 권한을 도출하고,
 *   앱 수준 토큰은 apps.connections.open(+hello 프레임)으로 확인해 Socket Mode가 켜져 있는지까지 본다.
 * - 오류는 슬랙 응답을 몇 가지 종류로 나눠 던진다(SlackSetupError.kind); 문구는 setup 명령의 locale 사본이 고른다.
 * - 네트워크·시계·웹소켓은 모두 주입 가능해 테스트가 모의 응답을 넣는다.
 */

export const SLACK_DEFAULT_APP_NAME = "dinobot";
export const SLACK_APP_NAME_MAX = 35;
export const SLACK_API_BASE = "https://slack.com/api/";
export const SLACK_CREATE_APP_URL = "https://api.slack.com/apps?new_app=1&manifest_json=";
/** 토큰 값 자체는 이 파일 어디에도 로그로 남기지 않는다. */
const MAX_TOKEN_LENGTH = 1024;
/** 앱 수준 토큰 검증 때 hello 프레임을 기다리는 제한 시간. */
const HELLO_TIMEOUT_MS = 15_000;

/** 봇 토큰에 필요한 권한과 이벤트(슬랙 연동 스킬의 매니페스트와 같다). interactivity 는 질문 버튼에 쓴다. */
export const SLACK_BOT_SCOPES = ["app_mentions:read", "chat:write", "channels:history", "groups:history", "im:history", "files:read", "files:write"] as const;
/** User credentials are read-only. Do not request chat:write or files:write here. */
export const SLACK_USER_SCOPES = ["channels:read", "groups:read", "im:read", "mpim:read", "channels:history", "groups:history", "im:history", "mpim:history", "search:read", "files:read"] as const;
export const SLACK_BOT_EVENTS = ["app_mention", "message.channels", "message.groups", "message.im"] as const;

export type SlackAppManifest = {
	readonly display_information: { readonly name: string; readonly description: string; readonly background_color: string };
	readonly features: {
		readonly app_home: { readonly home_tab_enabled: boolean; readonly messages_tab_enabled: boolean; readonly messages_tab_read_only_enabled: boolean };
		readonly bot_user: { readonly display_name: string; readonly always_online: boolean };
	};
	readonly oauth_config: { readonly scopes: { readonly bot: readonly string[]; readonly user?: readonly string[] } };
	readonly settings: {
		readonly event_subscriptions: { readonly bot_events: readonly string[] };
		readonly interactivity: { readonly is_enabled: boolean };
		readonly org_deploy_enabled: boolean;
		readonly socket_mode_enabled: boolean;
		readonly token_rotation_enabled: boolean;
	};
};

/** 앱 이름: 앞뒤 공백을 떼고 1~35자(Slack 표시 이름 한도). 비면 기본 이름. */
export function slackAppName(name: unknown): string {
	const trimmed = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
	const cut = [...trimmed].slice(0, SLACK_APP_NAME_MAX).join("").trim();
	return cut === "" ? SLACK_DEFAULT_APP_NAME : cut;
}

export function buildSlackManifest(name: unknown, personal = false): SlackAppManifest {
	const app = slackAppName(name);
	return {
		display_information: { name: app, description: `${app}, an AI teammate in your Slack threads and DMs`, background_color: "#1d1c1d" },
		features: {
			app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
			bot_user: { display_name: app, always_online: true },
		},
		oauth_config: { scopes: { bot: [...SLACK_BOT_SCOPES], ...(personal ? { user: [...SLACK_USER_SCOPES] } : {}) } },
		settings: {
			event_subscriptions: { bot_events: [...SLACK_BOT_EVENTS] },
			interactivity: { is_enabled: true },
			org_deploy_enabled: false,
			socket_mode_enabled: true,
			token_rotation_enabled: false,
		},
	};
}

/** 공식 앱 생성 링크: 열기만 하면 매니페스트가 채워져 있다. */
export function slackCreateAppUrl(manifest: SlackAppManifest): string {
	return SLACK_CREATE_APP_URL + encodeURIComponent(JSON.stringify(manifest));
}

// ── 토큰 입력 ─────────────────────────────────────────────

/** 붙여 넣은 토큰 정리: 앞뒤 공백·따옴표·쉼표를 뗀다. */
export function cleanSlackToken(value: string): string {
	return value.replace(/^[\s"'`,]+|[\s"'`,]+$/g, "");
}

/** 본 검증 전 칸을 잘못 고른 흔한 실수만 가려낸다. */
export type SlackTokenProblem = "empty" | "appInBot" | "userInBot" | "botInApp" | "userInApp" | "botFormat" | "appFormat";

export function tokenProblem(kind: "bot" | "app", value: string): SlackTokenProblem | undefined {
	const token = cleanSlackToken(value);
	if (token === "") return "empty";
	if (kind === "bot") {
		if (token.startsWith("xapp-")) return "appInBot";
		if (token.startsWith("xoxp-")) return "userInBot";
		if (!token.startsWith("xoxb-") || /\s/.test(token) || token.length > MAX_TOKEN_LENGTH) return "botFormat";
		return undefined;
	}
	if (token.startsWith("xoxb-")) return "botInApp";
	if (token.startsWith("xoxp-")) return "userInApp";
	if (!token.startsWith("xapp-") || /\s/.test(token) || token.length > MAX_TOKEN_LENGTH) return "appFormat";
	return undefined;
}

// ── Slack API ─────────────────────────────────────────────

export type SlackSetupErrorKind =
	| "network"
	| "invalidAuth"
	| "revoked"
	| "inactive"
	| "missingScope"
	| "socketModeOff"
	| "unexpected"
	| "badResponse";

export class SlackSetupError extends Error {
	override readonly name = "SlackSetupError";
	constructor(
		readonly kind: SlackSetupErrorKind,
		/** Slack 이 준 오류 코드 같은 부가 정보(문구 조립은 호출 쪽 locale 사본이 한다). */
		readonly detail: string = "",
	) {
		super(detail === "" ? kind : `${kind}: ${detail}`);
	}
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

export type SlackFetch = (url: string, init: RequestInit) => Promise<Response>;

export type SlackVerifyDeps = {
	readonly fetch?: SlackFetch;
	readonly signal?: AbortSignal;
};

type SlackApiResult = { readonly data: Record<string, unknown>; readonly headers: Headers };

/** Slack Web API POST 하나. ok:false 는 종류로 나눠 던진다. */
async function slackApi(deps: SlackVerifyDeps, method: string, token: string): Promise<SlackApiResult> {
	const fetcher = deps.fetch ?? ((url: string, init: RequestInit) => globalThis.fetch(url, init));
	let response: Response;
	try {
		response = await fetcher(SLACK_API_BASE + method, {
			method: "POST",
			redirect: "error",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: "{}",
			signal: deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
		});
	} catch (error) {
		if (deps.signal?.aborted) throw error;
		throw new SlackSetupError("network");
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new SlackSetupError("badResponse");
	}
	const body = rec(payload);
	if (body === undefined) throw new SlackSetupError("badResponse", "not an object");
	if (body["ok"] !== true) {
		const error = str(body["error"]) ?? "unknown";
		if (error === "invalid_auth" || error === "not_authed") throw new SlackSetupError("invalidAuth", error);
		if (error === "token_revoked" || error === "token_expired") throw new SlackSetupError("revoked", error);
		if (error === "account_inactive") throw new SlackSetupError("inactive", error);
		if (error === "missing_scope" || error === "not_allowed_token_type") throw new SlackSetupError("missingScope", error);
		throw new SlackSetupError("unexpected", error);
	}
	return { data: body, headers: response.headers };
}

/** 봇 토큰 검증 결과: 설정 블록에 필요한 ID를 전부 도출한다. */
export type VerifiedSlackBot = {
	readonly teamId: string;
	readonly teamName: string;
	readonly teamUrl?: string;
	readonly botUserId: string;
	readonly botName: string;
	readonly appId?: string;
	readonly missingScopes: readonly string[];
};

/** auth.test(+bots.info)로 봇 토큰을 검증하고 워크스페이스·봇·앱 ID를 도출한다. */
export async function verifySlackBotToken(token: string, deps: SlackVerifyDeps = {}): Promise<VerifiedSlackBot> {
	const auth = await slackApi(deps, "auth.test", token);
	const botId = str(auth.data["bot_id"]);
	const userId = str(auth.data["user_id"]);
	const teamId = str(auth.data["team_id"]);
	// xoxp- 사용자 토큰도 auth.test 는 통과시키는데, 봇 id 가 없다. 이 경우 봇 토큰이 아니라고 본다.
	if (botId === undefined || userId === undefined || teamId === undefined) throw new SlackSetupError("unexpected", "user-token");
	let appId: string | undefined;
	let botName = str(auth.data["user"]) ?? userId;
	try {
		const info = rec((await slackApi(deps, "bots.info", token)).data["bot"]);
		appId = str(info?.["app_id"]);
		botName = str(info?.["name"]) ?? botName;
	} catch {
		// app_id 는 앱 수준 토큰의 hello 프레임으로도 구할 수 있어, 여기서 실패하면 계속 진행한다.
	}
	const granted = new Set((auth.headers.get("x-oauth-scopes") ?? "").split(",").map((scope) => scope.trim()));
	return {
		teamId,
		teamName: str(auth.data["team"]) ?? teamId,
		...(str(auth.data["url"]) !== undefined ? { teamUrl: str(auth.data["url"])! } : {}),
		botUserId: userId,
		botName,
		...(appId !== undefined ? { appId } : {}),
		missingScopes: SLACK_BOT_SCOPES.filter((scope) => !granted.has(scope)),
	};
}

export type VerifiedSlackUser = { readonly ownerUserId: string; readonly teamId: string; readonly missingScopes: readonly string[] };

/** auth.test derives the owner, never from model/user-supplied IDs. Unknown/write scopes fail closed. */
export async function verifySlackUserToken(token: string, expectedTeamId: string, deps: SlackVerifyDeps = {}): Promise<VerifiedSlackUser> {
	if (!token.startsWith("xoxp-") || /\s/.test(token) || token.length > MAX_TOKEN_LENGTH) throw new SlackSetupError("invalidAuth", "user-token-format");
	const auth = await slackApi(deps, "auth.test", token);
	const teamId = str(auth.data["team_id"]);
	const ownerUserId = str(auth.data["user_id"]);
	if (teamId !== expectedTeamId) throw new SlackSetupError("unexpected", "team-mismatch");
	if (!ownerUserId || auth.data["bot_id"]) throw new SlackSetupError("invalidAuth", "not-user-token");
	const granted = (auth.headers.get("x-oauth-scopes") ?? "").split(",").map(s => s.trim()).filter(Boolean);
	if (granted.some(s => !(SLACK_USER_SCOPES as readonly string[]).includes(s))) throw new SlackSetupError("missingScope", "user-token-must-be-read-only");
	const missingScopes = SLACK_USER_SCOPES.filter(s => !granted.includes(s));
	if (missingScopes.length) throw new SlackSetupError("missingScope", missingScopes.join(","));
	return { teamId, ownerUserId, missingScopes };
}

/** Personal setup must establish bot/app identity; missing identity is not a match. */
export function requireSlackAppMatch(bot: VerifiedSlackBot, app: VerifiedSlackApp): string {
	if (!bot.appId || !app.appId || bot.appId !== app.appId) throw new SlackSetupError("unexpected", "app-mismatch");
	if (bot.missingScopes.length) throw new SlackSetupError("missingScope", bot.missingScopes.join(","));
	return app.appId;
}

/** 앱 수준 토큰 검증 결과. */
export type VerifiedSlackApp = { readonly appId?: string };

/** 메시지 프레임 하나를 기다리는 최소 웹소켓(테스트가 모의 소켓을 넣는다). */
export type ProbeSocket = {
	readonly send: (data: string) => void;
	readonly close: () => void;
	addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void;
};
export type ProbeSocketConstructor = new (url: string) => ProbeSocket;

export type SlackAppVerifyDeps = SlackVerifyDeps & {
	readonly WebSocket?: ProbeSocketConstructor;
	readonly helloTimeoutMs?: number;
};

const decodeFrame = (data: unknown): string | undefined => {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
	if (ArrayBuffer.isView(data)) return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
	return undefined;
};

/** 소켓 주소 검사: wss://*.slack.com 만 받는다. */
function socketUrlAllowed(raw: unknown): raw is string {
	if (typeof raw !== "string") return false;
	try {
		const url = new URL(raw);
		return url.protocol === "wss:" && (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"));
	} catch {
		return false;
	}
}

/**
 * apps.connections.open(+hello 프레임)으로 앱 수준 토큰을 검증한다. hello 가 없으면 Socket Mode가 꺼져 있는 것이다.
 * hello 프레임의 app_id 를 돌려준다(없으면 undefined).
 */
export async function verifySlackAppToken(token: string, deps: SlackAppVerifyDeps = {}): Promise<VerifiedSlackApp> {
	deps.signal?.throwIfAborted();
	const opened = await slackApi(deps, "apps.connections.open", token);
	deps.signal?.throwIfAborted();
	const url = opened.data["url"];
	if (!socketUrlAllowed(url)) throw new SlackSetupError("unexpected", "bad-socket-url");
	const socketClass = deps.WebSocket ?? ((globalThis as { WebSocket?: unknown }).WebSocket as ProbeSocketConstructor | undefined);
	if (socketClass === undefined) throw new SlackSetupError("network", "no-websocket");
	const helloTimeoutMs = deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
	const appId = await new Promise<string | undefined>((resolve, reject) => {
		let socket: ProbeSocket;
		try {
			socket = new socketClass(url);
		} catch (error) {
			reject(new SlackSetupError("network", error instanceof Error ? error.message : String(error)));
			return;
		}
		let done = false;
		const finish = (result: { appId?: string } | Error): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			deps.signal?.removeEventListener("abort", onAbort);
			try {
				socket.close();
			} catch {
				// 이미 닫힘
			}
			if (result instanceof Error) reject(result);
			else resolve(result.appId);
		};
		const fail = (): void => finish(new SlackSetupError("socketModeOff"));
		const onAbort = (): void => finish(new Error("aborted"));
		const timer = setTimeout(fail, helloTimeoutMs);
		deps.signal?.addEventListener("abort", onAbort, { once: true });
		socket.addEventListener("close", fail);
		socket.addEventListener("error", fail);
		socket.addEventListener("message", (event) => {
			const text = decodeFrame(event.data);
			let frame: Record<string, unknown> | undefined;
			try {
				frame = text !== undefined ? rec(JSON.parse(text)) : undefined;
			} catch {
				frame = undefined;
			}
			if (frame?.["type"] !== "hello") return;
			const appId = str(rec(frame["connection_info"])?.["app_id"]);
			finish(appId !== undefined ? { appId } : {});
		});
	});
	return appId !== undefined ? { appId } : {};
}
