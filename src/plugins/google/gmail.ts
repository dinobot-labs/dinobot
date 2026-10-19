import { Type } from "@earendil-works/pi-ai";
import type { PluginTool } from "../types.ts";
import { type Api, clip, segment, tool } from "./api.ts";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const SUMMARY_HEADERS = ["From", "To", "Cc", "Subject", "Date"];

type Header = { name: string; value: string };
type Part = { mimeType?: string; filename?: string; headers?: Header[]; body?: { data?: string; size?: number; attachmentId?: string }; parts?: Part[] };
type Message = { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: Part };

const header = (part: Part | undefined, name: string) => part?.headers?.find((entry) => entry.name.toLowerCase() === name.toLowerCase())?.value;

function summary(message: Message) {
	const headers: Record<string, string> = {};
	for (const name of SUMMARY_HEADERS) {
		const value = header(message.payload, name);
		if (value !== undefined) headers[name.toLowerCase()] = value;
	}
	return { id: message.id, threadId: message.threadId, ...headers, snippet: message.snippet ?? "", labels: message.labelIds ?? [] };
}

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
		.replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Plain-text body (text/plain preferred, else text/html stripped) and attachment names of a MIME tree. */
export function bodyOf(payload: Part | undefined): { text: string; attachments: { filename: string; mimeType: string; size: number }[] } {
	let plain: string | undefined;
	let html: string | undefined;
	const attachments: { filename: string; mimeType: string; size: number }[] = [];
	const walk = (part: Part | undefined) => {
		if (!part) return;
		if (part.filename) {
			attachments.push({ filename: part.filename, mimeType: part.mimeType ?? "application/octet-stream", size: part.body?.size ?? 0 });
		} else if (part.body?.data !== undefined) {
			if (part.mimeType === "text/plain") plain ??= decode(part.body.data);
			else if (part.mimeType === "text/html") html ??= decode(part.body.data);
		}
		for (const child of part.parts ?? []) walk(child);
	};
	walk(payload);
	return { text: plain ?? (html !== undefined ? htmlToText(html) : ""), attachments };
}

function full(message: Message, maxChars: number) {
	const { text, attachments } = bodyOf(message.payload);
	const body = clip(text, maxChars);
	return { ...summary(message), body: body.text, ...(body.truncated ? { bodyTruncated: true, bodyChars: body.totalChars } : {}), attachments };
}

