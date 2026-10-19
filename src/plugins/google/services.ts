/**
 * Google Workspace services this plugin talks to (GA REST APIs) and the OAuth scopes each needs. Scopes are the
 * least that cover the service's tools: read-only scopes unless `write: true`.
 */

const AUTH = "https://www.googleapis.com/auth/";

export const SERVICE_IDS = ["gmail", "calendar", "drive", "people"] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

const SCOPES: Record<ServiceId, { read: readonly string[]; write: readonly string[] }> = {
	gmail: { read: [`${AUTH}gmail.readonly`], write: [`${AUTH}gmail.modify`] },
	calendar: { read: [`${AUTH}calendar.readonly`], write: [`${AUTH}calendar.readonly`, `${AUTH}calendar.events`] },
	drive: { read: [`${AUTH}drive.readonly`], write: [`${AUTH}drive.readonly`, `${AUTH}drive.file`] },
	people: { read: [`${AUTH}userinfo.profile`, `${AUTH}userinfo.email`, `${AUTH}contacts.readonly`], write: [`${AUTH}userinfo.profile`, `${AUTH}userinfo.email`, `${AUTH}contacts.readonly`] },
};

export function scopesFor(services: readonly ServiceId[], write: boolean): string[] {
	return [...new Set(services.flatMap((service) => SCOPES[service][write ? "write" : "read"]))];
}

/** Broader scopes that include a narrower one, plus Google's short aliases in token responses. */
const IMPLIED_BY: Record<string, readonly string[]> = {
	[`${AUTH}gmail.readonly`]: [`${AUTH}gmail.modify`, "https://mail.google.com/"],
	[`${AUTH}gmail.modify`]: ["https://mail.google.com/"],
	[`${AUTH}calendar.readonly`]: [`${AUTH}calendar`],
	[`${AUTH}calendar.events`]: [`${AUTH}calendar`],
	[`${AUTH}drive.readonly`]: [`${AUTH}drive`],
	[`${AUTH}drive.file`]: [`${AUTH}drive`],
	[`${AUTH}userinfo.profile`]: ["profile"],
	[`${AUTH}userinfo.email`]: ["email"],
};

/** Whether a granted scope set covers a needed scope. */
export function scopeGranted(needed: string, granted: ReadonlySet<string>): boolean {
	return granted.has(needed) || (IMPLIED_BY[needed] ?? []).some((scope) => granted.has(scope));
}
