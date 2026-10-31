import { afterEach, expect, test } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { renderTool } from "../src/tui/blocks/tools.ts";
import { Picker } from "../src/tui/picker.ts";
import type { ToolBlock } from "../src/tui/state.ts";
import { setTheme } from "../src/tui/theme.ts";
const ctx = { expanded: true, selected: false, tick: 0, now: 0, running: false };
afterEach(() => setTheme("rex"));
for (const status of ["done", "error"] as const) test("tool diff/error output survives theme round trip: " + status, () => {
 const result = status === "error" ? "Permission denied" : "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new";
 const block: ToolBlock = {kind:"tool",id:"t",callId:"t",version:1,name:"bash",args:{command:"git diff"},status,output:"",result};
 const saved = JSON.stringify(block);
 setTheme("rex"); const original = renderTool(block,100,ctx);
 for (const theme of ["dos-blue", "dos-black", "rex"] as const) {
  setTheme(theme); const lines = renderTool(block,100,ctx);
  expect(lines).toEqual(renderTool(structuredClone(block),100,ctx));
  expect(lines.map(stripTerminalSequences)).toEqual(original.map(stripTerminalSequences));
  expect(lines.join("\n")).toContain(status === "error" ? "Permission denied" : "+new");
  if (theme === "rex") expect(lines).toEqual(original); else expect(lines).not.toEqual(original);
  expect(JSON.stringify(block)).toBe(saved);
 }
});
test("approval picker opens under each theme without choosing until Enter", () => {
 const choices: string[] = [];
 const render = () => new Picker("Approve command?", [{id:"allow",label:"Allow"},{id:"deny",label:"Deny"}], {onChoose:id => choices.push(id),onCancel:() => {}}, () => ({cols:80,rows:30}));
 setTheme("rex"); const original = render().render(70);
 for (const theme of ["dos-blue", "dos-black", "rex"] as const) {
  setTheme(theme); const picker = render(); const lines = picker.render(70);
  const plain = lines.map(stripTerminalSequences).join("\n");
  expect(plain).toContain("Approve command?"); expect(plain).toContain("Allow"); expect(plain).toContain("Deny");
  expect(choices).toHaveLength(0);
  if (theme === "rex") expect(lines).toEqual(original); else { expect(lines).not.toEqual(original); expect(plain).toContain("╔"); }
 }
 render().handleInput("\r"); expect(choices).toEqual(["allow"]);
});
