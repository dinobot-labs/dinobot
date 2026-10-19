import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type Bot, openBot } from "../src/core/bot.ts";
import type { ToolMode } from "../src/core/toolmode.ts";
import { createGooglePlugin, DEFAULT_BROKER } from "../src/plugins/google/index.ts";
import { scopesFor } from "../src/plugins/google/services.ts";
import { bodyOf, rawMessage } from "../src/plugins/google/gmail.ts";
import { eventIdFor, eventSummary, when } from "../src/plugins/google/calendar.ts";
import { driveLiteral } from "../src/plugins/google/drive.ts";
import { type LoadedPlugin, loadPlugin } from "../src/plugins/types.ts";

import { protocolHttp } from "./fixtures/protocol-http.ts";
const context = BACKGROUND_CONTEXT;

// Synthetic HTTP protocol responses, not private broker acceptance.
class FakeGoogle {
	now = 1_000_000;
	readonly pending = new Map<string, {code: string; iss?: string}>();
	readonly codes = new Map<string, { challenge: string; scope: string }>();
	readonly access = new Map<string, number>(); // token -> expiresAt
	readonly refresh = new Set<string>();
	readonly tokenRequests: Record<string, string>[] = [];
	readonly apiAuth: (string | null)[] = [];
	readonly apiRequests: { method: string; url: URL; body: string }[] = [];
	readonly events = new Map<string, Record<string, unknown>>();
	/** Next REST response override (status, body), e.g. a 403 insufficient scope. */
	nextApiFailure: { status: number; body: unknown } | undefined;
	private serial = 0;

	/** fetch for the plugin: broker, MCP servers and Google revoke. */
	readonly fetch = protocolHttp(async (input) => {
		const request = input instanceof Request ? new Request(input) : new Request(String(input));
		const url = new URL(request.url);
		if (url.origin === DEFAULT_BROKER) return this.broker(request, url);
		if (url.href === "https://oauth2.googleapis.com/revoke") {
			this.refresh.clear();
			this.access.clear();
			return new Response("{}");
		}
		if (url.hostname.endsWith("googleapis.com")) return this.api(request, url);
		return new Response("unexpected " + url.href, { status: 599 });
	});

