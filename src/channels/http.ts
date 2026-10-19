import { FILE_BYTES, parseInboundFiles } from "../core/message-files.ts";
import { parseAskChoice } from "./ask-buttons.ts";
import { TELEGRAM_INPUT_UNITS, TELEGRAM_MESSAGE_PREFIX } from "./telegram-media.ts";
import { validChannelName } from "../core/channel-identity.ts";
import { parseInboundImages } from "../core/message-images.ts";
import type { ChannelAdapter, HandlerOptions, InboundImage, InboundMessage, MessageHandler } from "./types.ts";

/**
 * Channel-neutral HTTP entry point, for the gateway, internal tools, and local testing.
 * POST /v1/messages with an InboundMessage body (channel defaults to "http"); replies with BotReply.
 */
export function httpChannel(port: number): ChannelAdapter & { readonly url: () => URL } {
	let server: ReturnType<typeof Bun.serve> | undefined;
	let active = 0;
	return {
		name: "http",
		url: () => {
			if (server === undefined) throw new Error("http channel is not started");
			return server.url;
		},
		async start(handler: MessageHandler, nativeHandler?: MessageHandler) {
			if (server) throw new Error("http channel already started");
			const receive = async (request: Request, server: Bun.Server<undefined>, native: boolean) => {
				if (active >= 32) return Response.json({ error: "channel busy" }, { status: 503, headers: { "retry-after": "1" } });
				active++;
				try {
					const parsed = parseMessage(await request.json().catch(() => undefined));
					if (typeof parsed === "string") return Response.json({ error: parsed }, { status: 400 });
					const { options, ...message } = parsed;
					if (native && (message.files?.length || !["telegram", "discord", "slack"].includes(message.channel) || !/^\/(?:models|model|new)(?=\s|$)/.test(message.text))) {
						return Response.json({ error: "unsupported native control message" }, { status: 400 });
					}
					server.timeout(request, 0); // admitted turns may outlive transport idle timeout
					if (!native && (request.headers.get("accept") ?? "").includes(NDJSON)) {
						active++; // the stream owns its own slot until it closes
						return progressStream(message, handler, request.signal, () => active--, options);
					}
					return Response.json(await (native ? nativeHandler! : handler)(message, request.signal, undefined, options));
				} catch {
					return Response.json({ error: "message processing unavailable" }, { status: 503 });
				} finally { active--; }
			};
			server = Bun.serve({
				hostname: "127.0.0.1",
				port,
				maxRequestBodySize: 40 * 1024 * 1024, // one 20 MiB file + four 2 MiB images as base64 and envelope
				fetch: () => new Response("Not found", { status: 404 }),
				idleTimeout: 15, // bound idle request-body reads; disable only after admission
				routes: {
					"/healthz": new Response("ok"),
					"/v1/capabilities": Response.json({files:{version:1,maxBytes:FILE_BYTES}}),
					"/v1/native/messages": nativeHandler
						? { POST: (request, server) => receive(request, server, true) }
						: new Response("Not found", { status: 404 }),
					"/v1/messages": {
						POST: (request, server) => receive(request, server, false),
					},
				},
			});
		},
		async stop() {
			await server?.stop(true);
			server = undefined;
		},
	};
}

export const NDJSON = "application/x-ndjson";
/** Keep-alive spacing of a progress stream; clients treat several missed beats as a dead core. */
export const HEARTBEAT_MS = 10_000;

/**
 * The reply as newline-delimited JSON (ADR 0047): `{"type":"progress","event":ProgressEvent}` lines while the turn runs,
 * `{"type":"heartbeat"}` every HEARTBEAT_MS, then exactly one terminal `{"type":"reply","reply":BotReply}` or
 * `{"type":"error"}`. Progress is dropped, never queued without bound, when the client reads slower than events arrive.
 */
function progressStream(message: InboundMessage, handler: MessageHandler, signal: AbortSignal, release: () => void, options: HandlerOptions): Response {
	const encoder = new TextEncoder();
	let closed = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	const body = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				const write = (value: unknown, essential = false) => {
					if (closed) return;
					if (!essential && (controller.desiredSize ?? 0) <= 0) return;
					try {
						controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
					} catch {
						closed = true;
					}
				};
				const finish = (value: unknown) => {
					write(value, true);
					if (closed) return;
					closed = true;
					clearInterval(timer);
					try {
						controller.close();
					} catch {}
				};
				timer = setInterval(() => write({ type: "heartbeat" }, true), HEARTBEAT_MS);
				write({ type: "heartbeat" }, true);
				void Promise.resolve()
					.then(() => handler(message, signal, (event) => write({ type: "progress", event }), options))
					.then(
						(reply) => finish({ type: "reply", reply }),
						() => finish({ type: "error" }),
					)
					.finally(() => {
						clearInterval(timer);
						release();
					});
			},
			cancel() {
				closed = true;
				clearInterval(timer);
			},
		},
		{ highWaterMark: 64 },
	);
	return new Response(body, { headers: { "content-type": NDJSON, "cache-control": "no-store" } });
}

function parseMessage(body: unknown): (InboundMessage & { options: HandlerOptions }) | string {
	if (typeof body !== "object" || body === null) return "body must be a JSON object";
	const record = body as Record<string, unknown>;
	if (record.whenBusy !== undefined && record.whenBusy !== "steer") return 'whenBusy must be "steer"';
	if (record.channel !== undefined && (typeof record.channel !== "string" || !validChannelName(record.channel))) return "channel must be non-empty and contain no colon";
	const textLimit = record.channel === "telegram" && typeof record.text === "string" && record.text.startsWith(TELEGRAM_MESSAGE_PREFIX) ? TELEGRAM_INPUT_UNITS : 65_536;
	if (typeof record.text === "string" && record.text.length > textLimit) return `text exceeds ${textLimit} UTF-16 code units`;
	const choice = record.choice === undefined ? undefined : parseAskChoice(record.choice);
	if (record.choice !== undefined && !choice) return "choice must be {askId, option}";
	const files = parseInboundFiles(record.files);
	if (typeof files === "string") return files;
	const images = parseInboundImages(record.images);
	if (typeof images === "string") return images;
	for (const field of ["threadKey", "messageId", "userId"] as const) {
		if (typeof record[field] !== "string" || record[field] === "") return `${field} must be a non-empty string`;
	}
	if (typeof record.text !== "string" || (record.text === "" && images.length === 0 && files.length === 0)) {
		return "text must be a non-empty string";
	}
	return {
		channel: typeof record.channel === "string" && record.channel !== "" ? record.channel : "http",
		threadKey: record.threadKey as string,
		messageId: record.messageId as string,
		userId: record.userId as string,
		text: record.text as string,
		...(choice ? { choice } : {}),
		...(files.length ? { files } : {}),
		...(images.length > 0 ? { images: images as readonly InboundImage[] } : {}),
		options: record.whenBusy === "steer" ? { whenBusy: "steer" } : {},
	};
}
