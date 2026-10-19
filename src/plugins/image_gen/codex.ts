/**
 * The Codex images backend (openai/codex `codex-rs/codex-api/src/endpoint/images.rs`, `ext/image-generation`): a
 * ChatGPT-subscription login posts JSON to `<chatgpt backend>/codex/images/generations` or `/codex/images/edits`
 * with the login's bearer and `chatgpt-account-id`, and receives `{data: [{b64_json}]}`.
 */

export const CODEX_PROVIDER = "openai-codex";
export const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
export const DEFAULT_MODEL = "gpt-image-2";
/** Codex sends at most five reference images per edit. */
export const MAX_EDIT_IMAGES = 5;
export const SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;
export const QUALITIES = ["auto", "low", "medium", "high"] as const;
export type ImageSize = (typeof SIZES)[number];
export type ImageQuality = (typeof QUALITIES)[number];

const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const IMAGEGEN_REQUEST_ID = "x-codex-imagegen-request-id";
const MAX_ERROR_CHARS = 500;

export type ImageRequest = {
	readonly prompt: string;
	readonly background: "transparent" | "opaque";
	readonly model: string;
	readonly quality: ImageQuality;
	readonly size: ImageSize;
	/** Data URLs of the images to edit; absent for a new image. */
	readonly images?: readonly string[];
};

export type ImageResult = {
	readonly bytes: Uint8Array;
	readonly mimeType: ImageMime;
	readonly requestId?: string;
	/** What the backend reports it produced (`size`, `quality`, `background`, `output_format`). */
	readonly reported: Readonly<Record<string, string>>;
};

export class ImageGenError extends Error {}

/** The ChatGPT account id inside a Codex access token; undefined for anything that is not such a JWT. */
export function chatgptAccountId(token: string): string | undefined {
	const payload = token.split(".")[1];
	if (!payload) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
		const auth = claims[JWT_AUTH_CLAIM] as { chatgpt_account_id?: unknown } | undefined;
		const id = auth?.chatgpt_account_id;
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

/** `<base>/codex/images/<operation>`, accepting a base that already ends in `/codex`. */
export function imagesUrl(baseUrl: string, operation: "generations" | "edits"): string {
	const base = baseUrl.trim().replace(/\/+$/, "");
	return `${base.endsWith("/codex") ? base : `${base}/codex`}/images/${operation}`;
}

/** The JSON body Codex sends: generations carry no `images`; edits carry `{image_url}` references. */
export function requestBody(request: ImageRequest): Record<string, unknown> {
	return {
		...(request.images ? { images: request.images.map((image_url) => ({ image_url })) } : {}),
		prompt: request.prompt,
		background: request.background,
		model: request.model,
		quality: request.quality,
		size: request.size,
	};
}

export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** The image type by magic bytes; undefined for anything else. Names and extensions are never trusted. */
export function sniffImage(bytes: Uint8Array): ImageMime | undefined {
	const at = (offset: number, ascii: string) => [...ascii].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
	if (bytes.length >= 8 && bytes[0] === 0x89 && at(1, "PNG\r\n\x1a\n")) return "image/png";
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes.length >= 12 && at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
	if (bytes.length >= 6 && (at(0, "GIF87a") || at(0, "GIF89a"))) return "image/gif";
	return undefined;
}

/** A bounded, token-free description of a failed backend response. */
async function failure(response: Response, token: string): Promise<string> {
	let detail = "";
	try {
		const text = await response.text();
		try {
			const json = JSON.parse(text) as { error?: { message?: unknown; code?: unknown } | string; detail?: unknown; message?: unknown };
			const error = json.error;
			const message = typeof error === "string" ? error : (error?.message ?? json.detail ?? json.message);
			detail = typeof message === "string" ? message : JSON.stringify(message ?? json);
		} catch {
			detail = text;
		}
	} catch {
		detail = "";
	}
	detail = detail.split(token).join("[token]").replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_CHARS);
	const parts = [`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`];
	if (detail) parts.push(detail);
	if (response.status === 401 || response.status === 403) parts.push("the ChatGPT login was rejected; log in again with /login (OpenAI Codex / ChatGPT Plus·Pro)");
	if (response.status === 429) {
		const reset = Number(response.headers.get("x-codex-primary-reset-at"));
		parts.push(
			Number.isFinite(reset) && reset > 0
				? `image generation limit of this ChatGPT plan reached; resets at ${new Date(reset * 1000).toISOString()}`
				: "image generation limit of this ChatGPT plan reached",
		);
	}
	const requestId = response.headers.get(IMAGEGEN_REQUEST_ID);
	if (requestId) parts.push(`request ${requestId}`);
	return parts.join("; ");
}

/** One generate or edit request against the Codex images backend. */
export async function requestImage(
	request: ImageRequest,
	login: { readonly token: string; readonly accountId: string; readonly baseUrl: string },
	options: { readonly signal?: AbortSignal; readonly fetch?: typeof fetch } = {},
): Promise<ImageResult> {
	const url = imagesUrl(login.baseUrl, request.images ? "edits" : "generations");
	let response: Response;
	try {
		response = await (options.fetch ?? fetch)(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${login.token}`,
				"chatgpt-account-id": login.accountId,
				originator: "pi",
				accept: "application/json",
				"content-type": "application/json",
			},
			body: JSON.stringify(requestBody(request)),
			redirect: "error",
			...(options.signal ? { signal: options.signal } : {}),
		});
	} catch (error) {
		if (options.signal?.aborted) throw new ImageGenError(`image request cancelled or timed out: ${String(options.signal.reason ?? "aborted")}`);
		const message = error instanceof Error ? error.message : String(error);
		throw new ImageGenError(`image request failed: ${message.split(login.token).join("[token]")}`);
	}
	if (!response.ok) throw new ImageGenError(`image generation failed: ${await failure(response, login.token)}`);
	const requestId = response.headers.get(IMAGEGEN_REQUEST_ID) ?? undefined;
	let json: { data?: { b64_json?: unknown }[] } & Record<string, unknown>;
	try {
		json = (await response.json()) as typeof json;
	} catch {
		throw new ImageGenError(`image generation returned a response that is not JSON${requestId ? ` (request ${requestId})` : ""}`);
	}
	const b64 = json.data?.[0]?.b64_json;
	if (typeof b64 !== "string" || b64.length === 0) throw new ImageGenError(`image generation returned no image data${requestId ? ` (request ${requestId})` : ""}`);
	const bytes = Buffer.from(b64, "base64");
	const mimeType = sniffImage(bytes);
	if (!mimeType) throw new ImageGenError(`image generation returned data that is not a PNG, JPEG, WebP or GIF image${requestId ? ` (request ${requestId})` : ""}`);
	const reported: Record<string, string> = {};
	for (const key of ["size", "quality", "background", "output_format"]) if (typeof json[key] === "string") reported[key] = json[key] as string;
	return { bytes: new Uint8Array(bytes), mimeType, ...(requestId ? { requestId } : {}), reported };
}