	private async broker(request: Request, url: URL): Promise<Response> {
 if (url.pathname === "/v1/google") return Response.json({issuer:"https://accounts.google.com",authorizationEndpoint:"https://accounts.google.com/o/oauth2/v2/auth",tokenEndpoint:DEFAULT_BROKER+"/v1/token",clientId:"cid",redirectUri:DEFAULT_BROKER+"/callback",authorizationParams:{access_type:"offline"}});
 if (url.pathname.startsWith("/v1/pending/")) {const value=this.pending.get(url.pathname.split("/").at(-1)!); return value ? Response.json(value) : new Response(null,{status:204});}
 if (url.pathname === "/v1/token" && request.method === "POST") return this.token(Object.fromEntries(new URLSearchParams(await request.text())));
 return new Response("unexpected fixture route",{status:404});
 }
	private token(form: Record<string, string>): Response {
		this.tokenRequests.push(form);
		if (form.grant_type === "authorization_code") {
			const grant = this.codes.get(form.code ?? "");
			this.codes.delete(form.code ?? "");
			const challenge = createHash("sha256").update(form.code_verifier ?? "").digest("base64url");
			if (!grant || grant.challenge !== challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
			return Response.json(this.issue(true, grant.scope));
		}
		if (form.grant_type === "refresh_token") {
			if (!this.refresh.has(form.refresh_token ?? "")) return Response.json({ error: "invalid_grant" }, { status: 400 });
			return Response.json(this.issue(false));
		}
		return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
	}

	private issue(withRefresh: boolean, scope?: string) {
		const access = `at-${++this.serial}`;
		this.access.set(access, this.now + 3_600_000);
		const refresh = withRefresh ? `rt-${this.serial}` : undefined;
		if (refresh) this.refresh.add(refresh);
		return { access_token: access, expires_in: 3600, token_type: "Bearer", ...(refresh ? { refresh_token: refresh } : {}), ...(scope ? { scope } : {}) };
	}

	/** What Google does after the user approves the consent screen: redirect the browser to the broker callback. */
	async consent(loginUrl: string, options: { iss?: string | null; grantScope?: string } = {}): Promise<void> {
		const url = new URL(loginUrl);
		const code = `code-${++this.serial}`;
		this.codes.set(code, { challenge: url.searchParams.get("code_challenge")!, scope: options.grantScope ?? url.searchParams.get("scope")! });
		const iss = options.iss === undefined ? "https://accounts.google.com" : options.iss;
		this.pending.set(url.searchParams.get("state")!, {code, ...(iss === null ? {} : {iss})});
	}

	private async api(request: Request, url: URL): Promise<Response> {
		const header = request.headers.get("authorization");
		this.apiAuth.push(header);
		const body = await request.text();
		this.apiRequests.push({ method: request.method, url, body });
		const expires = this.access.get(header?.replace(/^Bearer /, "") ?? "");
		if (expires === undefined || expires <= this.now) return Response.json({ error: { code: 401, message: "Invalid Credentials" } }, { status: 401 });
		if (this.nextApiFailure) {
			const failure = this.nextApiFailure;
			this.nextApiFailure = undefined;
			return Response.json(failure.body, { status: failure.status });
		}
		const path = url.hostname + url.pathname;
		const b64 = (text: string) => Buffer.from(text).toString("base64url");
		const message = (id: string) => ({
			id,
			threadId: "t1",
			labelIds: ["INBOX"],
			snippet: "snip " + id,
			payload: {
				mimeType: "multipart/alternative",
				headers: [
					{ name: "From", value: "a@example.com" },
					{ name: "Subject", value: "Invoice " + id },
					{ name: "Message-ID", value: `<${id}@example.com>` },
				],
				parts: [
					{ mimeType: "text/plain", body: { data: b64("body of " + id) } },
					{ mimeType: "application/pdf", filename: "invoice.pdf", body: { size: 10, attachmentId: "x" } },
				],
			},
		});
		if (path === "gmail.googleapis.com/gmail/v1/users/me/messages") return Response.json({ messages: [{ id: "m1" }, { id: "m2" }] });
		const gmailMessage = /^gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path);
		if (gmailMessage) return Response.json(message(decodeURIComponent(gmailMessage[1]!)));
		if (path === "gmail.googleapis.com/gmail/v1/users/me/drafts") return Response.json({ id: "d1", message: { id: "m9", threadId: JSON.parse(body).message.threadId ?? "t9" } });
		if (path === "gmail.googleapis.com/gmail/v1/users/me/drafts/send") return Response.json({ id: "m9", threadId: "t9" });
		const events = /^www\.googleapis\.com\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
		if (events) {
			const id = events[2] && decodeURIComponent(events[2]);
			if (request.method === "POST") {
				const event = JSON.parse(body) as Record<string, unknown>;
				const eventId = (event.id as string | undefined) ?? `e${this.events.size + 1}`;
				if (this.events.has(eventId) && this.events.get(eventId)!.status !== "cancelled") return Response.json({ error: { code: 409, message: "The requested identifier already exists." } }, { status: 409 });
				const stored = { ...event, id: eventId, status: "confirmed" };
				this.events.set(eventId, stored);
				return Response.json(stored);
			}
			if (request.method === "GET" && id) return this.events.has(id) ? Response.json(this.events.get(id)) : Response.json({ error: { code: 404, message: "Not Found" } }, { status: 404 });
			if (request.method === "DELETE" && id) {
				const event = this.events.get(id);
				if (!event || event.status === "cancelled") return Response.json({ error: { code: 410, message: "Resource has been deleted" } }, { status: 410 });
				event.status = "cancelled";
				return new Response(null, { status: 204 });
			}
			return Response.json({ timeZone: "Asia/Seoul", items: [...this.events.values()].filter((event) => event.status !== "cancelled") });
		}
		if (path === "www.googleapis.com/drive/v3/files") return Response.json({ files: [{ id: "f1", name: "Plan", mimeType: "application/vnd.google-apps.document" }] });
		const file = /^www\.googleapis\.com\/drive\/v3\/files\/([^/]+)(\/export)?$/.exec(path);
		if (file) {
			const id = decodeURIComponent(file[1]!);
			const mimeType = id === "pdf" ? "application/pdf" : "application/vnd.google-apps.document";
			if (file[2]) return new Response("# Plan\n\n" + "x".repeat(500));
			return Response.json({ id, name: id === "pdf" ? "scan.pdf" : "Plan", mimeType });
		}
		if (path === "people.googleapis.com/v1/people/me") return Response.json({ resourceName: "people/me", names: [{ displayName: "Roach" }], emailAddresses: [{ value: "r@example.com" }] });
		return Response.json({ error: { code: 404, message: "no fake for " + path } }, { status: 404 });
	}
}

