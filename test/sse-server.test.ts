import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot } from "../src/core/bot.ts";
import { startClientApi } from "../src/api/server.ts";
import { createCommands } from "../src/commands/index.ts";
import type { AuthService } from "../src/auth/types.ts";

// Exercise actual Bun sockets and the production 15s interval, concurrently.
test("all SSE routes send idle comments without replacing snapshots or replaying commands", async () => {
	const dir = await mkdtemp(join(tmpdir(), "sse-server-"));
	const models = createModels();
	models.setProvider(fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] }).provider);
	const bot = await openBot({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode: "direct", plugins: [] }, context);
	let logins = 0;
	const auth: AuthService = { credentials: {} as AuthService["credentials"], providers: async () => [{ id: "anthropic", name: "Anthropic", storeAs: "anthropic", modelProvider: "anthropic" }], async login(_id, interaction) { logins++; await interaction.prompt({ type: "secret", message: "key" }); throw new Error("cancelled"); }, logout: async () => false, status: async () => [], accounts: async () => [], useAccount: async () => { throw new Error("no accounts"); } };
	const api = startClientApi(bot, 0, context, createCommands({ bot, models, auth, plugins: [], disabled: ["skills"] }));
	const abort = new AbortController();
	try {
		const conversation = await bot.conversation("tui", "idle", context);
		const routes = ["/v1/threads/tui/idle/events", `/v1/conversations/${conversation.id}/events`, "/v1/sessions/events", "/v1/threads/tui/idle/commands"];
		await Promise.all(routes.map(async (path, index) => {
			const deadline = setTimeout(() => abort.abort(), 18_000);
			try {
				const response = await fetch(new URL(path, api.url), { signal: abort.signal, ...(index === 3 ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "login", args: "anthropic" }) } : {}) });
				expect(response.headers.get("content-type")).toBe("text/event-stream");
				const reader = response.body!.getReader();
				let buffer = ""; let first: any; let heartbeat = false;
				try {
					while (!heartbeat) {
						const next = await reader.read();
						if (next.done) break;
						buffer += new TextDecoder().decode(next.value);
						let end: number;
						while ((end = buffer.indexOf("\n\n")) >= 0) {
							const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
							if (frame.startsWith(":")) heartbeat = true;
							else if (frame.startsWith("data:")) first ??= JSON.parse(frame.slice(5));
						}
					}
					expect(heartbeat).toBe(true);
					expect(first.type).toBe(index < 2 ? "snapshot" : index === 2 ? "sessions" : "started");
					if (index < 2) { expect(first).toHaveProperty("queue"); expect(first).toHaveProperty("workflow"); expect(first).toHaveProperty("dag"); }
				} finally { await reader.cancel().catch(() => {}); }
			} finally { clearTimeout(deadline); }
		}));
		expect(logins).toBe(1);
	} finally { abort.abort(); await api.stop(); await bot.close(context); await rm(dir, { recursive: true, force: true }); }
}, 25_000);

import { sseStream } from '../src/api/sse.ts';
const encode = (s: string) => new TextEncoder().encode(s);
const decode = (s?: Uint8Array) => new TextDecoder().decode(s);

test('heartbeat continues during pending pull; cancellation ignores late completion and cleans once', async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let release!: () => void; let cleanups = 0; let pulls = 0;
	const stream = sseStream({
		start(c) { controller = c; c.enqueue(encode('data: first\n\n')); },
		pull() { pulls++; return new Promise<void>(resolve => { release = resolve; }); },
		cancel() { cleanups++; },
	}, { heartbeatMs: 5 });
	const reader = stream.getReader();
	expect(decode((await reader.read()).value)).toBe('data: first\n\n');
	expect(decode((await reader.read()).value)).toBe(': heartbeat\n\n');
	expect(decode((await reader.read()).value)).toBe(': heartbeat\n\n');
	expect(pulls).toBe(1);
	await reader.cancel();
	controller.enqueue(encode('late')); controller.close(); controller.error(new Error('late')); release();
	await Bun.sleep(20);
	expect(cleanups).toBe(1); expect(controller.desiredSize).toBe(0);
	expect((await reader.read()).done).toBe(true);
});

test('large initial snapshots are delivered rather than misclassified as slow consumers', async () => {
	const snapshot = encode('data: ' + JSON.stringify({ type: 'snapshot', text: 'x'.repeat(2 * 1024 * 1024) }) + '\n\n');
	const stream = sseStream({ start(c) { c.enqueue(snapshot); c.close(); } });
	const reader = stream.getReader();
	expect((await reader.read()).value).toEqual(snapshot);
	expect((await reader.read()).done).toBe(true);
});

test('slow readers accumulate at most one heartbeat without dropping ordered data', async () => {
	let c!: ReadableStreamDefaultController<Uint8Array>; let stops = 0;
	const stream = sseStream({ start(controller) { c = controller; }, cancel() { stops++; } }, { heartbeatMs: 2 });
	await Bun.sleep(20);
	expect(c.desiredSize).toBe(8 * 1024 * 1024 - encode(': heartbeat\n\n').byteLength);
	c.enqueue(encode('first')); c.enqueue(encode('second'));
	await Bun.sleep(20);
	expect(c.desiredSize).toBe(8 * 1024 * 1024 - encode(': heartbeat\n\nfirstsecond').byteLength);
	const reader = stream.getReader();
	expect(decode((await reader.read()).value)).toBe(': heartbeat\n\n');
	expect(decode((await reader.read()).value)).toBe('first');
	expect(decode((await reader.read()).value)).toBe('second');
	await reader.cancel();
	expect(stops).toBe(1);
});

