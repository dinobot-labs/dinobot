import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Message, SystemMessage, Tool } from "@earendil-works/pi-ai";
import type { GenerationHooks, Harness, HookApi } from "@earendil-works/pi-durable";
import { toolExtensions } from "../src/core/toolmode.ts";
import type { LoadedPlugin, PluginTool } from "../src/plugins/types.ts";

const plugin: LoadedPlugin = {
	id: "web",
	tools: [{ name: "web_search", description: "search", inputSchema: { type: "object", properties: {} } } as unknown as PluginTool],
};
const declaration = (name: string): Tool => ({ name, description: name, parameters: { type: "object", properties: {} } as Tool["parameters"] });

function codemodeRouting(): GenerationHooks["beforeRequest"] {
	const extensions = toolExtensions("codemode-only", [plugin], () => ({}) as Harness);
	const routing = extensions.find((extension) => extension.name === "codemode-routing");
	const registration = routing?.hooks?.find((entry) => entry.task === "pi.generation" || "beforeRequest" in entry.handlers);
	const beforeRequest = (registration?.handlers as Partial<GenerationHooks> | undefined)?.beforeRequest;
	if (!beforeRequest) throw new Error("codemode-routing has no beforeRequest hook");
	return beforeRequest;
}

const system = (message: Message | undefined) => message as SystemMessage;

test("codemode-only routing never removes a tool the provider was never offered", async () => {
	// Given a replayed tool reset: the harness removes every stored tool, codemode-only ones included, and re-adds them.
	const beforeRequest = codemodeRouting();
	const messages: Message[] = [
		{ role: "system", content: "", toolsAdded: [declaration("bash"), declaration("skill_evolution_status"), declaration("web_search")], timestamp: 1 },
		{ role: "user", content: "hi", timestamp: 2 },
		{
			role: "system",
			content: "",
			toolsRemoved: [{ name: "bash" }, { name: "skill_evolution_status" }, { name: "web_search" }, { name: "skills_load" }],
			toolsAdded: [declaration("bash"), declaration("skill_evolution_status")],
			timestamp: 3,
		},
		{ role: "system", content: "", toolsRemoved: [{ name: "research_start" }], timestamp: 4 },
	];
	// When the request is prepared for the provider.
	const result = await beforeRequest({ messages }, {} as HookApi, context);
	const out = result?.messages ?? messages;
	// Then codemode-only names leave both additions and removals, and ordinary tools are untouched.
	expect(system(out[0]).toolsAdded?.map((tool) => tool.name)).toEqual(["bash"]);
	expect(system(out[2]).toolsRemoved).toEqual([{ name: "bash" }]);
	expect(system(out[2]).toolsAdded?.map((tool) => tool.name)).toEqual(["bash"]);
	expect(system(out[3]).toolsRemoved ?? []).toEqual([]);
	expect(out[1]).toBe(messages[1]!);
	// And every removal refers to a tool added earlier in the outgoing request (the provider's tool_reference rule).
	const offered = new Set<string>();
	for (const message of out) {
		if (message.role !== "system") continue;
		for (const removed of message.toolsRemoved ?? []) {
			expect(offered.has(removed.name)).toBe(true);
			offered.delete(removed.name);
		}
		for (const added of message.toolsAdded ?? []) offered.add(added.name);
	}
});
