import { Type } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { definePlugin, type PluginTool } from "../types.ts";
import { createApi } from "./api.ts";
import { GoogleAuth } from "./auth.ts";
import { calendarTools } from "./calendar.ts";
import { driveTools } from "./drive.ts";
import { gmailTools } from "./gmail.ts";
import { peopleTools } from "./people.ts";
import { SERVICE_IDS, scopeGranted, scopesFor, type ServiceId } from "./services.ts";

export const DEFAULT_BROKER = "https://oauth.dinobot.workers.dev";

const config = Type.Object(
	{
		/** Google services to expose. Default: all. */
		services: Type.Optional(Type.Array(Type.Enum(SERVICE_IDS), { minItems: 1, uniqueItems: true })),
		/** Register tools that change data (send mail, edit events, create files) and ask for the matching scopes. */
		write: Type.Optional(Type.Boolean()),
		/** dinobot OAuth broker (`services/oauth-broker`). */
		broker: Type.Optional(Type.String({ pattern: "^https://[^/]+$" })),
	},
	{ additionalProperties: false },
);

function prompt(write: boolean): string {
	return [
		"Google tools (google_*) act on the user's own Google account (Gmail, Calendar, Drive, contacts).",
		'- If a google tool fails with "Google authorization required" and a link, send the user that link exactly as given and ask them to open it and allow access. Retry after they say it is done. Never invent or shorten the link.',
		"- google_connect reports whether the account is connected and returns a login link when it is not.",
		"- Times: use the user's time zone (calendar_list_calendars shows it) and RFC 3339 with an offset.",
		write
			? "- Sending mail is two steps: google_gmail_create_draft, show the user the draft, google_gmail_send_draft only after they approve. Confirm before deleting events, trashing mail or inviting attendees (sendUpdates: all) unless the user asked for exactly that."
			: "- Only reading is enabled. To send mail or change events, the operator sets plugins.google.write: true.",
	].join("\n");
}

export type GoogleTestHooks = { readonly fetch?: typeof fetch; readonly pollIntervalMs?: number; readonly now?: () => number };

export function createGooglePlugin(hooks: GoogleTestHooks = {}) {
	return definePlugin({
		id: "google",
		config,
		load: async ({ services = [...SERVICE_IDS], write = false, broker = DEFAULT_BROKER }, host) => {
			if (host.dataDir === undefined) throw new Error("needs the bot data directory for its OAuth tokens");
			const file = join(host.dataDir, "google-oauth.json");
			const auth = new GoogleAuth({
				broker,
				file,
				scopes: scopesFor(services, write),
				scopeGranted,
				...(hooks.fetch ? { fetch: hooks.fetch } : {}),
				...(hooks.pollIntervalMs !== undefined ? { pollIntervalMs: hooks.pollIntervalMs } : {}),
				...(hooks.now ? { now: hooks.now } : {}),
			});
			const api = createApi(auth, hooks.fetch);
			const byService: Record<ServiceId, () => PluginTool[]> = {
				gmail: () => gmailTools(api, write),
				calendar: () => calendarTools(api, write),
				drive: () => driveTools(api, write),
				people: () => peopleTools(api),
			};
			const tools: PluginTool[] = [
				{
					name: "connect",
					description:
						"Report whether the user's Google account is connected. When it is not (or new permissions are needed), returns a login link to send to the user as is.",
					inputSchema: { type: "object", properties: {}, additionalProperties: false },
					readOnly: true,
					execute: async () => {
						const status = await auth.status();
						if (status.connected) return { status: "connected", services, write };
						const { url } = await auth.startLogin();
						return {
							status: "authorization_required",
							url,
							instructions: "Send the user this link exactly as it is and ask them to open it and allow access. The link works on any device for 10 minutes.",
						};
					},
				},
				{
					name: "disconnect",
					description: "Revoke dinobot's access to the user's Google account and delete the stored tokens. Only when the user asks for it.",
					inputSchema: { type: "object", properties: {}, additionalProperties: false },
					execute: async () => ({ disconnected: await auth.disconnect() }),
				},
				...services.flatMap((service) => byService[service]()),
			];
			return { tools, prompt: prompt(write), storagePaths: [file], close: async () => auth.close() };
		},
	});
}

export const googlePlugin = createGooglePlugin();