let dir: string | undefined;
const loaded: LoadedPlugin[] = [];
const bots: Bot[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
	for (const plugin of loaded.splice(0)) await plugin.close?.();
	if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	dir = undefined;
});

async function load(google: FakeGoogle, config: Record<string, unknown> = { services: ["gmail"] }): Promise<LoadedPlugin> {
	dir ??= await mkdtemp(join(tmpdir(), "dinobot-google-"));
	const plugin = createGooglePlugin({ fetch: google.fetch, pollIntervalMs: 5, now: () => google.now });
	const result = await loadPlugin(plugin, config, { resolveDependency: async () => undefined, dataDir: dir });
	if (Array.isArray(result)) throw new Error(result.join("\n"));
	loaded.push(result);
	return result;
}

const tool = (plugin: LoadedPlugin, name: string) => plugin.tools.find((entry) => entry.name === name)!;

async function failure(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("expected a failure");
}

const linkIn = (message: string) => /(https:\/\/accounts\.google\.com\/\S+)$/.exec(message)![1]!;

async function waitFor(check: () => Promise<boolean>) {
	const deadline = Date.now() + 5_000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("timed out");
		await Bun.sleep(5);
	}
}

async function connected(google: FakeGoogle, plugin: LoadedPlugin, options: { grantScope?: string } = {}) {
	await google.consent(((await tool(plugin, "google_connect").execute({}, {})) as { url: string }).url, options);
	await waitFor(async () => (await stat(join(dir!, "google-oauth.json")).catch(() => undefined)) !== undefined);
}