test('EOF and source errors clean once, stop heartbeat and preserve data ordering', async () => {
	for (const failure of [false, true]) {
		let c!: ReadableStreamDefaultController<Uint8Array>; let stops = 0; let index = 0;
		const stream = sseStream({
			start(controller) { c = controller; },
			pull(controller) {
				if (index < 2) controller.enqueue(encode(String(index++)));
				else if (failure) throw new Error('source failed');
				else controller.close();
			},
			cancel() { stops++; },
		}, { heartbeatMs: 5 });
		const reader = stream.getReader();
		expect(decode((await reader.read()).value)).toBe('0');
		expect(decode((await reader.read()).value)).toBe('1');
		if (failure) await expect(reader.read()).rejects.toThrow('source failed');
		else expect((await reader.read()).done).toBe(true);
		await Bun.sleep(15); c.enqueue(encode('late'));
		expect(stops).toBe(1); expect(c.desiredSize).toBe(0);
	}
});

test('startup failure cleans acquired resources and ignores late callbacks', async () => {
	let c!: ReadableStreamDefaultController<Uint8Array>; let stops = 0;
	const stream = sseStream({ start(controller) { c = controller; throw new Error('setup'); }, cancel() { stops++; } }, { heartbeatMs: 2 });
	await expect(stream.getReader().read()).rejects.toThrow('setup');
	c.enqueue(encode('late')); await Bun.sleep(10); expect(stops).toBe(1);
});

test('slow data consumer hits byte limit, errors instead of losing frames, and cleans exactly once', async () => {
 let c!: ReadableStreamDefaultController<Uint8Array>; let stops = 0;
 const stream = sseStream({ start(controller) { c = controller; }, cancel() { stops++; c.close(); throw new Error('cleanup'); } }, { maxQueuedBytes: 32 });
 c.enqueue(new Uint8Array(16)); c.enqueue(new Uint8Array(16));
 expect(c.desiredSize).toBe(0); expect(stops).toBe(0);
 c.enqueue(new Uint8Array(1));
 const reader = stream.getReader();
 await expect(reader.read()).rejects.toThrow('reconnect for a fresh snapshot');
 await reader.cancel().catch(() => {});
 c.enqueue(new Uint8Array(100)); c.close(); c.error('again');
 expect(stops).toBe(1);
});

test('oversize snapshot streams bounded byte chunks before close', async () => {
 let stops = 0;
 const stream = sseStream({ start(c) { c.enqueue(new Uint8Array(65).fill(7)); c.close(); }, async cancel() { stops++; throw new Error('cleanup'); } }, { maxQueuedBytes: 64 });
 const reader = stream.getReader(); const bytes: number[] = [];
 while (true) { const next = await reader.read(); if (next.done) break; expect(next.value.byteLength).toBeLessThanOrEqual(64); bytes.push(...next.value); }
 expect(bytes).toEqual(Array(65).fill(7));
 await Bun.sleep(10); expect(stops).toBe(1);
});

test('draining bytes restores capacity and reconnect starts with a fresh snapshot', async () => {
 let version = 1; let stops = 0;
 let c!: ReadableStreamDefaultController<Uint8Array>;
 const connect = () => sseStream({ start(controller) { c = controller; c.enqueue(encode(`snapshot:${version}`)); }, cancel() { stops++; } }, { maxQueuedBytes: 16 });
 const first = connect().getReader();
 expect(decode((await first.read()).value)).toBe('snapshot:1');
 expect(c.desiredSize).toBe(16);
 c.enqueue(encode('ordered delta'));
 expect(decode((await first.read()).value)).toBe('ordered delta');
 c.enqueue(new Uint8Array(16)); c.enqueue(new Uint8Array(1));
 await expect(first.read()).rejects.toThrow('queue limit');
 version = 2;
 const second = connect().getReader();
 expect(decode((await second.read()).value)).toBe('snapshot:2');
 await second.cancel(); await second.cancel(); expect(stops).toBe(2);
});

test('empty data frames cannot bypass bounded queue accounting', async () => {
 let stops = 0;
 const stream = sseStream({ start(c) { for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array()); }, cancel() { stops++; } }, { maxQueuedBytes: 4 });
 await expect(stream.getReader().read()).rejects.toThrow('queue limit');
 expect(stops).toBe(1);
});

test('queued frames own their bytes rather than retaining mutable backing views', async () => {
 let c!: ReadableStreamDefaultController<Uint8Array>;
 const stream = sseStream({ start(controller) { c = controller; } }, { maxQueuedBytes: 16 });
 const backing = Buffer.alloc(1024 * 1024, 1);
 c.enqueue(backing.subarray(0, 16)); backing.fill(2);
 const reader = stream.getReader();
 const value = (await reader.read()).value!;
 expect(value.byteLength).toBe(16); expect(value.buffer.byteLength).toBe(16);
 expect([...value]).toEqual(Array(16).fill(1));
 await reader.cancel();
});
