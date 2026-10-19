import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBotModels } from "../src/auth/index.ts";
import { openCredentialFile } from "../src/auth/store.ts";
import { anthropicToolErrorPayload } from "../src/core/anthropic-tool-errors.ts";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };

test("an error tool_result keeps only text; its images move right after the message's tool results", () => {
	const payload = {
		model: "claude",
		messages: [
			{ role: "user", content: "hi" },
			{ role: "assistant", content: [{ type: "tool_use", id: "a", name: "x", input: {} }, { type: "tool_use", id: "b", name: "x", input: {} }] },
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "a", is_error: true, content: [{ type: "text", text: "boom" }, image] },
					{ type: "tool_result", tool_use_id: "b", is_error: false, content: [{ type: "text", text: "ok" }, image] },
					{ type: "text", text: "trailing" },
				],
			},
		],
	};
	const fixed = anthropicToolErrorPayload(payload) as { model: string; messages: { content: unknown }[] };
	expect(fixed.model).toBe("claude");
	expect(fixed.messages.slice(0, 2)).toEqual(payload.messages.slice(0, 2));
	expect(fixed.messages[2]?.content as unknown[]).toEqual([
		{ type: "tool_result", tool_use_id: "a", is_error: true, content: [{ type: "text", text: "boom" }, { type: "text", text: "[1 non-text block(s) of this failed tool result are attached after the tool results]" }] },
		{ type: "tool_result", tool_use_id: "b", is_error: false, content: [{ type: "text", text: "ok" }, image] },
		image,
		{ type: "text", text: "trailing" },
	]);
	// The input is not mutated.
	expect((payload.messages[2]?.content as { content?: unknown[] }[])[0]?.content).toHaveLength(2);
});

test("payloads that Anthropic already accepts are left unchanged", () => {
	expect(anthropicToolErrorPayload({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", is_error: true, content: "boom" }] }] })).toBeUndefined();
	expect(anthropicToolErrorPayload({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", is_error: true, content: [{ type: "text", text: "boom" }] }] }] })).toBeUndefined();
	expect(anthropicToolErrorPayload({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", is_error: false, content: [image] }] }] })).toBeUndefined();
	expect(anthropicToolErrorPayload({ input: [] })).toBeUndefined();
	expect(anthropicToolErrorPayload(null)).toBeUndefined();
});

/** Every request body the bot's real anthropic provider would send, captured instead of sent. */
async function anthropicBody(): Promise<{ messages: { role: string; content: unknown }[] }> {
	const saved = process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_API_KEY;
	try {
		const dir = await mkdtemp(join(tmpdir(), "dinobot-tool-errors-")); dirs.push(dir);
		const credentials = openCredentialFile(dir);
		await credentials.addAccount("anthropic", { type: "api_key", key: "sk-ant-test" });
		const models = createBotModels({ credentials });
		const model = models.getModel("anthropic", "claude-sonnet-4-6");
		if (!model) throw new Error("missing anthropic/claude-sonnet-4-6");
		const bodies: string[] = [];
		const fetch = (async (_url: unknown, init?: RequestInit) => {
			bodies.push(String(init?.body));
			return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }), { status: 400, headers: { "content-type": "application/json" } });
		}) as unknown as typeof globalThis.fetch;
		const stream = models.streamSimple(model, {
			messages: [
				{ role: "user", content: "look", timestamp: 1 },
				{
					role: "assistant", content: [{ type: "toolCall", id: "toolu_1", name: "codemode", arguments: {} }],
					api: "anthropic-messages", provider: "anthropic", model: model.id, stopReason: "toolUse", timestamp: 2,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				},
				{
					role: "toolResult", toolCallId: "toolu_1", toolName: "codemode", isError: true, timestamp: 3,
					content: [{ type: "text", text: "Script failed" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
				},
			],
		} as never, { fetch, maxRetries: 0 } as never);
		await stream.result();
		const body = bodies[0];
		if (body === undefined) throw new Error("no request was sent");
		return JSON.parse(body);
	} finally {
		if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
	}
}

test("the bot's anthropic provider never sends a non-text block inside an error tool_result", async () => {
	const body = await anthropicBody();
	const last = body.messages.at(-1);
	expect(last?.role).toBe("user");
	const content = last?.content as { type: string; is_error?: boolean; content?: unknown }[];
	const result = content[0];
	expect(result?.type).toBe("tool_result");
	expect(result?.is_error).toBe(true);
	const inner = result?.content as { type: string; text?: string }[];
	expect(inner.every(block => block.type === "text")).toBe(true);
	expect(inner[0]?.text).toBe("Script failed");
	expect(content.slice(1) as unknown[]).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]);
});
