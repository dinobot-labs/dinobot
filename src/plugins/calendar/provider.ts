/**
 * External calendar boundary (ADR 0106). The calendar works with no account: every event is `source = 'local'` in the
 * plugin's own store. A later source syncs an external calendar into the same store, so its events get planned
 * reminders, wakes and preparation exactly like local ones:
 *
 * - Google Calendar: through the existing `google` plugin's OAuth REST client (Calendar API v3 `events.list`, with
 *   `updatedMin` for incremental pulls and `events.insert`/`patch` for push).
 * - Apple Calendar (iCloud): CalDAV (`REPORT calendar-query` over a time range) or a read-only ICS subscription URL.
 *
 * A source pulls a time range and returns normalized events; the store upserts them by (`source`, `external_id`) and
 * replans their reminders (fired history stays, so a re-pull never re-notifies). Nothing here is implemented or
 * configurable yet; this is the contract a source must meet.
 */

/** An event as an external calendar reports it, normalized. Times are epoch ms; all-day ends are exclusive midnights. */
export type ExternalEvent = {
	/** The source's id, e.g. `google:primary` or `caldav:https://caldav.icloud.com/.../home/`. */
	readonly sourceId: string;
	/** Stable id of the event inside the source (Google event id, CalDAV UID + recurrence id). */
	readonly externalId: string;
	readonly title: string;
	readonly start: number;
	readonly end?: number;
	readonly allDay: boolean;
	/** IANA zone the source wrote the event in, when it reports one. */
	readonly timeZone?: string;
	readonly location?: string;
	readonly description?: string;
	/** Source's last-modified instant; an unchanged value skips the upsert. */
	readonly updatedAt: number;
	/** The source deleted or declined it; the store cancels the local copy. */
	readonly cancelled?: boolean;
};

export type PullRange = { readonly fromMs: number; readonly toMs: number; readonly signal?: AbortSignal };

/** One external calendar. `push` is optional: read-only sources (ICS) only pull. */
export interface CalendarSource {
	readonly id: string;
	pull(range: PullRange): Promise<readonly ExternalEvent[]>;
	/** Write a local event out to the source; returns the source's id for it. */
	push?(event: Omit<ExternalEvent, "sourceId" | "externalId" | "updatedAt"> & { readonly externalId?: string }): Promise<{ readonly externalId: string }>;
}

/** The built-in source: the plugin's own store. Events created through the calendar tools carry this. */
export const LOCAL_SOURCE = "local";
