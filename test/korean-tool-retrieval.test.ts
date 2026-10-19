import { describe, expect, test } from "bun:test";
import { retrieve, type Document } from "../script/bench/korean-tool-retrieval.ts";

const documents: Document[] = [
	{ name: "memory_read", description: "Read memory" },
	{ name: "memory_write", description: "Write memory" },
	{ name: "memory_delete", description: "Delete memory" },
	{ name: "memory_list", description: "List memory" },
	{ name: "memory_search", description: "Search memory" },
	{ name: "skills_load", description: "Read skill instructions" },
	{ name: "skills_read_file", description: "Read companion file" },
	{ name: "skills_restore", description: "Stage historical skill restore" },
];
const allowed = new Set(documents.map(d => d.name));
const queries = ["기억 검색", "기억을 검색해주세요", "스킬 지침 읽기", "스킬 참고 파일 읽기", "스킬 이전버전 복원", "memory_search", "memory search", "기억 삭제", "기억 삭제하지 말고 검색", "피자 주문"];

describe("research-only Korean retrieval invariants", () => {
	test("does not confuse morphology coverage with arbitrary substring overlap", () => {
		expect(retrieve("기억을 검색해주세요", documents, allowed)[0]?.name).toBe("memory_search");
		expect(retrieve("기억력 좋아지는 음식", documents, allowed)).toEqual([]);
		expect(retrieve("기억 삭제하지 말고 검색", documents, allowed)).toEqual([]);
	});

	test("normalization, repetition and catalogue ordering do not change scores", () => {
		for (const query of queries) {
			const expected = retrieve(query, documents, allowed);
			expect(retrieve(query.normalize("NFD"), documents, allowed)).toEqual(expected);
			expect(retrieve(query, [...documents].reverse(), allowed)).toEqual(expected);
			if (query.includes(" ")) expect(retrieve(`${query} ${query}`, documents, allowed)).toEqual(expected);
		}
	});

	test("all 256 permission subsets exclude denied names and denied-document influence", () => {
		for (let mask = 0; mask < 1 << documents.length; mask++) {
			const subset = documents.filter((_, i) => mask & (1 << i));
			const permit = new Set(subset.map(d => d.name));
			for (const query of [...queries, ...documents.map(d => d.name)]) {
				const result = retrieve(query, documents, permit);
				expect(result).toEqual(retrieve(query, subset, permit));
				expect(result.every(m => permit.has(m.name))).toBe(true);
				expect(result.every(m => Number.isFinite(m.score) && m.score > 0)).toBe(true);
			}
		}
	});

	test("bounds, empty inputs and unknown tools remain explicit", () => {
		expect(() => retrieve("a".repeat(257), documents, allowed)).toThrow(RangeError);
		for (const limit of [0, 6, 1.5, NaN, Infinity]) expect(() => retrieve("기억 검색", documents, allowed, limit)).toThrow(RangeError);
		for (const query of ["", "  ", "!!!", "날씨 예보"]) expect(retrieve(query, documents, allowed)).toEqual([]);
		expect(retrieve("memory_search", documents, new Set())).toEqual([]);
		expect(retrieve("new_plugin", [{ name: "new_plugin", description: "Unknown plugin" }], new Set(["new_plugin"]))).toEqual([{ name: "new_plugin", score: 1 }]);
	});
});
