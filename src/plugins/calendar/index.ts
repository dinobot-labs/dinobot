import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { definePlugin, type PluginTool, type PluginToolCall } from "../types.ts";
import { CalendarEngine } from "./engine.ts";
import { baseTime, CATEGORIES, type Category, type ExplicitReminder, IMPORTANCES, type Importance, planReminders, type QuietHours, type Reminder } from "./planner.ts";
import { LOCAL_SOURCE } from "./provider.ts";
import { type CalendarEvent, CalendarStore, type StoredReminder } from "./store.ts";
import { addDays, DAY, duration, formatDate, formatInstant, formatLocal, isValidTimeZone, localDate, localToUtc, MINUTE, type ParsedTime, parseTime, processTimeZone } from "./time.ts";

/**
 * Calendar plugin (ADR 0106): events and planned reminders in a local SQLite store, a tick loop that wakes the
 * conversation an event was registered in when a reminder comes due, and tools the agent uses to register single
 * events or a whole plan (WBS, roadmap). Works with no external account; provider.ts is the boundary for Google and
 * Apple calendars.
 */

const HHMM = "^([01][0-9]|2[0-3]):[0-5][0-9]$";

const config = Type.Object(
	{
		/** IANA zone for local times, quiet hours and display; default the process zone. */
		timeZone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
		/** How often the engine checks for due reminders even with nothing scheduled sooner. */
		checkIntervalMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
		/** Non-urgent reminders (3 h or more ahead) avoid this local window; false turns it off. */
		quietHours: Type.Optional(Type.Union([
			Type.Object({ start: Type.String({ pattern: HHMM }), end: Type.String({ pattern: HHMM }) }, { additionalProperties: false }),
			Type.Literal(false),
		])),
		/** SQLite file; default `<dataDir>/calendar.sqlite`. Registered as host storage either way. */
		databasePath: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const literals = <T extends readonly string[]>(values: T) => Type.Union(values.map((value) => Type.Literal(value)));

/** How far in the past a new or moved event may end (clock skew, a meeting that just ended). */
const PAST_TOLERANCE_MS = 5 * 60_000;
const TIME_HELP = "RFC 3339 with offset (2026-05-07T14:00:00+09:00), local 2026-05-07T14:00 (read in timeZone), or a date 2026-05-07 for an all-day event";

const reminderSchema = Type.Object({
	minutes: Type.Integer({ minimum: 0, maximum: 86400, description: "Minutes before the start (all-day events count back from 09:00 local on the first day)" }),
	action: Type.Optional(Type.Union([Type.Literal("notify"), Type.Literal("prepare")], { description: "notify: short heads-up (default); prepare: the agent researches and drafts material" })),
	note: Type.Optional(Type.String({ maxLength: 500 })),
}, { additionalProperties: false });

const fieldSchemas = {
	title: Type.String({ minLength: 1, maxLength: 200 }),
	start: Type.String({ minLength: 1, maxLength: 64, description: TIME_HELP }),
	end: Type.String({ minLength: 1, maxLength: 64, description: `${TIME_HELP}; an all-day end date is inclusive` }),
	timeZone: Type.String({ minLength: 1, maxLength: 64, description: "IANA zone, e.g. Asia/Seoul; default the calendar's zone" }),
	location: Type.String({ maxLength: 500 }),
	description: Type.String({ maxLength: 4000 }),
	category: literals(CATEGORIES),
	importance: literals(IMPORTANCES),
	preparation: Type.String({ maxLength: 2000, description: "What the user must prepare; drives prepare reminders where the agent drafts it ahead of time" }),
	reminders: Type.Array(reminderSchema, { maxItems: 8, description: "Explicit reminders replace the automatic plan; [] means none. Leave out for the automatic plan" }),
	key: Type.String({ minLength: 1, maxLength: 200, description: "Stable external key (e.g. a WBS id); the same key updates the same event" }),
};

const createSchema = Type.Object({
	title: fieldSchemas.title,
	start: fieldSchemas.start,
	end: Type.Optional(fieldSchemas.end),
	timeZone: Type.Optional(fieldSchemas.timeZone),
	location: Type.Optional(fieldSchemas.location),
	description: Type.Optional(fieldSchemas.description),
	category: Type.Optional(fieldSchemas.category),
	importance: Type.Optional(fieldSchemas.importance),
	preparation: Type.Optional(fieldSchemas.preparation),
	reminders: Type.Optional(fieldSchemas.reminders),
	key: Type.Optional(fieldSchemas.key),
}, { additionalProperties: false });

const nullable = <T extends TSchema>(schema: T) => Type.Optional(Type.Union([schema, Type.Null()]));

const eventIdSchema = Type.String({ pattern: "^evt_[0-9a-f]{16}$" });

const updateSchema = Type.Object({
	id: eventIdSchema,
	title: Type.Optional(fieldSchemas.title),
	start: Type.Optional(fieldSchemas.start),
	end: nullable(fieldSchemas.end),
	timeZone: Type.Optional(fieldSchemas.timeZone),
	location: nullable(fieldSchemas.location),
	description: nullable(fieldSchemas.description),
	category: Type.Optional(fieldSchemas.category),
	importance: Type.Optional(fieldSchemas.importance),
	preparation: nullable(fieldSchemas.preparation),
	reminders: nullable(fieldSchemas.reminders),
}, { additionalProperties: false });

const defaultsSchema = Type.Object({
	category: Type.Optional(fieldSchemas.category),
	importance: Type.Optional(fieldSchemas.importance),
	timeZone: Type.Optional(fieldSchemas.timeZone),
}, { additionalProperties: false });

const importSchema = Type.Object({
	items: Type.Array(createSchema, { minItems: 1, maxItems: 200 }),
	defaults: Type.Optional(defaultsSchema),
}, { additionalProperties: false });

/** What import_events validates up front; each item is checked on its own so one bad item never fails the batch. */
const importEnvelope = Type.Object({
	items: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 200 }),
	defaults: Type.Optional(defaultsSchema),
}, { additionalProperties: false });

