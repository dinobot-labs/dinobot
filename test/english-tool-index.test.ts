import { expect, test } from "bun:test";
import { searchTools, type ToolDocument } from "../src/core/tool-search.ts";

const documents: ToolDocument[] = [
	{ name: "memory_search", description: "Search stored team memory by query", parameters: { properties: { query: {} } } },
	{ name: "skills_history", description: "Read immutable skill update history", parameters: { properties: { name: {} } } },
	{ name: "kill_task", description: "Cancel a subagent task", parameters: { properties: { task_id: {} } } },
];
test("English metadata supports agent-written queries, not implicit translation", () => {
	expect(searchTools("skill history", documents)[0]?.name).toBe("skills_history");
	expect(searchTools("cancel subagent task", documents)[0]?.name).toBe("kill_task");
	expect(searchTools("스킬 이력", documents)).toEqual([]);
	expect(searchTools(" skills_history ", documents)).toEqual([documents[1]!]);
	expect(searchTools("search memory", documents, 1)).toHaveLength(1);
});
test("query repetition and document order cannot bias the ranking", () => {
	const result = searchTools("search skill", documents);
	expect(searchTools("search skill search skill", documents)).toEqual(result);
	expect(searchTools("search skill", [...documents].reverse())).toEqual(result);
});
test("empty catalogue, no-match and invalid bounds are explicit", () => {
	for (const query of ["", "!!!", "astronaut"]) expect(searchTools(query, documents)).toEqual([]);
	expect(searchTools("skill", [])).toEqual([]);
	expect(searchTools("kill_task", documents.filter(t => t.name !== "kill_task"))).toEqual([]);
	for (const limit of [0, 6, 1.5, NaN, Infinity]) expect(() => searchTools("skill", documents, limit)).toThrow(RangeError);
	expect(() => searchTools("x".repeat(257), documents)).toThrow(RangeError);
});
