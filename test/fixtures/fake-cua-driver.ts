// A stand-in for `cua-driver mcp`: the same MCP tool names and result shapes the computer plugin relies on.
// FAKE_DRIVER_LOG (optional) gets one "start <pid>" line per process, so tests can count spawns.
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";

if (process.env.FAKE_DRIVER_LOG) appendFileSync(process.env.FAKE_DRIVER_LOG, `start ${process.pid}\n`);

// 1x1 opaque red PNG.
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const server = new McpServer({ name: "fake-cua-driver", version: "0.34.0" });

server.registerTool("list_windows", { description: "List top-level windows.\nMore detail." }, async () => ({
	content: [{ type: "text", text: "Found 1 windows:\n  window_id=7 pid=42 \"Fixture\"" }],
	structuredContent: { windows: [{ window_id: 7, pid: 42, title: "Fixture", padding: "x".repeat(600) }], count: 1 },
}));

server.registerTool(
	"get_window_state",
	{ description: "Snapshot a window.", inputSchema: z.object({ pid: z.number(), window_id: z.number() }) },
	async ({ pid, window_id }) => ({
		content: [
			{ type: "text", text: `window_id=${window_id} pid=${pid} elements=1\n- [0] button "OK"` },
			{ type: "image", mimeType: "image/png", data: PIXEL },
		],
		structuredContent: { snapshot_id: "s00000001", pid, window_id, elements: [{ element_index: 0, label: "x".repeat(600) }] },
	}),
);

server.registerTool(
	"click",
	{ description: "Click a target pid.", inputSchema: z.object({ pid: z.number().optional(), element_token: z.string().optional() }) },
	async ({ element_token }) => {
		if (element_token === "bad")
			return {
				isError: true,
				content: [{ type: "text", text: "element_token has invalid format" }],
				structuredContent: { status: "refused", refusal: { code: "invalid_element_token" } },
			};
		return { content: [{ type: "text", text: `Clicked ${element_token}` }], structuredContent: { effect: "confirmed", verified: true } };
	},
);

server.registerTool("health_report", { description: "Report health and the environment it sees." }, async () => ({
	content: [{
		type: "text",
		text: JSON.stringify(Object.fromEntries(["DO_NOT_TRACK", "CUA_DRIVER_RS_UPDATE_CHECK", "CUA_DRIVER_RS_ENABLE_WAYLAND", "WAYLAND_DISPLAY", "FAKE_SECRET", "CUA_EXTRA"].map((name) => [name, process.env[name] ?? null]))),
	}],
}));

server.registerTool("end_session", { description: "Exits the process to simulate a crash." }, async () => {
	setTimeout(() => process.exit(1), 10);
	return { content: [{ type: "text", text: "bye" }] };
});

// Served by the driver but not forwarded by computer_use.
server.registerTool("install_extension", { description: "Not forwarded." }, async () => ({ content: [{ type: "text", text: "installed" }] }));

await server.connect(new StdioServerTransport());