const listSchema = Type.Object({
	from: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: `Default now. ${TIME_HELP}` })),
	to: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "Default from + 14 days; a date means the end of that day" })),
	query: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Substring of title or description" })),
	includeCancelled: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

type EventInput = Static<typeof createSchema>;
type Defaults = Static<typeof defaultsSchema>;

function errorsOf(schema: TSchema, value: unknown): string {
	return [...Value.Errors(schema, value)].map((error) => `${error.instancePath || "/"}: ${error.message}`).join("; ");
}

function check<T extends TSchema>(schema: T, args: unknown): Static<T> {
	if (Value.Check(schema, args)) return args;
	throw new Error(`invalid arguments: ${errorsOf(schema, args)}`);
}

function tool<T extends TSchema>(name: string, description: string, schema: T, run: (args: Static<T>, call: PluginToolCall) => unknown, options: { readOnly?: boolean; validate?: TSchema } = {}): PluginTool {
	return {
		name, description, inputSchema: schema as unknown as PluginTool["inputSchema"], ...(options.readOnly ? { readOnly: true } : {}),
		execute: async (args, call) => await run(check(options.validate ?? schema, args) as Static<T>, call),
	};
}

const opt = <K extends string, V>(key: K, value: V | null | undefined): { [P in K]?: V } =>
	(value === null || value === undefined ? {} : { [key]: value }) as { [P in K]?: V };

/** Stable id: the same key (or the same title and start without one) in the same conversation is the same event. */
export function eventId(key: string | undefined, origin: string, title: string, startMs: number): string {
	const material = key !== undefined ? ["key", origin, key] : ["event", origin, title, startMs];
	return `evt_${createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16)}`;
}

type Times = { startMs: number; endMs?: number; allDay: boolean };

function parsedOf(event: CalendarEvent, timeZone: string): ParsedTime {
	if (!event.allDay) return { ms: event.startMs, allDay: false };
	const date = localDate(event.startMs, event.timeZone);
	return { ms: localToUtc(timeZone, date), allDay: true, date };
}

