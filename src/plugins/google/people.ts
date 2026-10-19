import { Type } from "@earendil-works/pi-ai";
import type { PluginTool } from "../types.ts";
import { type Api, tool } from "./api.ts";

const BASE = "https://people.googleapis.com/v1";
const FIELDS = "names,emailAddresses,phoneNumbers,organizations";

type Person = {
	resourceName: string;
	names?: { displayName?: string }[];
	emailAddresses?: { value?: string }[];
	phoneNumbers?: { value?: string }[];
	organizations?: { name?: string; title?: string }[];
};

const person = (entry: Person) => ({
	name: entry.names?.[0]?.displayName,
	emails: (entry.emailAddresses ?? []).map((email) => email.value).filter(Boolean),
	...(entry.phoneNumbers?.length ? { phones: entry.phoneNumbers.map((phone) => phone.value).filter(Boolean) } : {}),
	...(entry.organizations?.[0] ? { organization: entry.organizations[0].name, title: entry.organizations[0].title } : {}),
});

export function peopleTools(api: Api): PluginTool[] {
	return [
		tool(
			"people_me",
			"The connected Google account: name and email address.",
			Type.Object({}, { additionalProperties: false }),
			true,
			async (_args, signal) => person(await api.json<Person>("GET", `${BASE}/people/me`, { query: { personFields: "names,emailAddresses" }, signal })),
		),
		tool(
			"people_search_contacts",
			"Search the user's Google contacts by name, email or phone (prefix match). Use it to find an email address before writing mail or inviting someone.",
			Type.Object(
				{ query: Type.String({ minLength: 1 }), maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "Default 10." })) },
				{ additionalProperties: false },
			),
			true,
			async ({ query, maxResults = 10 }, signal) => {
				const result = await api.json<{ results?: { person: Person }[] }>("GET", `${BASE}/people:searchContacts`, {
					query: { query, pageSize: maxResults, readMask: FIELDS },
					signal,
				});
				return { contacts: (result.results ?? []).map((entry) => person(entry.person)) };
			},
		),
	];
}
