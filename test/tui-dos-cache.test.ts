import { afterEach, expect, test } from "bun:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { renderSubagentRow, renderGroupHeader } from "../src/tui/blocks/subagents.ts";
import type { SubagentBlock } from "../src/tui/state.ts";
import { setTheme } from "../src/tui/theme.ts";
const ctx = { expanded: true, selected: false, tick: 0, now: 12000, running: false };
afterEach(() => setTheme("rex"));
for (const status of ["running", "completed", "failed", "cancelled"] as const) {
 for (const surface of ["row", "group"] as const) test(surface + " " + status + " repaints cached data across themes", () => {
  const block: SubagentBlock = {kind:"subagent", id:"a", callId:"a", version:1, progress:{taskId:"a", description:"한글 task", subagentType:"explore", background:false, conversationId:7, status, startedAt:0, endedAt:12000, toolCount:1, ...(status === "failed" ? {error:"Permission denied"} : {})}};
  const data = JSON.stringify(block);
  const render = (b: SubagentBlock) => surface === "row" ? renderSubagentRow(b,80,ctx) : renderGroupHeader([b],80,ctx);
  setTheme("rex"); const original = render(block);
  for (const theme of ["dos-blue", "dos-black", "rex"] as const) {
   setTheme(theme);
   const actual = render(block);
   expect(actual).toEqual(render(structuredClone(block)));
   expect(actual.map(stripTerminalSequences)).toEqual(original.map(stripTerminalSequences));
   if (theme === "rex") expect(actual).toEqual(original);
   else expect(actual).not.toEqual(original);
   expect(JSON.stringify(block)).toBe(data);
  }
 });
}
