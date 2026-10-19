import { Type } from "@earendil-works/pi-ai";
import { Client, StreamableHTTPClientTransport, type Transport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Static } from "typebox";
import { definePlugin, type JsonSchema, PluginContent, type PluginContentBlock, type PluginTool } from "../types.ts";

const strings = Type.Record(Type.String(), Type.String());
const stdio = Type.Object({
	type: Type.Optional(Type.Literal("stdio")),
	command: Type.String({ minLength: 1 }),
	args: Type.Optional(Type.Array(Type.String())),
	env: Type.Optional(strings),
	cwd: Type.Optional(Type.String()),
});
const http = Type.Object({ type: Type.Literal("http"), url: Type.String(), headers: Type.Optional(strings) });
const config = Type.Object({ servers: Type.Record(Type.String({ minLength: 1 }), Type.Union([stdio, http])) });

export type McpServerEntry = Static<typeof stdio> | Static<typeof http>;
type Server = McpServerEntry;
type Content = { type: string; text?: string; data?: string; mimeType?: string; resource?: { uri?: string; text?: string; blob?: string } };

/** Claude Code .mcp.json semantics: `${VAR}` and `${VAR:-default}` expand from process.env. */
function expand(server: string, value: string): string {
	return value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_, name: string, fallback: string | undefined) => {
		const resolved = process.env[name] ?? fallback;
		if (resolved === undefined) throw new Error(`server "${server}": environment variable ${name} is not set`);
		return resolved;
	});
}

function expandAll(server: string, record: Record<string, string> = {}): Record<string, string> {
	return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, expand(server, value)]));
}

function transport(name: string, server: Server): Transport {
	if (server.type === "http") {
		return new StreamableHTTPClientTransport(new URL(expand(name, server.url)), {
			requestInit: { headers: expandAll(name, server.headers) },
		});
	}
	return new StdioClientTransport({
		command: expand(name, server.command),
		args: (server.args ?? []).map((arg) => expand(name, arg)),
		env: { ...getDefaultEnvironment(), ...expandAll(name, server.env) },
		...(server.cwd !== undefined ? { cwd: expand(name, server.cwd) } : {}),
	});
}

/** A plugin-safe tool name: lowercase, characters outside `a-z0-9_` become `_`. */
export function safeToolName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function toolName(server: string, tool: string): string {
	return safeToolName(`${server}_${tool}`);
}

/** Binary payloads (audio, blob resources) become a short note instead of base64 text in the model context. */
function textOf(block: Content): string {
	if (block.type === "text") return block.text ?? "";
	if (block.type === "audio") return `[audio omitted: ${block.mimeType ?? "unknown type"}]`;
	if (block.type === "image") return `[image: ${block.mimeType ?? "unknown type"}]`;
	if (block.type === "resource" && block.resource?.blob !== undefined) return `[binary resource omitted: ${block.resource.uri ?? "unknown uri"}]`;
	return JSON.stringify(block);
}

function text(content: readonly Content[]): string {
	return content.map(textOf).join("\n");
}

/** Image blocks pass through as images (the host validates them); every other block keeps its text form. */
function blocks(content: readonly Content[]): PluginContentBlock[] {
	return content.map((block) =>
		block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string"
			? { type: "image", mimeType: block.mimeType, data: block.data }
			: { type: "text", text: textOf(block) },
	);
}

/**
 * Connect one MCP server and turn its tools into plugin tools. `naming` maps an MCP tool name to the plugin-local tool
 * name (default `<server>_<tool>`); built-in plugins that wrap a single server (aside) pass their own.
 */
export async function connectMcpServer(
	name: string,
	server: Server,
	naming: (tool: string) => string = (tool) => toolName(name, tool),
): Promise<{ client: Client; tools: PluginTool[] }> {
	const client = new Client({ name: "dinobot", version: "0.1.0" });
	await client.connect(transport(name, server));
	try {
		const { tools: listed } = await client.listTools();
		const tools = listed.map((tool): PluginTool => ({
			name: naming(tool.name),
			description: tool.description ?? tool.name,
			inputSchema: tool.inputSchema as JsonSchema,
			...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema as JsonSchema } : {}),
			execute: async (args, { signal }) => {
				const result = await client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }, signal !== undefined ? { signal } : {});
				const content = (result.content ?? []) as Content[];
				if (result.isError) throw new Error(text(content));
				if (content.some((block) => block.type === "image")) return new PluginContent(blocks(content));
				return result.structuredContent ?? text(content);
			},
		}));
		return { client, tools };
	} catch (error) {
		await client.close();
		throw error;
	}
}

export const mcpPlugin = definePlugin({
	id: "mcp",
	config,
	load: async ({ servers }) => {
		const clients: Client[] = [];
		const tools: PluginTool[] = [];
		const close = async () => {
			await Promise.all(clients.map((client) => client.close()));
		};
		for (const [name, server] of Object.entries(servers)) {
			try {
				const connected = await connectMcpServer(name, server);
				clients.push(connected.client);
				tools.push(...connected.tools);
			} catch (error) {
				await close();
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(message.startsWith(`server "${name}"`) ? message : `server "${name}": ${message}`);
			}
		}
		return { tools, close };
	},
});
