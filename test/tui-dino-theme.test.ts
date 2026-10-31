import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MemoryTerminal } from "../script/bench/tui-render.ts";
import type { Manifest } from "../src/manifest.ts";
import { ChatApp } from "../src/tui/app.ts";
import type { ApiClient } from "../src/tui/client.ts";
import { MASCOT_BITMAPS, MASCOT_SIZE, renderMascot } from "../src/tui/mascot.ts";
import { chooseTheme, FileTuiPreferences, type TuiPreferencesStore } from "../src/tui/preferences.ts";
import { color, palette, setTheme, DINOSAUR_THEME_NAMES as THEME_NAMES, themeName, themes } from "../src/tui/theme.ts";

afterEach(() => setTheme("rex"));

function luminance(hex: string): number {
	const rgb = [1, 3, 5].map((offset) => {
		const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});
	return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
}
const contrast = (a: string, b: string): number => {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (light! + 0.05) / (dark! + 0.05);
};
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");
const truecolor = (hex: string): string => `${Number.parseInt(hex.slice(1, 3), 16)};${Number.parseInt(hex.slice(3, 5), 16)};${Number.parseInt(hex.slice(5, 7), 16)}`;

test("three dinosaur themes, the T-rex by default", () => {
	expect([...THEME_NAMES]).toEqual(["rex", "ptero", "brachio", "tricera"]);
	expect(themeName()).toBe("rex");
	expect(palette.brandMint).toBe("#19CA9D");
});

test("every theme's bitmap is 30x18 of mascot tokens with one 3x3 eye cell and one 5-cell mouth", () => {
	for (const name of THEME_NAMES) {
		const bitmap = MASCOT_BITMAPS[name];
		expect(bitmap).toHaveLength(18);
		for (const row of bitmap) {
			expect(row).toHaveLength(30);
			expect(row).toMatch(/^[.GDSLPWa-im]+$/);
		}
		expect(bitmap.join("").replace(/[^a-i]/g, "")).toBe("abcdefghi");
		expect(bitmap.join("").replace(/[^m]/g, "")).toBe("mmmmm");
	}
});

test("each theme renders its own silhouette at the fixed cell size, in its own stops", () => {
	const silhouettes = new Set<string>();
	for (const name of THEME_NAMES) {
		for (const scale of [1, 2] as const) {
			const lines = renderMascot("idle", scale, name);
			expect(lines).toHaveLength(MASCOT_SIZE[scale].rows);
			for (const line of lines) expect(visibleWidth(line)).toBe(MASCOT_SIZE[scale].cols);
		}
		silhouettes.add(renderMascot("idle", 2, name).map(strip).join("\n"));
	}
	expect(silhouettes.size).toBe(THEME_NAMES.length);
});

test("the default render follows the active theme, and switching drops the cache", () => {
	const rex = renderMascot("idle", 2).join("\n");
	setTheme("ptero");
	const ptero = renderMascot("idle", 2).join("\n");
	expect(ptero).not.toBe(rex);
	expect(ptero).toBe(renderMascot("idle", 2, "ptero").join("\n"));
	setTheme("rex");
	expect(renderMascot("idle", 2).join("\n")).toBe(rex);
});

test("themes recolor only the brand roles; text, surfaces and status stay Signal", () => {
	const before = { ...palette };
	for (const name of THEME_NAMES) {
		setTheme(name);
		const theme = themes[name];
		expect([palette.brandMint, palette.brandTeal, palette.brandCyan, palette.brandBlue, palette.brandIndigo]).toEqual([...theme.stops]);
		expect(palette.promptBorderActive).toBe(theme.border);
		for (const key of ["fg", "bgStorm", "orange", "green", "red", "yellow", "blue"] as const) expect(palette[key]).toBe(before[key]);
	}
});

test("styles built before a switch pick up the new theme color", () => {
	const user = color.accentUser("hi");
	setTheme("brachio");
	const after = color.accentUser("hi");
	expect(after).not.toBe(user);
	if (process.env.COLORTERM === "truecolor") expect(after).toContain(truecolor(themes.brachio.stops[0]));
});

