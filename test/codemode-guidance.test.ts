import { describe, expect, test } from "bun:test";
import { codemodeOnlyToolGuidance, INLINE_SCHEMA_MAX_BYTES, toolSummary } from "../src/extensions/codemode.ts";

const small = { type: "object", properties: { q: { type: "string" } } };
const tools = [
	{ name: "web_search", description: "Search the public web for news. Supports operators.", parameters: small },
	{ name: "computer_use", description: "Observe and operate desktop apps.\nTypical flow: list_windows.", parameters: small },
	{ name: "skills_list", description: "List skills in the catalog. Extra detail.", parameters: small },
	{ name: "mcp_blank", description: "   ", parameters: small },
];

describe("toolSummary", () => {
	test("keeps the first sentence on one line", () => {
		expect(toolSummary("Observe and operate desktop apps.\nTypical flow: x.")).toBe("Observe and operate desktop apps.");
		expect(toolSummary("No terminal punctuation")).toBe("No terminal punctuation");
		expect(toolSummary("Version 1.2 is fine. Second.")).toBe("Version 1.2 is fine.");
	});
	test("bounds long sentences", () => {
		const summary = toolSummary("word ".repeat(100));
		expect(summary.length).toBe(160);
		expect(summary.endsWith("\u2026")).toBe(true);
	});
});

describe("codemodeOnlyToolGuidance", () => {
	test("summarizes hidden tools and inlines only opted-in contracts", () => {
		const text = codemodeOnlyToolGuidance(tools, true, new Set(["computer_use"])).join("\n\n");
		expect(text).toContain("- web_search: Search the public web for news.");
		expect(text).toContain("- skills_list: List skills in the catalog.");
		expect(text).not.toContain("Extra detail");
		expect(text).toContain("- mcp_blank\n");
		expect(text).not.toContain("- computer_use");
		expect(text).toContain(`\n\ncomputer_use: Observe and operate desktop apps.\nTypical flow: list_windows.\nArguments JSON schema: ${JSON.stringify(small)}`);
		expect(text.match(/Arguments JSON schema/g)?.length).toBe(1);
	});

	test("an oversized opted-in schema falls back to search", () => {
		const huge = { type: "object", description: "x".repeat(INLINE_SCHEMA_MAX_BYTES) };
		const text = codemodeOnlyToolGuidance([{ name: "big", description: "Big tool.", parameters: huge }], true, new Set(["big"])).join("\n\n");
		expect(text).toContain("- big: Big tool.");
		expect(text).not.toContain("Arguments JSON schema");
	});

	test("without tool_search every contract is inlined", () => {
		const parts = codemodeOnlyToolGuidance(tools, false);
		expect(parts).toHaveLength(tools.length);
		for (const part of parts) expect(part).toContain("Arguments JSON schema");
		expect(parts.join("")).not.toContain("tool_search");
	});

	test("no hidden tools reports none", () => {
		expect(codemodeOnlyToolGuidance([], true)).toContain("Additional codemode-only tools: (none).");
	});
});
