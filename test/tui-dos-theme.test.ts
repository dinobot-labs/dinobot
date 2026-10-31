import { afterEach, expect, test } from "bun:test";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { renderAgent } from "../src/tui/blocks/messages.ts";
import { renderTool } from "../src/tui/blocks/tools.ts";
import type { ToolBlock } from "../src/tui/state.ts";
import { color, paint, palette, setTheme } from "../src/tui/theme.ts";
import { modalTop, modalDivider } from "../src/tui/modal.ts";
afterEach(() => setTheme("rex"));
test("completed markdown repaints on theme change", () => {
 const block = {kind:"agent" as const, id:"a",version:1,text:"# 한글\n본문",at:0,streaming:false};
 setTheme("rex"); const before = renderAgent(block,80,ctx);
 setTheme("dos-black"); expect(renderAgent(block,80,ctx)).not.toEqual(before);
});
const ctx = { expanded: true, selected: false, tick: 0, now: 0, running: false };
test("existing tool results repaint without changing their data", () => {
 const block: ToolBlock = {kind:"tool", id:"1", callId:"1", version:1, name:"bash", args:{command:"echo 한글"}, status:"done", output:"", result:"한글"};
 const before = JSON.stringify(block);
 setTheme("rex"); const signal = renderTool(block, 80, ctx);
 setTheme("dos-blue"); const blue = renderTool(block, 80, ctx);
 expect(blue).not.toEqual(signal);
 expect(blue.map(stripTerminalSequences)).toEqual(signal.map(stripTerminalSequences));
 expect(JSON.stringify(block)).toBe(before);
 setTheme("rex"); expect(renderTool(block,80,ctx)).toEqual(signal);
});
test("DOS frames, ANSI full rows and Korean cells restore after every palette", () => {
 setTheme("rex"); const original = {...palette}; const ansi = color.textPrimary("한글");
 for (const name of ["dos-blue", "dos-black"] as const) {
  setTheme(name);
  expect(stripTerminalSequences(modalTop("승인", 40))).toContain("╔");
  expect(stripTerminalSequences(modalDivider(40))).toContain("─");
  expect(visibleWidth(paint(color.textPrimary("한글"),40))).toBe(40);
  expect(visibleWidth("한글")).toBe(4);
  expect(color.textPrimary("한글")).not.toBe(ansi);
 }
 setTheme("rex"); expect(palette).toEqual(original); expect(color.textPrimary("한글")).toBe(ansi);
});