/** RFC 2047 encoded-word for non-ASCII header values. */
function encodeHeader(value: string): string {
	return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function noNewlines(name: string, value: string): string {
	if (/[\r\n]/.test(value)) throw new Error(`${name} must not contain line breaks`);
	return value;
}

/** A base64url RFC 2822 message with a UTF-8 plain-text body. */
export function rawMessage(fields: { to: readonly string[]; cc?: readonly string[]; bcc?: readonly string[]; subject: string; body: string; inReplyTo?: string; references?: string }): string {
	const lines = [
		`To: ${fields.to.map((to) => noNewlines("to", to)).join(", ")}`,
		...(fields.cc?.length ? [`Cc: ${fields.cc.map((cc) => noNewlines("cc", cc)).join(", ")}`] : []),
		...(fields.bcc?.length ? [`Bcc: ${fields.bcc.map((bcc) => noNewlines("bcc", bcc)).join(", ")}`] : []),
		`Subject: ${encodeHeader(noNewlines("subject", fields.subject))}`,
		...(fields.inReplyTo ? [`In-Reply-To: ${noNewlines("inReplyTo", fields.inReplyTo)}`, `References: ${noNewlines("references", fields.references ?? fields.inReplyTo)}`] : []),
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: base64",
		"",
		Buffer.from(fields.body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
	];
	return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

const MaxChars = Type.Optional(Type.Integer({ minimum: 100, maximum: 200_000, description: "Body character limit (default 20000)." }));
const Addresses = Type.Array(Type.String({ minLength: 3 }), { maxItems: 100 });

export function gmailTools(api: Api, write: boolean): PluginTool[] {
	const read: PluginTool[] = [
		tool(
			"gmail_search",
			"Search the user's Gmail with Gmail search syntax (from:, to:, subject:, is:unread, newer_than:7d, has:attachment, label:, ...). Returns message summaries (headers and snippet), newest first.",
			Type.Object(
				{
					query: Type.String({ description: "Gmail search query; empty lists the newest messages." }),
					maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Default 10." })),
					pageToken: Type.Optional(Type.String()),
					includeSpamTrash: Type.Optional(Type.Boolean()),
				},
				{ additionalProperties: false },
			),
			true,
			async ({ query, maxResults = 10, pageToken, includeSpamTrash }, signal) => {
				const list = await api.json<{ messages?: { id: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>("GET", `${BASE}/messages`, {
					query: { q: query, maxResults, pageToken, includeSpamTrash },
					signal,
				});
				const messages = await Promise.all(
					(list.messages ?? []).map((message) =>
						api.json<Message>("GET", `${BASE}/messages/${segment(message.id)}`, { query: { format: "metadata", metadataHeaders: SUMMARY_HEADERS }, signal }),
					),
				);
				return { messages: messages.map(summary), ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}) };
			},
		),
		tool(
			"gmail_read_message",
			"Read one Gmail message: headers, plain-text body and attachment names.",
			Type.Object({ id: Type.String({ minLength: 1 }), maxChars: MaxChars }, { additionalProperties: false }),
			true,
			async ({ id, maxChars = 20_000 }, signal) => full(await api.json<Message>("GET", `${BASE}/messages/${segment(id)}`, { query: { format: "full" }, signal }), maxChars),
		),
		tool(
			"gmail_read_thread",
			"Read a Gmail conversation: every message in order with plain-text bodies. maxChars applies to each message.",
			Type.Object({ id: Type.String({ minLength: 1 }), maxChars: MaxChars }, { additionalProperties: false }),
			true,
			async ({ id, maxChars = 8_000 }, signal) => {
				const thread = await api.json<{ id: string; messages?: Message[] }>("GET", `${BASE}/threads/${segment(id)}`, { query: { format: "full" }, signal });
				return { id: thread.id, messages: (thread.messages ?? []).map((message) => full(message, maxChars)) };
			},
		),
		tool(
			"gmail_list_labels",
			"List the user's Gmail labels (system and user labels) with their ids.",
			Type.Object({}, { additionalProperties: false }),
			true,
			async (_args, signal) => {
				const labels = await api.json<{ labels?: { id: string; name: string; type: string }[] }>("GET", `${BASE}/labels`, { signal });
				return { labels: (labels.labels ?? []).map(({ id, name, type }) => ({ id, name, type })) };
			},
		),
	];
	if (!write) return read;
	return [
		...read,
		tool(
			"gmail_create_draft",
			"Create a Gmail draft (plain text). With replyToMessageId it becomes a reply in that thread (subject defaults to Re: original). Nothing is sent; use gmail_send_draft after the user confirms.",
			Type.Object(
				{
					to: Addresses,
					cc: Type.Optional(Addresses),
					bcc: Type.Optional(Addresses),
					subject: Type.Optional(Type.String({ maxLength: 998 })),
					body: Type.String({ maxLength: 500_000 }),
					replyToMessageId: Type.Optional(Type.String({ minLength: 1 })),
				},
				{ additionalProperties: false },
			),
			false,
			async ({ to, cc, bcc, subject, body, replyToMessageId }, signal) => {
				let threadId: string | undefined;
				let inReplyTo: string | undefined;
				let references: string | undefined;
				if (replyToMessageId !== undefined) {
					const original = await api.json<Message>("GET", `${BASE}/messages/${segment(replyToMessageId)}`, {
						query: { format: "metadata", metadataHeaders: ["Subject", "Message-ID", "References"] },
						signal,
					});
					threadId = original.threadId;
					inReplyTo = header(original.payload, "Message-ID");
					references = [header(original.payload, "References"), inReplyTo].filter(Boolean).join(" ") || undefined;
					const originalSubject = header(original.payload, "Subject") ?? "";
					subject ??= /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`;
				}
				const raw = rawMessage({ to, ...(cc ? { cc } : {}), ...(bcc ? { bcc } : {}), subject: subject ?? "", body, ...(inReplyTo ? { inReplyTo } : {}), ...(references ? { references } : {}) });
				const draft = await api.json<{ id: string; message: { id: string; threadId: string } }>("POST", `${BASE}/drafts`, {
					body: { message: { raw, ...(threadId ? { threadId } : {}) } },
					signal,
				});
				return { draftId: draft.id, messageId: draft.message.id, threadId: draft.message.threadId };
			},
		),
		tool(
			"gmail_send_draft",
			"Send an existing Gmail draft. Only after the user has seen and approved the draft. A draft can be sent once.",
			Type.Object({ draftId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
			false,
			async ({ draftId }, signal) => {
				const sent = await api.json<{ id: string; threadId: string }>("POST", `${BASE}/drafts/send`, { body: { id: draftId }, signal });
				return { sent: true, messageId: sent.id, threadId: sent.threadId };
			},
		),
		tool(
			"gmail_modify_labels",
			"Add or remove labels on a Gmail message (label ids from gmail_list_labels; e.g. UNREAD to mark unread, remove INBOX to archive).",
			Type.Object(
				{
					id: Type.String({ minLength: 1 }),
					add: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 })),
					remove: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 100 })),
				},
				{ additionalProperties: false },
			),
			false,
			async ({ id, add = [], remove = [] }, signal) => {
				const message = await api.json<Message>("POST", `${BASE}/messages/${segment(id)}/modify`, { body: { addLabelIds: add, removeLabelIds: remove }, signal });
				return { id: message.id, labels: message.labelIds ?? [] };
			},
		),
		tool(
			"gmail_trash_message",
			"Move a Gmail message to the trash (recoverable for 30 days).",
			Type.Object({ id: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
			false,
			async ({ id }, signal) => {
				const message = await api.json<Message>("POST", `${BASE}/messages/${segment(id)}/trash`, { signal });
				return { id: message.id, trashed: true };
			},
		),
	];
}
