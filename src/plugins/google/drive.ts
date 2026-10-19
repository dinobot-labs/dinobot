import { Type } from "@earendil-works/pi-ai";
import type { PluginTool } from "../types.ts";
import { type Api, clip, segment, tool } from "./api.ts";

const BASE = "https://www.googleapis.com/drive/v3";
const FIELDS = "id,name,mimeType,modifiedTime,size,webViewLink,owners(emailAddress),parents,trashed";
const MAX_DOWNLOAD = 10 * 1024 * 1024;

type File = { id: string; name: string; mimeType: string; modifiedTime?: string; size?: string; webViewLink?: string; owners?: { emailAddress?: string }[]; parents?: string[]; trashed?: boolean };

const fileSummary = (file: File) => ({
	id: file.id,
	name: file.name,
	mimeType: file.mimeType,
	...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}),
	...(file.size ? { size: Number(file.size) } : {}),
	...(file.owners?.[0]?.emailAddress ? { owner: file.owners[0].emailAddress } : {}),
	...(file.webViewLink ? { link: file.webViewLink } : {}),
	...(file.trashed ? { trashed: true } : {}),
});

/** Google-native files are exported to text; everything else is read only if it is text. */
const EXPORTS: Record<string, string> = {
	"application/vnd.google-apps.document": "text/markdown",
	"application/vnd.google-apps.spreadsheet": "text/csv",
	"application/vnd.google-apps.presentation": "text/plain",
	"application/vnd.google-apps.drawing": "image/svg+xml",
	"application/vnd.google-apps.script": "application/vnd.google-apps.script+json",
};
const TEXT = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|csv|x-sh|sql|toml))/;

/** A literal for the Drive query language: backslashes and quotes escaped. */
export function driveLiteral(value: string): string {
	return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel();
			throw new Error(`file is larger than ${limit} bytes`);
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

export function driveTools(api: Api, write: boolean): PluginTool[] {
	const read: PluginTool[] = [
		tool(
			"drive_search",
			"Search the user's Google Drive. `text` searches names and contents; `query` takes raw Drive query syntax (e.g. mimeType='application/vnd.google-apps.spreadsheet' and modifiedTime > '2026-10-01'). Without either, lists recently modified files.",
			Type.Object(
				{
					text: Type.Optional(Type.String({ minLength: 1 })),
					query: Type.Optional(Type.String({ minLength: 1 })),
					includeTrashed: Type.Optional(Type.Boolean()),
					maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Default 20." })),
					pageToken: Type.Optional(Type.String()),
				},
				{ additionalProperties: false },
			),
			true,
			async ({ text, query, includeTrashed = false, maxResults = 20, pageToken }, signal) => {
				const clauses = [
					...(text !== undefined ? [`(name contains ${driveLiteral(text)} or fullText contains ${driveLiteral(text)})`] : []),
					...(query !== undefined ? [`(${query})`] : []),
					...(includeTrashed ? [] : ["trashed = false"]),
				];
				const list = await api.json<{ files?: File[]; nextPageToken?: string }>("GET", `${BASE}/files`, {
					query: {
						q: clauses.join(" and "),
						pageSize: maxResults,
						pageToken,
						fields: `nextPageToken,files(${FIELDS})`,
						...(text === undefined ? { orderBy: "modifiedTime desc" } : {}),
						supportsAllDrives: true,
						includeItemsFromAllDrives: true,
					},
					signal,
				});
				return { files: (list.files ?? []).map(fileSummary), ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}) };
			},
		),
		tool(
			"drive_get_file",
			"Metadata of one Drive file (name, type, owner, modified time, link).",
			Type.Object({ fileId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
			true,
			async ({ fileId }, signal) => fileSummary(await api.json<File>("GET", `${BASE}/files/${segment(fileId)}`, { query: { fields: FIELDS, supportsAllDrives: true }, signal })),
		),
		tool(
			"drive_read_file",
			"Read a Drive file as text: Google Docs as Markdown, Sheets as CSV (first sheet), Slides as plain text, other text files as they are. Binary files (PDF, images, Office) are refused.",
			Type.Object(
				{ fileId: Type.String({ minLength: 1 }), maxChars: Type.Optional(Type.Integer({ minimum: 100, maximum: 500_000, description: "Default 50000." })) },
				{ additionalProperties: false },
			),
			true,
			async ({ fileId, maxChars = 50_000 }, signal) => {
				const file = await api.json<File>("GET", `${BASE}/files/${segment(fileId)}`, { query: { fields: FIELDS, supportsAllDrives: true }, signal });
				const exportType = EXPORTS[file.mimeType];
				let response: Response;
				if (exportType !== undefined) {
					response = await api.raw(`${BASE}/files/${segment(fileId)}/export`, { query: { mimeType: exportType }, signal });
				} else if (TEXT.test(file.mimeType)) {
					response = await api.raw(`${BASE}/files/${segment(fileId)}`, { query: { alt: "media", supportsAllDrives: true }, signal });
				} else {
					throw new Error(`${file.name} is ${file.mimeType}; only Google Docs/Sheets/Slides and text files can be read as text`);
				}
				const bytes = await readCapped(response, MAX_DOWNLOAD);
				let content: string;
				try {
					content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				} catch {
					throw new Error(`${file.name} is not valid UTF-8 text`);
				}
				const cut = clip(content, maxChars);
				return { ...fileSummary(file), ...(exportType ? { exportedAs: exportType } : {}), content: cut.text, ...(cut.truncated ? { truncated: true, totalChars: cut.totalChars } : {}) };
			},
		),
	];
	if (!write) return read;
	return [
		...read,
		tool(
			"drive_create_text_file",
			"Create a file in the user's Drive from text. asGoogleDoc converts it to a Google Doc (Markdown is converted). Only files dinobot created can be changed later.",
			Type.Object(
				{
					name: Type.String({ minLength: 1, maxLength: 1_000 }),
					content: Type.String({ maxLength: 5_000_000 }),
					mimeType: Type.Optional(Type.String({ minLength: 1, description: "Default text/plain; e.g. text/markdown, text/csv." })),
					asGoogleDoc: Type.Optional(Type.Boolean()),
					parentId: Type.Optional(Type.String({ minLength: 1, description: "Folder id; default My Drive root." })),
				},
				{ additionalProperties: false },
			),
			false,
			async ({ name, content, mimeType = "text/plain", asGoogleDoc = false, parentId }, signal) => {
				const boundary = `dinobot-${crypto.randomUUID()}`;
				const metadata = {
					name,
					...(asGoogleDoc ? { mimeType: "application/vnd.google-apps.document" } : {}),
					...(parentId ? { parents: [parentId] } : {}),
				};
				const body = [
					`--${boundary}`,
					"Content-Type: application/json; charset=UTF-8",
					"",
					JSON.stringify(metadata),
					`--${boundary}`,
					`Content-Type: ${mimeType}; charset=UTF-8`,
					"",
					content,
					`--${boundary}--`,
					"",
				].join("\r\n");
				const response = await api.raw("https://www.googleapis.com/upload/drive/v3/files", {
					query: { uploadType: "multipart", fields: FIELDS, supportsAllDrives: true },
					method: "POST",
					rawBody: body,
					contentType: `multipart/related; boundary=${boundary}`,
					signal,
				});
				return fileSummary((await response.json()) as File);
			},
		),
	];
}