test("every theme keeps its accents readable on every Signal Night surface", () => {
	for (const name of THEME_NAMES) {
		const theme = themes[name];
		for (const surface of [palette.bgStorm, palette.bgHighlight, palette.bgVisual, palette.bgHover]) {
			for (const text of theme.stops.slice(0, 2)) expect(contrast(text, surface), `${name} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
		}
		expect(contrast(theme.border, palette.bgStorm)).toBeGreaterThanOrEqual(3);
	}
});

test("the TUI themes mirror the independent brand species fixture stops", () => {
	const species = readFileSync(join(import.meta.dir, "fixtures", "brand-species.ts"), "utf8");
	for (const name of THEME_NAMES) {
		const at = species.indexOf(`\t${name}: {`);
		expect(at).toBeGreaterThan(-1);
		const stops = species.slice(at).match(/stops: \[([^\]]+)\]/)?.[1];
		expect(stops?.toUpperCase().replace(/[\s"]/g, "")).toBe(themes[name].stops.join(","));
	}
});

test("DINOBOT_THEME wins for one run, then the saved choice, then the T-rex; unknown names fall through", () => {
	expect(chooseTheme({ toolsExpanded: false }, {})).toEqual({ theme: "rex", source: "default" });
	expect(chooseTheme({ toolsExpanded: false, theme: "brachio" }, {})).toEqual({ theme: "brachio", source: "preference" });
	expect(chooseTheme({ toolsExpanded: false, theme: "brachio" }, { DINOBOT_THEME: " Ptero " })).toEqual({ theme: "ptero", source: "env" });
	expect(chooseTheme({ toolsExpanded: false, theme: "brachio" }, { DINOBOT_THEME: "raptor" })).toEqual({ theme: "brachio", source: "preference" });
});

class InputTerminal extends MemoryTerminal {
	onInput: ((data: string) => void) | undefined;
	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.onInput = onInput;
		super.start(onInput, onResize);
	}
}
const manifest = { model: { provider: "fake", modelId: "fake" }, toolMode: "hybrid" } as Manifest;
const client = {
	commands: async () => [],
	threadModel: async () => ({ model: "fake/fake", thinkingLevel: "off", supportedThinkingLevels: ["off"] }),
	events: async () => {},
} as unknown as ApiClient;
function app(preferences: TuiPreferencesStore) {
	const terminal = new InputTerminal(100, 30);
	const chat = new ChatApp(client, manifest, "main", undefined, undefined, 10000, terminal, { preferences });
	chat.start();
	return { chat, terminal };
}
const notices = (chat: ChatApp): string[] => chat.chat.data.blocks.flatMap((block) => (block.kind === "notice" ? [block.text] : []));

test.each([ ["ptero", "brachio"], ["dos-blue", "dos-black"] ] as const)("/theme %s saves and reloads, then picker selects %s", (initial, next) => {
	const saved = process.env.DINOBOT_THEME;
	delete process.env.DINOBOT_THEME;
	const dir = mkdtempSync(join(import.meta.dir, ".dinobot-theme-"));
	const path = join(dir, "tui.json");
	const first = app(new FileTuiPreferences(path));
	try {
		first.chat.screen.prompt.setText(`/theme ${initial}`);
		first.terminal.onInput?.("\r");
		expect(themeName()).toBe(initial);
		expect(new FileTuiPreferences(path).load().theme).toBe(initial);
		expect(notices(first.chat).some((text) => text.includes(themes[initial].label))).toBe(true);
		first.chat.screen.prompt.setText("/theme raptor");
		first.terminal.onInput?.("\r");
		expect(themeName()).toBe(initial);
		expect(notices(first.chat).some((text) => text.includes("unknown theme raptor"))).toBe(true);
		setTheme("rex");
		const restarted = app(new FileTuiPreferences(path));
		try {
			expect(themeName()).toBe(initial);
			restarted.chat.screen.prompt.setText("/theme");
			restarted.terminal.onInput?.("\r");
			restarted.terminal.onInput?.("\x1b[B");
			restarted.terminal.onInput?.("\r");
			expect(themeName()).toBe(next);
			expect(new FileTuiPreferences(path).load()).toEqual({ toolsExpanded: false, theme: next });
		} finally { restarted.chat.screen.stop(); }
	} finally {
		first.chat.screen.stop();
		rmSync(dir, { recursive: true, force: true });
		if (saved !== undefined) process.env.DINOBOT_THEME = saved;
	}
});