/** Start and (exclusive) end; an all-day event always has an end, local midnight after its last day. */
function timesOf(start: ParsedTime, end: string | undefined, timeZone: string): Times {
	const afterDay = (parsed: ParsedTime) => localToUtc(timeZone, addDays(parsed.date ?? localDate(parsed.ms, timeZone), 1));
	if (end === undefined) return start.allDay ? { startMs: start.ms, endMs: afterDay(start), allDay: true } : { startMs: start.ms, allDay: false };
	const parsedEnd = parseTime(end, timeZone);
	if (parsedEnd.allDay !== start.allDay) throw new Error("start and end must both be dates (all-day) or both be times");
	if (parsedEnd.ms < start.ms) throw new Error("end is before start");
	return start.allDay ? { startMs: start.ms, endMs: afterDay(parsedEnd), allDay: true } : { startMs: start.ms, endMs: parsedEnd.ms, allDay: false };
}

function explicitReminders(input: EventInput["reminders"]): ExplicitReminder[] | undefined {
	return input?.map((r) => ({ minutes: r.minutes, action: r.action ?? "notify", ...(r.note ? { note: r.note } : {}) }));
}

/** Fields that decide whether an import changed an event. */
function fingerprint(event: CalendarEvent): string {
	const { createdAt: _created, updatedAt: _updated, ...rest } = event;
	return JSON.stringify(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)));
}

export type CalendarPluginOptions = {
	/** Clock for planning and ticks (tests). */
	readonly now?: () => number;
	/** Arm real timers; false lets a test drive `engine.tick()` by hand. Default true. */
	readonly timers?: boolean;
	/** Receives the engine of each loaded instance (tests and the E2E drive ticks through it). */
	readonly onEngine?: (engine: CalendarEngine) => void;
	readonly log?: (message: string) => void;
};

const DEFAULT_QUIET: QuietHours = { start: "22:00", end: "08:00" };

function prompt(timeZone: string, intervalMinutes: number): string {
	return [
		"calendar: the user's calendar, with reminders the host delivers to this conversation by itself.",
		"- When the user mentions dated plans (meetings, deadlines, trips, presentations), register them with calendar_create_event.",
		"- Resolve relative dates (today, tomorrow, next Tuesday) against the current time; if you are not sure of today's date, read `now` from calendar_list_events first. Never guess the year.",
		"- For a plan such as a WBS, roadmap or timeline (table, list or spreadsheet), parse every item and call calendar_import_events once with a stable key per item (e.g. the WBS id).",
		"- Fill `preparation` with what the user will need (slides, agenda, documents, bookings) so it can be prepared in time; pick category and importance carefully, they decide how early reminders come.",
		"- Leave `reminders` out for the automatic plan (days ahead for presentations and deadlines, minutes for meetings) unless the user asks for specific times.",
		`- The host checks every ${intervalMinutes} minutes and wakes this conversation when a reminder is due; a prepare reminder asks you to research and draft material then. Time zone: ${timeZone}.`,
	].join("\n");
}

