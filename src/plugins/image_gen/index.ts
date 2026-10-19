import { Type } from "@earendil-works/pi-ai";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { definePlugin, PluginContent, type PluginTool, type PluginToolCall } from "../types.ts";
import {
	CODEX_PROVIDER,
	chatgptAccountId,
	DEFAULT_BASE_URL,
	DEFAULT_MODEL,
	ImageGenError,
	type ImageMime,
	type ImageQuality,
	type ImageSize,
	MAX_EDIT_IMAGES,
	QUALITIES,
	requestImage,
	SIZES,
	sniffImage,
} from "./codex.ts";

/** Largest reference image an edit reads (the inbound attachment limit). */
export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300_000;
const EXTENSIONS: Readonly<Record<ImageMime, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

const config = Type.Object(
	{
		/** Image model the Codex backend runs. Default: `gpt-image-2` (what Codex sends). */
		model: Type.Optional(Type.String({ minLength: 1 })),
		/** Where generated images are saved, relative to the conversation's working directory. Default: `generated_images`. */
		outputDir: Type.Optional(Type.String({ minLength: 1 })),
		/** ChatGPT backend base URL; tests and proxies only. Default: the `openai-codex` provider's (`https://chatgpt.com/backend-api`). */
		baseUrl: Type.Optional(Type.String({ pattern: "^https?://" })),
		/** Upper bound of one image request. Default: 300000 ms. */
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 900_000 })),
	},
	{ additionalProperties: false },
);

type Config = {
	readonly model?: string;
	readonly outputDir?: string;
	readonly baseUrl?: string;
	readonly timeoutMs?: number;
};

type Args = {
	readonly prompt: string;
	readonly transparentBackground: boolean;
	readonly referencedImagePaths: readonly string[];
	readonly size: ImageSize;
	readonly quality: ImageQuality;
};

const inputSchema = {
	type: "object",
	properties: {
		prompt: { type: "string", minLength: 1, maxLength: 32000, description: "What to draw, or for edits what to change. Write a complete, specific description." },
		transparent_background: { type: "boolean", description: "Transparent background (cutouts, logos, background removal). Default false. For edits, keep existing transparency unless asked." },
		referenced_image_paths: {
			type: "array",
			items: { type: "string", minLength: 1 },
			maxItems: MAX_EDIT_IMAGES,
			description: `Edit mode: local PNG/JPEG/WebP/GIF files to edit or use as references (at most ${MAX_EDIT_IMAGES}; relative paths resolve against the working directory). Omit for a new image.`,
		},
		size: { type: "string", enum: [...SIZES], description: "Output size. Default auto." },
		quality: { type: "string", enum: [...QUALITIES], description: "Output quality. Default auto; high takes longer." },
	},
	required: ["prompt"],
	additionalProperties: false,
} as const;

const PROMPT = [
	"image_gen_generate creates or edits images through the deployment's ChatGPT (Codex) subscription login (`/login` → OpenAI Codex).",
	"- Use it when the user asks for a picture, illustration, diagram, logo, icon, meme, mockup or other visual, or wants an existing image changed (add/remove elements, recolor, restyle, cut out the background). Generate directly; do not ask for confirmation.",
	"- New image: pass only `prompt` (plus `transparent_background`, `size`, `quality` when needed); edit: also pass `referenced_image_paths` with the local files to edit.",
	"- In codemode, call it in its own cell and await it there (usually 20-60 seconds, at most the request timeout). Do not print the base64; the image is attached to the result automatically.",
	"- Tell the user the saved path (default `generated_images/` under the working directory); the image is not sent to the chat channel by itself. Without a ChatGPT login the tool fails and says how to log in; the plan's image limit applies.",
].join("\n");

function parseArgs(raw: unknown): Args {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ImageGenError("arguments must be an object");
	const value = raw as Record<string, unknown>;
	const known = new Set(Object.keys(inputSchema.properties));
	const unknown = Object.keys(value).filter((key) => !known.has(key));
	if (unknown.length) throw new ImageGenError(`unknown argument(s): ${unknown.join(", ")}`);
	const prompt = value.prompt;
	if (typeof prompt !== "string" || prompt.trim().length === 0) throw new ImageGenError("`prompt` must be a non-empty string");
	if (prompt.length > inputSchema.properties.prompt.maxLength) throw new ImageGenError(`\`prompt\` must be at most ${inputSchema.properties.prompt.maxLength} characters`);
	const transparent = value.transparent_background ?? false;
	if (typeof transparent !== "boolean") throw new ImageGenError("`transparent_background` must be a boolean");
	const paths = value.referenced_image_paths ?? [];
	if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string" && path.length > 0)) throw new ImageGenError("`referenced_image_paths` must be an array of paths");
	if (paths.length > MAX_EDIT_IMAGES) throw new ImageGenError(`\`referenced_image_paths\` must contain at most ${MAX_EDIT_IMAGES} paths`);
	const size = value.size ?? "auto";
	if (!(SIZES as readonly unknown[]).includes(size)) throw new ImageGenError(`\`size\` must be one of ${SIZES.join(", ")}`);
	const quality = value.quality ?? "auto";
	if (!(QUALITIES as readonly unknown[]).includes(quality)) throw new ImageGenError(`\`quality\` must be one of ${QUALITIES.join(", ")}`);
	return { prompt, transparentBackground: transparent, referencedImagePaths: paths as string[], size: size as ImageSize, quality: quality as ImageQuality };
}

