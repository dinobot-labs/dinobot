import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import * as z from "zod";

function createServer(): McpServer {
	const server = new McpServer({ name: "fixture", version: "0.1.0" });
	server.registerTool(
		"add",
		{ description: "Add two numbers", inputSchema: z.object({ a: z.number(), b: z.number() }) },
		async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
	);
	if (process.argv.includes("--images")) {
		server.registerTool("snap", { description: "Text, an image and audio" }, async () => ({
			content: [
				{ type: "text", text: "caption" },
				{ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==" },
				{ type: "audio", mimeType: "audio/wav", data: "UklGRgAAAAA=" },
			],
		}));
	}
	return server;
}

const portIndex = process.argv.indexOf("--http");
if (portIndex === -1) {
	await createServer().connect(new StdioServerTransport());
} else {
	Bun.serve({
		hostname: "127.0.0.1",
		port: Number(process.argv[portIndex + 1]),
		fetch: async (request) => {
			if (new URL(request.url).pathname !== "/mcp") return new Response("not found", { status: 404 });
			const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
			await createServer().connect(transport);
			return transport.handleRequest(request);
		},
	});
}
