import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { getGraphemeCellRange, sliceByColumn, sliceWithWidth, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui/dist/utils.js";

const red = "\x1b[31m";
const reset = "\x1b[0m";
const open = "\x1b]8;;https://example.test/한\x1b\\";
const close = "\x1b]8;;\x1b\\";

test("printable ASCII slices retain exact text and returned width at every boundary", () => {
	const text = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
	for (let start = -2; start <= text.length + 1; start++) {
		for (const length of [-1, 0, 1, 2, 4, 16, 128]) {
			const expected = length <= 0 ? "" : text.slice(Math.max(0, start), Math.max(0, start + length));
			for (const strict of [false, true]) {
				expect(sliceWithWidth(text, start, length, strict)).toEqual({ text: expected, width: expected.length });
			}
		}
	}
});

test("ANSI order and OSC hyperlink bytes survive ASCII clipping", () => {
	expect(sliceWithWidth(red + "ab\x1b[1mcd" + reset, 2, 1)).toEqual({ text: red + "\x1b[1mc", width: 1 });
	expect(sliceWithWidth(open + "abcd" + close, 1, 2, true)).toEqual({ text: open + "bc", width: 2 });
	expect(truncateToWidth(open + "abcdef" + close, 4, "..")).toBe(open + "ab" + close + reset + ".." + reset);
	expect(truncateToWidth(red + "abcdef" + reset, 4, "..")).toBe(red + "ab" + reset + ".." + reset);
});

test("mixed Unicode chunks never split an ASCII base from combining, VS16 or keycap suffixes", () => {
	for (const cluster of ["e\u0301", "#\ufe0f\u20e3", "1\ufe0f\u20e3", "👩🏽‍💻", "🇰🇷", "한", "क्‍ष", "a\u065f"]) {
		const width = visibleWidth(cluster);
		const text = red + "ab" + cluster + "Z" + reset;
		expect(sliceWithWidth(text, 2, width, true)).toEqual({ text: red + cluster, width });
		expect(sliceByColumn(text, 2, width, true)).toBe(red + cluster);
		for (let col = 2; col < 2 + width; col++) expect(getGraphemeCellRange(text, col)).toEqual({ start: 2, end: 2 + width });
		if (width > 1) {
			expect(sliceWithWidth(text, 2, 1, true)).toEqual({ text: "", width: 0 });
			expect(sliceWithWidth(text, 2, 1, false)).toEqual({ text: red + cluster, width });
		}
	}
});

// Frozen against pi-tui@1.0.0 with the pre-existing editor patch, before the
// width optimization. Hash exact serialized results (including width and ANSI),
// not visual/stripped text. This keeps the oracle independent of the fastpath.
const samples = [
	"", " ", "abc", "abcdefghijklmnopqrstuvwxyz~![]", "a  b", "a\tb", "\t", "a\r\nb", "\x00a\x7fb",
	"한글中文abc", "ab한cd", "e\u0301xyz", "\u0301abc", "a\u065fb", "a\ufe0fb", "1\ufe0f\u20e3x", "#\u20e3",
	"👩🏽‍💻abc", "🇰🇷x", "👨‍👩‍👧‍👦", "क्‍षabc", "กำabc", "\u0600abc", "a\u200db", "a\ud800b", "a\udc00b",
	"ab\x1b[31m\u0301c", "ab\x1b[0mcd", "a\x1b[?25lb", "a\x1b_bad", "a\x1b[", "\x1b]unterminated",
	"a\x1b_Gpayload\x1b\\b", "a\x1b]133;A\x07b",
];
const corpus = samples.flatMap((text) => [text, red + text + reset, open + text + close, "\x1b]8;;url\x07" + text + "\x1b]8;;\x07"]);
const bounds = [-2, -1, 0, 0.5, 1, 2, 3, 4, 5, 8, 16, 128, Infinity, NaN];

test("slice output/width equals frozen Unicode+ANSI oracle across 53,312 cases", () => {
	const hash = createHash("sha256");
	let count = 0;
	for (const text of corpus) for (const start of bounds) for (const length of bounds) for (const strict of [false, true]) {
		hash.update(JSON.stringify(sliceWithWidth(text, start, length, strict)) + "\n");
		count++;
	}
	expect(count).toBe(53312);
	expect(hash.digest("hex")).toBe("38f8b5644da22305f83cd80de16e7f96c585c5d312e3a44320e920d142179edc");
});

test("cell ranges equal frozen Unicode+ANSI oracle across 1,904 cases", () => {
	const hash = createHash("sha256");
	let count = 0;
	for (const text of corpus) for (const column of bounds) {
		hash.update(JSON.stringify(getGraphemeCellRange(text, column)) + "\n");
		count++;
	}
	expect(count).toBe(1904);
	expect(hash.digest("hex")).toBe("5801009a897334849c0510ae5d8fa42e0792e3c09cd952d0324737342880b3fb");
});

test("truncation equals frozen Unicode+ANSI oracle across 13,056 cases", () => {
	const hash = createHash("sha256");
	let count = 0;
	for (const text of corpus) for (const width of bounds.slice(0, 12)) for (const ellipsis of ["", "..", "한", red + ".." + reset]) for (const pad of [false, true]) {
		hash.update(JSON.stringify(truncateToWidth(text, width, ellipsis, pad)) + "\n");
		count++;
	}
	expect(count).toBe(13056);
	expect(hash.digest("hex")).toBe("635ae3331529804f9e81370dca5b17c9bf4b72aa903c3201f9364e9b65cfb57f");
});

// Frozen visibleWidth oracle from the original clean dependency, not the candidate.
test("simple CJK exhaustive safe ranges and styled mixtures match the original width oracle", () => {
	const hash = createHash("sha256");
	let count = 0;
	for (const [lo, hi] of [[0x4e00, 0x9fff], [0xac00, 0xd7a3]] as const) {
		for (let cp = lo; cp <= hi; cp++) {
			const c = String.fromCharCode(cp);
			for (const text of [c, "A" + c + "한中\tZ", red + c + reset + "한中", open + c + close + "A"]) {
				hash.update(JSON.stringify([text, visibleWidth(text)]) + "\n");
				count++;
			}
		}
	}
	expect(count).toBe(128656);
	expect(hash.digest("hex")).toBe("e4d9a5e56b6cdcb81fad8cda0a7e8424ba1866b4eae49e47561755a21686edc6");
});

test("excluded Unicode and malformed controls preserve whole-string fallback across ANSI boundaries", () => {
	const hash = createHash("sha256");
	let count = 0;
	const excluded = ["\u0301", "\u065f", "\u302e", "\u093e", "\u200d", "\u200c", "\u0600", "\u06dd", "\u1100", "\u1161", "\u11a8", "\ua960", "\ud7b0", "\ufe0f", "\ufe0e", "\u{e0100}", "\ud800", "\udc00", "\x00", "\x01", "\r", "\n", "\x7f", "\x85", "\x9b", "\x1b", "\x1b[", "\x1b[?25l", "\x1b_bad", "\x1b]unterminated", "\u4dff", "\ua000", "\uabff", "\ud7a4", "👩🏽‍💻", "🇰🇷", "1\ufe0f\u20e3"];
	for (const base of ["A", "一", "鿿", "가", "각", "힣", "한中\tA"]) for (const suffix of excluded) {
		for (const join of ["", red, open + close, "\x1b_Gpayload\x1b\\", "\x1b]133;A\x07"]) {
			for (const text of [base + join + suffix, suffix + join + base, base + join + suffix + "한", red + base + join + suffix + reset]) {
				hash.update(JSON.stringify([text, visibleWidth(text)]) + "\n");
				count++;
			}
		}
	}
	expect(count).toBe(5180);
	expect(hash.digest("hex")).toBe("fd11c2f6484ca03a89b160ae0d06eb3bc331b5321ecfb3e70cb4fc28ca8483f2");
});