/** A reference image as a data URL; the type comes from its bytes, never from its name. */
async function referenceImage(path: string): Promise<string> {
	let size: number;
	try {
		const info = await stat(path);
		if (!info.isFile()) throw new ImageGenError(`referenced image ${path} is not a file`);
		size = info.size;
	} catch (error) {
		if (error instanceof ImageGenError) throw error;
		throw new ImageGenError(`unable to read referenced image ${path}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
	}
	if (size > MAX_REFERENCE_BYTES) throw new ImageGenError(`referenced image ${path} is ${size} bytes; the limit is ${MAX_REFERENCE_BYTES}`);
	const bytes = await readFile(path);
	const mime = sniffImage(bytes);
	if (!mime) throw new ImageGenError(`referenced image ${path} is not a PNG, JPEG, WebP or GIF image`);
	return `data:${mime};base64,${bytes.toString("base64")}`;
}

/**
 * Save under `<cwd>/<outputDir>` with a fresh name. The directory must be a real directory (not a link), and the
 * file is created exclusively, so a save never overwrites or writes through an existing file.
 */
async function saveImage(directory: string, bytes: Uint8Array, mime: ImageMime, now: Date): Promise<string> {
	await mkdir(directory, { recursive: true });
	const info = await lstat(directory);
	if (info.isSymbolicLink() || !info.isDirectory()) throw new ImageGenError(`image output directory ${directory} is not a real directory`);
	const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
	const path = resolve(directory, `image-${stamp}-${randomBytes(4).toString("hex")}.${EXTENSIONS[mime]}`);
	const handle = await open(path, "wx", 0o644);
	try {
		await handle.writeFile(bytes);
	} finally {
		await handle.close();
	}
	return path;
}

function generateTool(settings: Config): PluginTool {
	return {
		name: "generate",
		description:
			"Generate a new image from a prompt, or edit local images (referenced_image_paths), with the ChatGPT (Codex) subscription login. Saves the image under the working directory and returns it with its path. Usually takes 20-60 seconds; a codemode cell waits up to the request timeout (default 5 minutes).",
		inputSchema,
		inlineSchema: true,
		maxDurationMs: settings.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		async execute(raw: unknown, call: PluginToolCall) {
			const args = parseArgs(raw);
			const cwd = call.cwd ?? process.cwd();
			const login = call.providerLogin ? await call.providerLogin(CODEX_PROVIDER) : undefined;
			if (!login) {
				throw new ImageGenError(
					"image generation needs a ChatGPT (Codex) subscription login, and none is stored. Run /login and choose OpenAI Codex (ChatGPT Plus/Pro), then retry.",
				);
			}
			const accountId = chatgptAccountId(login.apiKey);
			if (!accountId) throw new ImageGenError("the stored openai-codex credential is not a ChatGPT login token; log in again with /login (OpenAI Codex)");
			const images = args.referencedImagePaths.length
				? await Promise.all(args.referencedImagePaths.map((path) => referenceImage(isAbsolute(path) ? path : resolve(cwd, path))))
				: undefined;
			const timeout = AbortSignal.timeout(settings.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			const result = await requestImage(
				{
					prompt: args.prompt,
					background: args.transparentBackground ? "transparent" : "opaque",
					model: settings.model ?? DEFAULT_MODEL,
					quality: args.quality,
					size: args.size,
					...(images ? { images } : {}),
				},
				{ token: login.apiKey, accountId, baseUrl: settings.baseUrl ?? login.baseUrl ?? DEFAULT_BASE_URL },
				{ signal: call.signal ? AbortSignal.any([call.signal, timeout]) : timeout },
			);
			const directory = resolve(cwd, settings.outputDir ?? "generated_images");
			const path = await saveImage(directory, result.bytes, result.mimeType, new Date());
			const summary = {
				path,
				mode: images ? "edit" : "generate",
				mimeType: result.mimeType,
				bytes: result.bytes.byteLength,
				...result.reported,
				...(result.requestId ? { requestId: result.requestId } : {}),
			};
			return new PluginContent([
				{ type: "image", mimeType: result.mimeType, data: Buffer.from(result.bytes).toString("base64") },
				{ type: "text", text: `Saved generated image to ${path}\n${JSON.stringify(summary)}` },
			]);
		},
	};
}

/**
 * Image generation and editing through the deployment's ChatGPT (Codex) subscription login (ADR 0088). On by default:
 * it brings no secret of its own (the host lends the stored `openai-codex` login per call), `load` does no I/O, and
 * without that login every call fails with login guidance before any network request. `plugins.image_gen: false`
 * turns it off.
 */
export const imageGenPlugin = definePlugin({
	id: "image_gen",
	enabledByDefault: true,
	providerLogins: [CODEX_PROVIDER],
	config,
	load: (settings: Config) => ({ tools: [generateTool(settings)], prompt: PROMPT }),
});
