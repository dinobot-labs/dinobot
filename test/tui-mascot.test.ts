import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MASCOT_BITMAP, MASCOT_SIZE, type MascotScale, type MascotState, renderMascot } from "../src/tui/mascot.ts";

const STATES: readonly MascotState[] = ["idle", "done", "failed"];
const SCALES: readonly MascotScale[] = [1, 2];
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
const plain = (state: MascotState, scale: MascotScale): string[] => renderMascot(state, scale).map(strip);

describe("mascot", () => {
	test("bitmap is 30x18 and uses only known tokens", () => {
		expect(MASCOT_BITMAP).toHaveLength(18);
		for (const row of MASCOT_BITMAP) {
			expect(row).toHaveLength(30);
			expect(row).toMatch(/^[.GDSLPWa-im]+$/);
		}
	});

	test("sizes are 15x5 and 30x9 cells", () => {
		expect(MASCOT_SIZE[1]).toEqual({ cols: 15, rows: 5 });
		expect(MASCOT_SIZE[2]).toEqual({ cols: 30, rows: 9 });
	});

	test("every row has the exact cell width and every scale the exact row count", () => {
		for (const state of STATES) {
			for (const scale of SCALES) {
				const lines = renderMascot(state, scale);
				expect(lines).toHaveLength(MASCOT_SIZE[scale].rows);
				for (const line of lines) expect(visibleWidth(line)).toBe(MASCOT_SIZE[scale].cols);
			}
		}
	});

	test("only spaces and braille remain after stripping ANSI", () => {
		for (const state of STATES) {
			for (const scale of SCALES) {
				for (const line of plain(state, scale)) {
					for (const char of line) expect(char === " " || (char >= "\u2800" && char <= "\u28ff")).toBe(true);
				}
			}
		}
	});

	test("states differ in the eye cells at both scales", () => {
		for (const scale of SCALES) {
			const [idle, done, failed] = STATES.map((state) => plain(state, scale).join("\n"));
			expect(idle).not.toBe(done);
			expect(idle).not.toBe(failed);
			expect(done).not.toBe(failed);
		}
	});

	test("scale 2 idle matches the pinned silhouette", () => {
		expect(plain("idle", 2)).toEqual(SCALE2_IDLE);
	});

	test("rendering is cached per state and scale", () => {
		expect(renderMascot("idle", 2)).toBe(renderMascot("idle", 2));
		expect(renderMascot("idle", 2)).not.toBe(renderMascot("idle", 1));
	});
});

const SCALE2_IDLE: string[] = [
	"                ⣤⣿⣿⣿⣿⣿⣿⣿⣿⣿⣤⣤  ",
	"                ⣿⣿⣿  ⠛⣿⣿⣿⣿⣿⣿⣿⣤",
	"       ⣤⣿⣤⣿⣤⣿⣤⣤ ⣿⣿⣿⣤⣤⣤⣿⣿⣿⣿⣿⣿⣿⣿",
	"   ⣤⣤⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠛",
	"⣤⣿⣿⣿⠛⠛⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠛⠛⠛⠛⠛⠛   ",
	"⠛⠛     ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠛⣿⣿       ",
	"        ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠛  ⠛       ",
	"        ⣿⣿⣿⠛   ⠛⣿⣿⣿           ",
	"      ⣤⣿⣿⣿⣿   ⣤⣿⣿⣿⣿           ",
];
