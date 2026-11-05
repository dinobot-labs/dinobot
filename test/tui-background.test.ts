import { expect, test } from "bun:test";
import { chooseBackground, FileTuiPreferences, type TuiPreferences } from "../src/tui/preferences.ts";
import { bg, currentBackgroundMode, paint, setBackgroundMode } from "../src/tui/theme.ts";

const solid = (): void => setBackgroundMode("solid");

test("the screen surface is the Signal background until the mode changes", () => {
	solid();
	expect(currentBackgroundMode()).toBe("solid");
	const painted = paint("x", 3);
	expect(painted).toMatch(/^\x1b\[48;/);
	expect(painted.endsWith("\x1b[49m")).toBe(true);
});

test("a transparent background paints no background color, so the terminal shows through", () => {
	setBackgroundMode("transparent");
	try {
		expect(currentBackgroundMode()).toBe("transparent");
		expect(paint("x", 3)).toBe("\x1b[49mx  \x1b[49m");
		expect(paint("x", 3)).not.toContain("48;");
		expect(paint("\x1b[0mx", 1)).toBe("\x1b[49m\x1b[0m\x1b[49mx\x1b[49m");
	} finally {
		solid();
	}
});

test("inner panels keep their own background in transparent mode and hand back to the terminal", () => {
	setBackgroundMode("transparent");
	try {
		const styled = bg("bgVisual")("x");
		expect(styled).toContain("48;");
		expect(styled.endsWith("\x1b[49m")).toBe(true);
	} finally {
		solid();
	}
});

test("DINOBOT_TUI_BACKGROUND wins over the saved preference, which wins over the default", () => {
	const saved: TuiPreferences = { toolsExpanded: false, background: "transparent" };
	expect(chooseBackground(saved, { DINOBOT_TUI_BACKGROUND: "solid" })).toEqual({ background: "solid", source: "env" });
	expect(chooseBackground(saved, { DINOBOT_TUI_BACKGROUND: "none" })).toEqual({ background: "transparent", source: "env" });
	expect(chooseBackground(saved, {})).toEqual({ background: "transparent", source: "preference" });
	expect(chooseBackground({ toolsExpanded: false }, {})).toEqual({ background: "solid", source: "default" });
});

test("the background preference survives a save and load", () => {
	const path = `/tmp/dinobot-tui-preferences-${process.pid}.json`;
	const store = new FileTuiPreferences(path);
	store.save({ toolsExpanded: false, background: "transparent" });
	expect(store.load().background).toBe("transparent");
	store.save({ toolsExpanded: false });
	expect(store.load().background).toBeUndefined();
});
