import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { brailleSpinner, dotSpinner, palette, spinnerFrame, TICK_MS } from "../src/tui/theme.ts";

// WCAG relative luminance: linearize sRGB before comparing (L1 + .05)/(L2 + .05).
function luminance(hex: string): number {
	const rgb = [1, 3, 5].map((offset) => {
		const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}
function contrast(a: string, b: string): number {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (light! + 0.05) / (dark! + 0.05);
}

test("body and secondary text remain readable on every main surface", () => {
	for (const surface of [palette.bgStorm, palette.bgHighlight, palette.bgVisual, palette.bgHover]) {
		for (const text of [palette.fg, palette.fgDark, palette.comment, palette.dark5]) {
			expect(contrast(text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
		}
	}
	expect(contrast(palette.fg, palette.bgStorm)).toBeGreaterThanOrEqual(10);
	for (const border of [palette.promptBorder, palette.promptBorderActive, palette.selectionBorder]) {
		expect(contrast(border, palette.bgStorm)).toBeGreaterThanOrEqual(3);
	}
});


test("status and code colors retain text contrast on selected and raised surfaces", () => {
	for (const surface of [palette.bgStorm, palette.bgHighlight, palette.bgVisual, palette.bgHover]) {
		for (const text of [palette.orange, palette.green, palette.red, palette.yellow, palette.blue, palette.cyan, palette.green1, palette.magenta, palette.purple, palette.teal, palette.brandMint, palette.brandTeal]) {
			expect(contrast(text, surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
		}
	}
});

test("activity motion has stable width, readable cadence and a repeating cycle", () => {
	for (const spinner of [brailleSpinner, dotSpinner]) {
		expect(spinner.intervalMs).toBeGreaterThanOrEqual(132);
		const ticks = Math.round(spinner.intervalMs / TICK_MS);
		expect(spinnerFrame(spinner, ticks)).not.toBe(spinnerFrame(spinner, 0));
		expect(spinnerFrame(spinner, ticks * spinner.frames.length)).toBe(spinnerFrame(spinner, 0));
		for (const frame of spinner.frames) expect(visibleWidth(frame)).toBe(1);
	}
});
