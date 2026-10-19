import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { PluginTool } from "../types.ts";
import { type Api, GoogleApiError, segment, tool } from "./api.ts";
import { htmlToText } from "./gmail.ts";

const BASE = "https://www.googleapis.com/calendar/v3";

type When = { date?: string; dateTime?: string; timeZone?: string };
type Event = {
	id: string;
	status?: string;
	summary?: string;
	description?: string;
	location?: string;
	start?: When;
	end?: When;
	attendees?: { email: string; responseStatus?: string; self?: boolean; organizer?: boolean }[];
	organizer?: { email?: string };
	htmlLink?: string;
	hangoutLink?: string;
	recurringEventId?: string;
};

export function eventSummary(event: Event) {
	return {
		id: event.id,
		...(event.status && event.status !== "confirmed" ? { status: event.status } : {}),
		summary: event.summary ?? "(no title)",
		start: event.start?.dateTime ?? event.start?.date,
		end: event.end?.dateTime ?? event.end?.date,
		...(event.location ? { location: event.location } : {}),
		...(event.description ? { description: (/<[a-z][^>]*>/i.test(event.description) ? htmlToText(event.description) : event.description).slice(0, 2_000) } : {}),
		...(event.attendees?.length ? { attendees: event.attendees.map(({ email, responseStatus }) => ({ email, responseStatus })) } : {}),
		...(event.organizer?.email ? { organizer: event.organizer.email } : {}),
		...(event.hangoutLink ? { meet: event.hangoutLink } : {}),
		...(event.htmlLink ? { link: event.htmlLink } : {}),
	};
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` is an all-day date; anything else an RFC 3339 date-time (with offset, or local to timeZone). */
export function when(value: string, timeZone: string | undefined): When {
	if (DATE.test(value)) return { date: value };
	if (Number.isNaN(Date.parse(value))) throw new Error(`invalid date-time ${JSON.stringify(value)}: use RFC 3339, e.g. 2026-10-12T15:00:00+09:00`);
	return { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}

/** Event id (base32hex) derived from the request, so a retried identical create never makes a second event. */
export function eventIdFor(parts: readonly unknown[]): string {
	return `dnb${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 40)}`;
}

const CalendarId = Type.Optional(Type.String({ minLength: 1, description: "Calendar id from calendar_list_calendars; default primary." }));
const Time = Type.String({ minLength: 10, description: "RFC 3339 date-time (2026-10-12T15:00:00+09:00) or YYYY-MM-DD for all-day." });
const TimeZone = Type.Optional(Type.String({ minLength: 1, description: "IANA time zone, e.g. Asia/Seoul." }));
const Emails = Type.Array(Type.String({ minLength: 3 }), { maxItems: 100 });

export function calendarTools(api: Api, write: boolean): PluginTool[] {
	const read: PluginTool[] = [
		tool(
			"calendar_list_calendars",
			"List the calendars the user has (id, name, access role, time zone, primary).",
			Type.Object({}, { additionalProperties: false }),
			true,
			async (_args, signal) => {
				const list = await api.json<{ items?: { id: string; summary: string; accessRole: string; timeZone?: string; primary?: boolean }[] }>(
					"GET",
					`${BASE}/users/me/calendarList`,
					{ query: { maxResults: 250 }, signal },
				);
				return { calendars: (list.items ?? []).map(({ id, summary, accessRole, timeZone, primary }) => ({ id, summary, accessRole, timeZone, ...(primary ? { primary } : {}) })) };
			},
		),
		tool(
			"calendar_list_events",
			"List events in a time range, in start order (recurring events expanded). Optional free-text query.",
			Type.Object(
				{
					calendarId: CalendarId,
					timeMin: Type.String({ minLength: 10, description: "RFC 3339 lower bound (inclusive end time)." }),
					timeMax: Type.String({ minLength: 10, description: "RFC 3339 upper bound (exclusive start time)." }),
					query: Type.Optional(Type.String()),
					maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 250, description: "Default 50." })),
					pageToken: Type.Optional(Type.String()),
				},
				{ additionalProperties: false },
			),
			true,
			async ({ calendarId = "primary", timeMin, timeMax, query, maxResults = 50, pageToken }, signal) => {
				const list = await api.json<{ items?: Event[]; nextPageToken?: string; timeZone?: string }>("GET", `${BASE}/calendars/${segment(calendarId)}/events`, {
					query: { timeMin, timeMax, q: query, maxResults, pageToken, singleEvents: true, orderBy: "startTime" },
					signal,
				});
				return { timeZone: list.timeZone, events: (list.items ?? []).map(eventSummary), ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}) };
			},
		),
		tool(
			"calendar_get_event",
			"Read one calendar event.",
			Type.Object({ calendarId: CalendarId, eventId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
			true,
			async ({ calendarId = "primary", eventId }, signal) => eventSummary(await api.json<Event>("GET", `${BASE}/calendars/${segment(calendarId)}/events/${segment(eventId)}`, { signal })),
		),
		tool(
			"calendar_freebusy",
			"Busy intervals of calendars (the user's, or colleagues' when shared) in a time range; use it to find free time.",
			Type.Object(
				{
					timeMin: Type.String({ minLength: 10 }),
					timeMax: Type.String({ minLength: 10 }),
					calendarIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 50, description: "Default [primary]." })),
					timeZone: TimeZone,
				},
				{ additionalProperties: false },
			),
			true,
			async ({ timeMin, timeMax, calendarIds = ["primary"], timeZone }, signal) => {
				const result = await api.json<{ calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }> }>("POST", `${BASE}/freeBusy`, {
					body: { timeMin, timeMax, ...(timeZone ? { timeZone } : {}), items: calendarIds.map((id) => ({ id })) },
					signal,
				});
				return {
					calendars: Object.fromEntries(
						Object.entries(result.calendars).map(([id, value]) => [id, value.errors?.length ? { errors: value.errors.map((error) => error.reason) } : { busy: value.busy ?? [] }]),
					),
				};
			},
		),
	];
	if (!write) return read;
	return [
		...read,
		tool(
			"calendar_create_event",
			"Create a calendar event. Attendees get Google's invitation email only with sendUpdates: all. An identical repeated request returns the existing event instead of creating another.",
			Type.Object(
				{
					calendarId: CalendarId,
					summary: Type.String({ minLength: 1, maxLength: 1024 }),
					start: Time,
					end: Time,
					timeZone: TimeZone,
					description: Type.Optional(Type.String({ maxLength: 8_000 })),
					location: Type.Optional(Type.String({ maxLength: 1024 })),
					attendees: Type.Optional(Emails),
					sendUpdates: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("externalOnly"), Type.Literal("none")], { description: "Default none." })),
				},
				{ additionalProperties: false },
			),
			false,
			async ({ calendarId = "primary", summary, start, end, timeZone, description, location, attendees, sendUpdates = "none" }, signal) => {
				const event = {
					summary,
					start: when(start, timeZone),
					end: when(end, timeZone),
					...(description !== undefined ? { description } : {}),
					...(location !== undefined ? { location } : {}),
					...(attendees ? { attendees: attendees.map((email) => ({ email })) } : {}),
				};
				const id = eventIdFor([calendarId, event]);
				const url = `${BASE}/calendars/${segment(calendarId)}/events`;
				try {
					return { created: true, ...eventSummary(await api.json<Event>("POST", url, { query: { sendUpdates }, body: { id, ...event }, signal })) };
				} catch (error) {
					if (!(error instanceof GoogleApiError) || error.status !== 409) throw error;
					const existing = await api.json<Event>("GET", `${url}/${segment(id)}`, { signal });
					// The id of a deleted event stays reserved: an identical request after deletion is a new event.
					if (existing.status !== "cancelled") return { created: false, duplicate: true, ...eventSummary(existing) };
					return { created: true, ...eventSummary(await api.json<Event>("POST", url, { query: { sendUpdates }, body: event, signal })) };
				}
			},
		),
		tool(
			"calendar_update_event",
			"Change fields of an existing event (only the fields given). For recurring events this changes the instance id given.",
			Type.Object(
				{
					calendarId: CalendarId,
					eventId: Type.String({ minLength: 1 }),
					summary: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
					start: Type.Optional(Time),
					end: Type.Optional(Time),
					timeZone: TimeZone,
					description: Type.Optional(Type.String({ maxLength: 8_000 })),
					location: Type.Optional(Type.String({ maxLength: 1024 })),
					attendees: Type.Optional(Emails),
					sendUpdates: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("externalOnly"), Type.Literal("none")])),
				},
				{ additionalProperties: false },
			),
			false,
			async ({ calendarId = "primary", eventId, summary, start, end, timeZone, description, location, attendees, sendUpdates = "none" }, signal) => {
				const patch = {
					...(summary !== undefined ? { summary } : {}),
					...(start !== undefined ? { start: when(start, timeZone) } : {}),
					...(end !== undefined ? { end: when(end, timeZone) } : {}),
					...(description !== undefined ? { description } : {}),
					...(location !== undefined ? { location } : {}),
					...(attendees !== undefined ? { attendees: attendees.map((email) => ({ email })) } : {}),
				};
				if (Object.keys(patch).length === 0) throw new Error("nothing to update");
				return eventSummary(
					await api.json<Event>("PATCH", `${BASE}/calendars/${segment(calendarId)}/events/${segment(eventId)}`, { query: { sendUpdates }, body: patch, signal }),
				);
			},
		),
		tool(
			"calendar_delete_event",
			"Delete (cancel) a calendar event. Deleting an already deleted event succeeds.",
			Type.Object(
				{
					calendarId: CalendarId,
					eventId: Type.String({ minLength: 1 }),
					sendUpdates: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("externalOnly"), Type.Literal("none")])),
				},
				{ additionalProperties: false },
			),
			false,
			async ({ calendarId = "primary", eventId, sendUpdates = "none" }, signal) => {
				try {
					await api.json("DELETE", `${BASE}/calendars/${segment(calendarId)}/events/${segment(eventId)}`, { query: { sendUpdates }, signal });
				} catch (error) {
					if (!(error instanceof GoogleApiError) || error.status !== 410) throw error;
				}
				return { deleted: true, eventId };
			},
		),
	];
}