export function createCalendarPlugin(options: CalendarPluginOptions = {}) {
	return definePlugin({
		id: "calendar",
		config,
		load(settings, host) {
			const zone = settings.timeZone ?? processTimeZone();
			if (!isValidTimeZone(zone)) throw new Error(`unknown time zone ${JSON.stringify(zone)}`);
			const databasePath = settings.databasePath !== undefined ? resolve(settings.databasePath) : host.dataDir !== undefined ? join(host.dataDir, "calendar.sqlite") : undefined;
			if (databasePath === undefined) throw new Error("needs databasePath or a bot data directory");
			const intervalMinutes = settings.checkIntervalMinutes ?? 5;
			const quietHours = settings.quietHours ?? DEFAULT_QUIET;
			const clock = options.now ?? Date.now;
			const store = new CalendarStore(databasePath);
			const engine = new CalendarEngine({ store, now: clock, intervalMs: intervalMinutes * MINUTE, timers: options.timers ?? true, ...(options.log ? { log: options.log } : {}) });
			options.onEngine?.(engine);
			let closed: Promise<void> | undefined;

			const zoneOf = (timeZone: string | undefined) => {
				const chosen = timeZone ?? zone;
				if (!isValidTimeZone(chosen)) throw new Error(`unknown time zone ${JSON.stringify(chosen)}`);
				return chosen;
			};

			const reminderView = (r: StoredReminder) => ({
				at: formatInstant(r.fireAt, zone), minutesBefore: r.minutes, action: r.action, state: r.state,
				...opt("note", r.note), ...opt("reason", r.reason), ...(r.firedAt !== undefined ? { firedAt: formatInstant(r.firedAt, zone) } : {}),
				...(r.key.includes(":catchup:") ? { catchUp: true } : {}),
			});

			const view = (event: CalendarEvent, reminders: readonly StoredReminder[]) => {
				const pending = reminders.filter((r) => r.state === "pending");
				return {
					id: event.id, title: event.title,
					start: event.allDay ? formatDate(localDate(event.startMs, event.timeZone)) : formatInstant(event.startMs, event.timeZone),
					...(event.endMs !== undefined ? { end: event.allDay ? formatDate(localDate(event.endMs - 1, event.timeZone)) : formatInstant(event.endMs, event.timeZone) } : {}),
					allDay: event.allDay, timeZone: event.timeZone,
					...opt("location", event.location), ...opt("description", event.description),
					category: event.category, importance: event.importance,
					...opt("preparation", event.preparation), ...opt("key", event.key),
					status: event.status, source: event.source, automaticReminders: event.reminders === undefined,
					reminders: reminders.map(reminderView),
					...(pending[0] !== undefined ? { nextReminder: formatInstant(pending[0].fireAt, zone) } : {}),
				};
			};

			/** One line on why these reminders: plan source, then each reminder. */
			const explain = (event: CalendarEvent, pending: readonly Reminder[]): string => {
				const source = event.reminders === undefined
					? `automatic plan for a ${event.importance}-importance ${event.category}${event.preparation ? " with preparation" : ""}`
					: event.reminders.length === 0 ? "no reminders requested" : "explicit reminders";
				if (pending.length === 0) return event.reminders?.length === 0 ? source : `${source}: no reminders left (the planned times have passed or the event has started)`;
				const base = baseTime(event);
				const parts = pending.map((r) => {
					if (r.key.includes(":catchup:")) return `${r.action} now (catch-up: the planned time already passed)`;
					const moved = Math.abs(r.fireAt - (base - r.minutes * MINUTE)) > MINUTE ? ", moved out of quiet hours" : "";
					return `${r.action} ${r.minutes === 0 ? (event.allDay ? "at 09:00 on the day" : "at the start") : `${duration(r.minutes)} before`} (${formatLocal(r.fireAt, zone)}${moved})`;
				});
				return `${source}: ${parts.join("; ")}`;
			};

			const persist = (event: CalendarEvent) => {
				const fired = store.reminders(event.id).filter((r) => r.state === "fired");
				store.save(event, planReminders(event, clock(), { timeZone: zone, quietHours, fired }));
			};

			/**
			 * A new or moved event must not be over already. Models often guess the wrong year or day for "today" or "next
			 * Tuesday" (a real run stored 2025 for a same-day meeting); the error names the current time so the model can
			 * resolve the date again instead of silently recording an event no reminder will ever fire for.
			 */
			const notOver = (times: Times, timeZone: string, now: number) => {
				if ((times.endMs ?? times.startMs) >= now - PAST_TOLERANCE_MS) return;
				throw new Error(`the event is already over: it ends before now (${formatInstant(now, timeZone)}). Resolve relative dates such as today or next Tuesday against this current time and try again.`);
			};

			const result = (event: CalendarEvent, extra: Record<string, unknown> = {}) => {
				const reminders = store.reminders(event.id);
				return { ...view(event, reminders), ...extra, plan: explain(event, reminders.filter((r) => r.state === "pending")) };
			};

			type Upserted = { status: "created" | "updated" | "unchanged" | "existing" | "revived"; event: CalendarEvent };

			const upsert = (input: EventInput, defaults: Defaults, call: PluginToolCall, mode: "create" | "import"): Upserted => {
				const timeZone = zoneOf(input.timeZone ?? defaults.timeZone);
				const times = timesOf(parseTime(input.start, timeZone), input.end, timeZone);
				const origin = call.conversationId ?? "";
				const id = eventId(input.key, origin, input.title, times.startMs);
				const existing = store.get(id);
				if (mode === "create" && existing?.status === "active") return { status: "existing", event: existing };
				const now = clock();
				// New or moved: an unchanged historical item may be re-imported, a move into the past may not.
				if (existing === undefined || existing.startMs !== times.startMs || existing.endMs !== times.endMs) notOver(times, timeZone, now);
				const reminders = explicitReminders(input.reminders);
				const next: CalendarEvent = {
					id, title: input.title, startMs: times.startMs, ...opt("endMs", times.endMs), allDay: times.allDay, timeZone,
					...opt("location", input.location || undefined), ...opt("description", input.description || undefined),
					category: (input.category ?? defaults.category ?? "other") as Category,
					importance: (input.importance ?? defaults.importance ?? "normal") as Importance,
					...opt("preparation", input.preparation?.trim() || undefined), ...opt("reminders", reminders),
					...opt("key", input.key), ...opt("origin", call.conversationId),
					status: "active", source: existing?.source ?? LOCAL_SOURCE, ...opt("externalId", existing?.externalId),
					createdAt: existing?.createdAt ?? now, updatedAt: now,
				};
				if (existing !== undefined && existing.status === "active" && fingerprint(existing) === fingerprint({ ...next, createdAt: existing.createdAt, updatedAt: existing.updatedAt })) {
					return { status: "unchanged", event: existing };
				}
				persist(next);
				return { status: existing === undefined ? "created" : existing.status === "cancelled" ? "revived" : "updated", event: next };
			};

			const known = (id: string) => {
				const event = store.get(id);
				if (event === undefined) throw new Error(`unknown event ${id}`);
				return event;
			};

			const tools: PluginTool[] = [
				tool(
					"create_event",
					"Register an event in the calendar; reminders are planned automatically (days ahead for presentations and deadlines, minutes for meetings) and delivered to this conversation, and prepare reminders make you research and draft material ahead of time. The same key (or title and start) in this conversation returns the existing event (existing: true).",
					createSchema,
					(args, call) => {
						const out = upsert(args, {}, call, "create");
						engine.arm();
						return result(out.event, out.status === "existing" || out.status === "revived" ? { existing: true, ...(out.status === "revived" ? { revived: true } : {}) } : {});
					},
				),
				tool(
					"list_events",
					"List events overlapping a time range (default the next 14 days), sorted by start, with their pending reminders.",
					listSchema,
					(args) => {
						const now = clock();
						const fromMs = args.from !== undefined ? parseTime(args.from, zone).ms : now;
						let toMs = fromMs + 14 * DAY;
						if (args.to !== undefined) {
							const parsed = parseTime(args.to, zone);
							toMs = parsed.allDay ? localToUtc(zone, addDays(parsed.date ?? localDate(parsed.ms, zone), 1)) - 1 : parsed.ms;
						}
						if (toMs < fromMs) throw new Error("to is before from");
						const { events, truncated } = store.list({ fromMs, toMs, ...opt("query", args.query), includeCancelled: args.includeCancelled ?? false, limit: 200 });
						return {
							now: formatInstant(now, zone), timeZone: zone,
							events: events.map((event) => view(event, store.reminders(event.id).filter((r) => r.state === "pending"))),
							truncated,
						};
					},
					{ readOnly: true },
				),
				tool("get_event", "Get one event with every reminder and its state (pending, fired, skipped with a reason).", Type.Object({ id: eventIdSchema }, { additionalProperties: false }), (args) => {
					const event = known(args.id);
					return view(event, store.reminders(event.id));
				}, { readOnly: true }),
				tool(
					"update_event",
					"Change an event; null clears an optional field (reminders: null returns to the automatic plan). Pending reminders are replanned; fired ones stay fired and never fire again. Moving start without end keeps the duration.",
					updateSchema,
					(args) => {
						const existing = known(args.id);
						if (existing.status !== "active") throw new Error(`event ${args.id} is cancelled; create it again to revive it`);
						const timeZone = zoneOf(args.timeZone ?? existing.timeZone);
						let times: Times = { startMs: existing.startMs, ...opt("endMs", existing.endMs), allDay: existing.allDay };
						if (args.start !== undefined || args.end !== undefined || (existing.allDay && timeZone !== existing.timeZone)) {
							const start = args.start !== undefined ? parseTime(args.start, timeZone) : parsedOf(existing, timeZone);
							if (typeof args.end === "string") times = timesOf(start, args.end, timeZone);
							else if (args.end === null || existing.endMs === undefined || start.allDay !== existing.allDay) times = timesOf(start, undefined, timeZone);
							else if (start.allDay) {
								const days = Math.max(1, Math.round((existing.endMs - existing.startMs) / DAY));
								times = { startMs: start.ms, endMs: localToUtc(timeZone, addDays(start.date ?? localDate(start.ms, timeZone), days)), allDay: true };
							} else times = { startMs: start.ms, endMs: start.ms + (existing.endMs - existing.startMs), allDay: false };
							notOver(times, timeZone, clock());
						}
						const field = <V>(value: V | null | undefined, current: V | undefined): V | undefined => (value === null ? undefined : value === undefined ? current : value);
						const reminders = args.reminders === null ? undefined : args.reminders !== undefined ? explicitReminders(args.reminders) : existing.reminders;
						const next: CalendarEvent = {
							id: existing.id, title: args.title ?? existing.title, startMs: times.startMs, ...opt("endMs", times.endMs), allDay: times.allDay, timeZone,
							...opt("location", field(args.location, existing.location) || undefined),
							...opt("description", field(args.description, existing.description) || undefined),
							category: (args.category ?? existing.category) as Category, importance: (args.importance ?? existing.importance) as Importance,
							...opt("preparation", field(args.preparation, existing.preparation)?.trim() || undefined), ...opt("reminders", reminders),
							...opt("key", existing.key), ...opt("origin", existing.origin), status: "active", source: existing.source, ...opt("externalId", existing.externalId),
							createdAt: existing.createdAt, updatedAt: clock(),
						};
						if (fingerprint(next) === fingerprint(existing)) return result(existing, { changed: false });
						persist(next);
						engine.arm();
						return result(next, { changed: true });
					},
				),
				tool("delete_event", "Cancel an event; its pending reminders are skipped. Creating it again revives it.", Type.Object({ id: eventIdSchema }, { additionalProperties: false }), (args) => {
					const existing = known(args.id);
					if (existing.status === "active") {
						store.cancel(existing.id, clock());
						engine.arm();
					}
					const event = known(args.id);
					return { ...view(event, store.reminders(event.id)), ...(existing.status !== "active" ? { alreadyCancelled: true } : {}) };
				}),
				tool(
					"import_events",
					"Register many events at once, e.g. every row of a WBS, roadmap or timeline you parsed. Upserts by id (give each item a stable key such as its WBS id, so a re-import updates instead of duplicating). One bad item never fails the batch: each item reports created, updated, unchanged or error.",
					importSchema,
					(args, call) => {
						const defaults = args.defaults ?? {};
						const counts = { created: 0, updated: 0, unchanged: 0, error: 0 };
						const items = (args.items as unknown[]).map((raw, index) => {
							const title = typeof raw === "object" && raw !== null && typeof (raw as { title?: unknown }).title === "string" ? (raw as { title: string }).title : undefined;
							try {
								if (!Value.Check(createSchema, raw)) throw new Error(`invalid item: ${errorsOf(createSchema, raw)}`);
								const out = upsert(raw, defaults, call, "import");
								const status = out.status === "created" ? "created" : out.status === "unchanged" ? "unchanged" : "updated";
								counts[status] += 1;
								const next = store.reminders(out.event.id).find((r) => r.state === "pending");
								return { index, id: out.event.id, title: out.event.title, status, ...(next !== undefined ? { nextReminder: `${next.action} ${formatInstant(next.fireAt, zone)}` } : {}) };
							} catch (error) {
								counts.error += 1;
								return { index, ...opt("title", title), status: "error" as const, error: error instanceof Error ? error.message : String(error) };
							}
						});
						engine.arm();
						return { ...counts, items, timeZone: zone };
					},
					{ validate: importEnvelope },
				),
			];

			return {
				tools,
				prompt: prompt(zone, intervalMinutes),
				storagePaths: [databasePath, `${databasePath}-wal`, `${databasePath}-shm`],
				start(runtime) {
					engine.start(runtime);
				},
				async close() {
					closed ??= (async () => {
						await engine.close();
						store.close();
					})();
					await closed;
				},
			};
		},
	});
}

export const calendarPlugin = createCalendarPlugin();
export type { CalendarEngine } from "./engine.ts";