describe("google plugin", () => {
	test("loads without network; read-only by default, write tools only with write: true", async () => {
		const google = new FakeGoogle();
		const plugin = await load(google, {});
		expect(plugin.tools.map((entry) => entry.name)).toEqual([
			"google_connect",
			"google_disconnect",
			"google_gmail_search",
			"google_gmail_read_message",
			"google_gmail_read_thread",
			"google_gmail_list_labels",
			"google_calendar_list_calendars",
			"google_calendar_list_events",
			"google_calendar_get_event",
			"google_calendar_freebusy",
			"google_drive_search",
			"google_drive_get_file",
			"google_drive_read_file",
			"google_people_me",
			"google_people_search_contacts",
		]);
		expect(plugin.tools.filter((entry) => entry.readOnly !== true).map((entry) => entry.name)).toEqual(["google_disconnect"]);
		expect(google.tokenRequests).toEqual([]);
		expect(google.apiRequests).toEqual([]);
		expect(plugin.storagePaths).toEqual([join(dir!, "google-oauth.json")]);
		expect(plugin.prompt).toContain("Only reading is enabled");

		await loaded.pop()!.close?.();
		const writable = await load(google, { write: true });
		const writes = writable.tools.filter((entry) => entry.readOnly !== true).map((entry) => entry.name);
		expect(writes).toEqual([
			"google_disconnect",
			"google_gmail_create_draft",
			"google_gmail_send_draft",
			"google_gmail_modify_labels",
			"google_gmail_trash_message",
			"google_calendar_create_event",
			"google_calendar_update_event",
			"google_calendar_delete_event",
			"google_drive_create_text_file",
		]);
		expect(writable.prompt).toContain("google_gmail_send_draft only after they approve");
	});

	test("an unauthorized call returns a login link with PKCE and offline access for exactly the configured scopes", async () => {
		const google = new FakeGoogle();
		const plugin = await load(google, { services: ["gmail", "calendar"] });
		const message = await failure(tool(plugin, "google_gmail_search").execute({ query: "x" }, {}));
		expect(message).toStartWith("Google authorization required.");
		const url = new URL(linkIn(message));
		expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
		const params = url.searchParams;
		expect(params.get("client_id")).toBe("cid");
		expect(params.get("redirect_uri")).toBe(`${DEFAULT_BROKER}/callback`);
		expect(params.get("code_challenge_method")).toBe("S256");
		expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(params.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(params.get("access_type")).toBe("offline");
		expect(params.get("scope")!.split(" ")).toEqual(scopesFor(["gmail", "calendar"], false));
		expect(params.get("scope")).not.toContain("gmail.modify");
		const connect = (await tool(plugin, "google_connect").execute({}, {})) as { status: string; url: string };
		expect(connect).toMatchObject({ status: "authorization_required", url: url.toString() });
		expect(google.apiRequests).toEqual([]); // nothing reached Google without a token
	});

	test("login through the broker, then calls carry the token; tokens survive a restart", async () => {
		const google = new FakeGoogle();
		const plugin = await load(google, { services: ["gmail"] });
		await connected(google, plugin);
		expect(await tool(plugin, "google_connect").execute({}, {})).toMatchObject({ status: "connected" });
		const exchange = google.tokenRequests.find((form) => form.grant_type === "authorization_code")!;
		expect(exchange.client_secret).toBeUndefined(); // Private broker owns secret injection.
		expect(exchange.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);

		const result = (await tool(plugin, "google_gmail_search").execute({ query: "invoice", maxResults: 2 }, {})) as { messages: { id: string; subject: string }[] };
		expect(result.messages.map((message) => [message.id, message.subject])).toEqual([["m1", "Invoice m1"], ["m2", "Invoice m2"]]);
		expect(google.apiRequests[0]!.url.searchParams.get("q")).toBe("invoice");
		expect(google.apiAuth.at(-1)).toMatch(/^Bearer at-/);

		const file = join(dir!, "google-oauth.json");
		if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600); // POSIX only; not a Windows ACL claim
		expect(await readFile(file, "utf8")).not.toContain("csecret");

		await loaded.pop()!.close?.();
		const restarted = await load(google, { services: ["gmail"] });
		expect(await tool(restarted, "google_gmail_read_message").execute({ id: "m1" }, {})).toMatchObject({
			id: "m1",
			body: "body of m1",
			attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", size: 10 }],
		});
	});

	test("an expired access token is refreshed through the broker", async () => {
		const google = new FakeGoogle();
		const plugin = await load(google, { services: ["gmail"] });
		await connected(google, plugin);
		google.now += 2 * 3_600_000;
		await tool(plugin, "google_gmail_list_labels").execute({}, {}).catch(() => undefined);
		expect(google.tokenRequests.at(-1)).toMatchObject({ grant_type: "refresh_token" });
		expect(google.apiAuth).toEqual(["Bearer at-3"]);
	});

	test("a server-side 401 with a stale token forces one refresh and retries", async () => {
		const google = new FakeGoogle();
		const plugin = await load(google, { services: ["gmail"] });
		await connected(google, plugin);
		google.access.clear(); // revoked upstream while our copy still looks valid
		await tool(plugin, "google_gmail_search").execute({ query: "q" }, {});
		expect(google.apiAuth.slice(0, 2)).toEqual(["Bearer at-2", "Bearer at-3"]);
	});

	test("a revoked refresh token deletes the grant and asks for a new login", async () => {
		const google = new FakeGoogle();
		const plugin = await load(google, { services: ["gmail"] });
		await connected(google, plugin);
		google.refresh.clear();
		google.now += 2 * 3_600_000;
		expect(await failure(tool(plugin, "google_gmail_search").execute({ query: "q" }, {}))).toStartWith("Google authorization required.");
		expect(await stat(join(dir!, "google-oauth.json")).catch(() => undefined)).toBeUndefined();
	});

	test("a 403 insufficient scope asks for authorization; other API errors keep their status and message", async () => {
		const google = new FakeGoogle();
		const plugin = await load(google, { services: ["gmail"] });
		await connected(google, plugin);
		google.nextApiFailure = { status: 403, body: { error: { code: 403, message: "Insufficient Permission", errors: [{ reason: "insufficientPermissions" }] } } };
		expect(await failure(tool(plugin, "google_gmail_list_labels").execute({}, {}))).toStartWith("Google authorization required.");
		google.nextApiFailure = { status: 429, body: { error: { code: 429, message: "Quota exceeded" } } };
		expect(await failure(tool(plugin, "google_gmail_list_labels").execute({}, {}))).toBe("Google 429: Quota exceeded");
	});

	test("an authorization response without the issuer is rejected before the code is redeemed (RFC 9207)", async () => {
		const google = new FakeGoogle();
		const plugin = await load(google, { services: ["gmail"] });
		const { url } = (await tool(plugin, "google_connect").execute({}, {})) as { url: string };
		await google.consent(url, { iss: null });
		await waitFor(async () => ((await tool(plugin, "google_connect").execute({}, {})) as { url: string }).url !== url);
		expect(google.tokenRequests).toEqual([]);
		const evil = (await tool(plugin, "google_connect").execute({}, {})) as { url: string };
		await google.consent(evil.url, { iss: "https://evil.example" });
		await waitFor(async () => ((await tool(plugin, "google_connect").execute({}, {})) as { url: string }).url !== evil.url);
		expect(google.tokenRequests).toEqual([]);
	});

	test("broader granted scopes cover narrower ones; a missing scope asks for authorization before any call", async () => {
		const google = new FakeGoogle();
		const plugin = await load(google, { services: ["gmail", "drive"] });
		await connected(google, plugin, { grantScope: "https://www.googleapis.com/auth/gmail.modify" });
		expect(await tool(plugin, "google_connect").execute({}, {})).toMatchObject({ status: "authorization_required" });
		expect(await failure(tool(plugin, "google_drive_search").execute({}, {}))).toStartWith("Google authorization required.");
		expect(google.apiRequests).toEqual([]);

		await loaded.pop()!.close?.();
		const gmailOnly = await load(google, { services: ["gmail"] });
		expect(await tool(gmailOnly, "google_connect").execute({}, {})).toMatchObject({ status: "connected" }); // gmail.modify covers gmail.readonly
	});

	test("gmail drafts: replies keep the thread and headers; send is a separate step", async () => {
		const google = new FakeGoogle();
		const plugin = await load(google, { services: ["gmail"], write: true });
		await connected(google, plugin);
		expect(await tool(plugin, "google_gmail_create_draft").execute({ to: ["b@example.com"], body: "네, 확인했습니다.", replyToMessageId: "m1" }, {})).toEqual({
			draftId: "d1",
			messageId: "m9",
			threadId: "t1",
		});
		const draft = JSON.parse(google.apiRequests.at(-1)!.body) as { message: { raw: string; threadId: string } };
		const raw = Buffer.from(draft.message.raw, "base64url").toString("utf8");
		expect(raw).toContain("Subject: Re: Invoice m1\r\n");
		expect(raw).toContain("In-Reply-To: <m1@example.com>\r\n");
		expect(Buffer.from(raw.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("네, 확인했습니다.");
		expect(await failure(tool(plugin, "google_gmail_create_draft").execute({ to: ["b@example.com\r\nBcc: x@evil.example"], body: "x" }, {}))).toBe("to must not contain line breaks");
		expect(await tool(plugin, "google_gmail_send_draft").execute({ draftId: "d1" }, {})).toEqual({ sent: true, messageId: "m9", threadId: "t9" });
	});

	test("calendar create is idempotent for identical requests; delete tolerates an already deleted event", async () => {
		const google = new FakeGoogle();
		const plugin = await load(google, { services: ["calendar"], write: true });
		await connected(google, plugin);
		const args = { summary: "1:1", start: "2026-10-12T15:00:00+09:00", end: "2026-10-12T15:30:00+09:00", attendees: ["b@example.com"] };
		const first = (await tool(plugin, "google_calendar_create_event").execute(args, {})) as { id: string; created: boolean };
		expect(first).toMatchObject({ created: true, summary: "1:1", start: args.start, attendees: [{ email: "b@example.com" }] });
		expect(google.apiRequests.at(-1)!.url.searchParams.get("sendUpdates")).toBe("none");
		expect(await tool(plugin, "google_calendar_create_event").execute(args, {})).toMatchObject({ created: false, duplicate: true, id: first.id });
		expect(google.events.size).toBe(1);
		expect(await tool(plugin, "google_calendar_delete_event").execute({ eventId: first.id }, {})).toEqual({ deleted: true, eventId: first.id });
		expect(await tool(plugin, "google_calendar_delete_event").execute({ eventId: first.id }, {})).toEqual({ deleted: true, eventId: first.id });
		// The deleted event's id stays reserved; asking again creates a new event.
		expect(await tool(plugin, "google_calendar_create_event").execute(args, {})).toMatchObject({ created: true });
		expect(await failure(tool(plugin, "google_calendar_create_event").execute({ ...args, start: "next tuesday" }, {}))).toContain("invalid date-time");
	});

	test("drive: Google Docs are exported as Markdown and capped; binary files are refused; ids are path-encoded", async () => {
		const google = new FakeGoogle();
		const plugin = await load(google, { services: ["drive"] });
		await connected(google, plugin);
		const read = (await tool(plugin, "google_drive_read_file").execute({ fileId: "f1", maxChars: 100 }, {})) as Record<string, unknown>;
		expect(read).toMatchObject({ id: "f1", exportedAs: "text/markdown", truncated: true, totalChars: 508 });
		expect((read.content as string).length).toBe(100);
		expect(google.apiRequests.at(-1)!.url.pathname).toBe("/drive/v3/files/f1/export");
		expect(await failure(tool(plugin, "google_drive_read_file").execute({ fileId: "pdf" }, {}))).toContain("only Google Docs/Sheets/Slides and text files");
		await tool(plugin, "google_drive_get_file").execute({ fileId: "a/b?c" }, {});
		expect(google.apiRequests.at(-1)!.url.pathname).toBe("/drive/v3/files/a%2Fb%3Fc");
		expect(await failure(tool(plugin, "google_drive_get_file").execute({ fileId: ".." }, {}))).toBe('invalid id ".."');
		await tool(plugin, "google_drive_search").execute({ text: "it's" }, {});
		expect(google.apiRequests.at(-1)!.url.searchParams.get("q")).toBe("(name contains 'it\\'s' or fullText contains 'it\\'s') and trashed = false");
	});

	test("disconnect revokes and forgets the grant", async () => {
		const google = new FakeGoogle();
		const plugin = await load(google, { services: ["gmail"] });
		await connected(google, plugin);
		expect(await tool(plugin, "google_disconnect").execute({}, {})).toEqual({ disconnected: true });
		expect(await stat(join(dir!, "google-oauth.json")).catch(() => undefined)).toBeUndefined();
		expect(google.refresh.size).toBe(0);
	});

	test("config is validated and the data directory is required", async () => {
		const plugin = createGooglePlugin({ fetch: new FakeGoogle().fetch });
		const host = { resolveDependency: async () => undefined, dataDir: "/tmp" };
		expect(await loadPlugin(plugin, { services: ["mail"] }, host)).toEqual([expect.stringContaining("plugins.google/services/0")]);
		expect(await loadPlugin(plugin, { broker: "http://insecure.example" }, host)).toEqual([expect.stringContaining("plugins.google/broker")]);
		expect((await loadPlugin(plugin, { other: 1 }, host)) as string[]).toContainEqual(expect.stringContaining("plugins.google"));
		expect(await loadPlugin(plugin, {}, { resolveDependency: async () => undefined })).toEqual(["plugins.google: needs the bot data directory for its OAuth tokens"]);
	});

	test("pure helpers", () => {
		expect(bodyOf({ mimeType: "text/html", body: { data: Buffer.from("<p>a &amp; b</p><script>x</script><br>c").toString("base64url") } }).text).toBe("a & b\n\nc");
		expect(Buffer.from(rawMessage({ to: ["a@b.c"], subject: "안녕", body: "x" }), "base64url").toString()).toContain("Subject: =?UTF-8?B?7JWI64WV?=");
		expect(when("2026-10-12", "Asia/Seoul")).toEqual({ date: "2026-10-12" });
		expect(eventSummary({ id: "e", description: "<p>첫 모임</p><p>a &amp; b</p>" }).description).toBe("첫 모임\na & b");
		expect(eventSummary({ id: "e", description: "plain <3 text" }).description).toBe("plain <3 text");
		expect(when("2026-10-12T15:00:00+09:00", "Asia/Seoul")).toEqual({ dateTime: "2026-10-12T15:00:00+09:00", timeZone: "Asia/Seoul" });
		expect(eventIdFor(["a"])).toMatch(/^[a-v0-9]{5,1024}$/);
		expect(eventIdFor(["a"])).toBe(eventIdFor(["a"]));
		expect(eventIdFor(["a"])).not.toBe(eventIdFor(["b"]));
		expect(driveLiteral("a\\'b")).toBe("'a\\\\\\'b'");
	});

	test("bot integration: codemode scripts and direct mode reach google tools", async () => {
		const google = new FakeGoogle();
		const plugin = await load(google, { services: ["gmail"] });
		await connected(google, plugin);
		const message = { channel: "test", threadKey: "G1", messageId: "m1", userId: "U1", text: "find invoices" };
		for (const toolMode of ["codemode-only", "hybrid", "direct"] as ToolMode[]) {
			const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
			const models = createModels();
			models.setProvider(faux.provider);
			const storage = await openNodeSqliteStorage(join(dir!, `${toolMode}.sqlite`));
			const bot = await openBot({ storage, models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode, plugins: [plugin] }, context);
			bots.push(bot);
			let toolResult = "";
			faux.setResponses([
				fauxAssistantMessage(
					toolMode === "direct"
						? fauxToolCall("google_gmail_search", { query: "invoice" })
						: fauxToolCall("codemode", { code: 'return await tools.google_gmail_search({ query: "invoice" });' }),
					{ stopReason: "toolUse" },
				),
				(transcript) => {
					toolResult = JSON.stringify(transcript.messages.at(-1));
					return fauxAssistantMessage("done");
				},
			]);
			expect(await bot.handle({ ...message, threadKey: `G-${toolMode}` }, context)).toMatchObject({ status: "answered", text: "done" });
			expect(toolResult).toContain("Invoice m1");
		}
	}, 60_000);

	test("separability: the plugin imports only its directory and ../types.ts", async () => {
		const root = join(import.meta.dir, "..", "src");
		const files: string[] = [];
		async function walk(path: string): Promise<void> {
			for (const entry of await readdir(path, { withFileTypes: true })) {
				if (entry.isDirectory()) await walk(join(path, entry.name));
				else if (entry.name.endsWith(".ts")) files.push(join(path, entry.name));
			}
		}
		await walk(root);
		for (const path of files) {
			const name = relative(root, path).replaceAll("\\", "/");
			const specs = [...(await readFile(path, "utf8")).matchAll(/from "([^"]+)"/g)].map((match) => match[1]!);
			if (name.startsWith("plugins/google/")) {
				for (const spec of specs.filter((value) => value.startsWith("."))) expect(spec.startsWith("./") || spec === "../types.ts").toBe(true);
			} else if (name !== "plugins/index.ts") {
				expect(specs.filter((value) => value.includes("google/"))).toEqual([]);
			}
		}
	});
});
