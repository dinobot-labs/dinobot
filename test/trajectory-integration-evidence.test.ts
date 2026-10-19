import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, ConversationId } from "@earendil-works/pi-durable";
import { gradeTrace } from "../src/core/trajectory/engine.ts";
import { readTrajectory, formatTrajectory } from "../src/core/trajectory/read.ts";
import type { Step } from "../src/core/trajectory/types.ts";

test("later unavailable failure cannot erase a known failed check when success is claimed", () => {
 const steps: Step[] = [
  {n:1,entryId:1,kind:"call",tool:"write",args:{path:"a.ts"},ok:true,order:{invoked:1,result:2}},
  {n:2,entryId:2,kind:"call",tool:"bash",args:{command:"bun test"},ok:false,order:{invoked:3,result:4}},
  {n:3,entryId:3,kind:"call",tool:"bash",args:{command:"bun test"},ok:false,order:{invoked:5,result:8}},
  {n:4,entryId:4,kind:"assistant",text:"Tests passed",order:{invoked:6}},
 ];
 const report=gradeTrace({steps,ownedBy:null,parentClaimed:null});
 expect(report.violations.some(v=>v.rule==="claim-mismatch")).toBe(true);
 expect(report.unresolved.some(v=>v.reason==="claim_order_unknown")).toBe(true);
 expect(report.ruleVerdict).toBe("FAIL");
});

function repeated(overlap: boolean): Step[] {
 return [
  { n:1, entryId:1, kind:"call", tool:"read", args:{path:"a.ts",limit:1}, ok:false, order:{invoked:1,result:overlap?4:2} },
  { n:2, entryId:2, kind:"call", tool:"read", args:{limit:1,path:"a.ts"}, ok:false, order:{invoked:3,result:5} },
 ];
}
test("canonical equivalent concurrent calls are not evidence of reacting blindly to a known failure", () => {
 const grade=gradeTrace({steps:repeated(true),ownedBy:null,parentClaimed:null});
 expect(grade.violations.some(v=>v.rule==="blind-retry")).toBe(false);
 expect(grade.coverage.reasons).toContain("retry_order_unknown");
 expect(grade.verdict).toBe("INCOMPLETE");
});
test("canonical equivalent sequential calls still detect a real blind retry", () => {
 const grade=gradeTrace({steps:repeated(false),ownedBy:null,parentClaimed:null});
 expect(grade.violations.filter(v=>v.rule==="blind-retry")).toHaveLength(1);
});
test("model-facing graph display is bounded and omissions do not mutate the evidence", async () => {
 const entries=Array.from({length:150},(_,i)=>({id:i+1,conversationId:1,byTaskId:4,kind:"pi.assistant",model:[{role:"assistant",content:[{type:"text",text:"recorded progress"}]}]})).reverse();
 const handle={entries:async (_q:unknown,limit:number,cursor?:string)=>{const at=Number(cursor??0);return {items:entries.slice(at,at+limit),...(at+limit<entries.length?{next:String(at+limit)}:{})};}};
 const harness={conversation:async()=>handle,snapshot:async()=>({}),commit:async(f:any)=>f({conversation:async()=>({})})} as unknown as Harness;
 const report=await readTrajectory(harness,1 as ConversationId,BACKGROUND_CONTEXT);
 const before=JSON.stringify(report);
 const display=JSON.parse(formatTrajectory(report).split("\n").slice(1).join("\n"));
 expect(report.evidence.nodes).toHaveLength(150);
 expect(display.evidence.nodes).toHaveLength(40);
 expect(display.stepProvenance).toHaveLength(40);
 expect(display.displayOmissions.nodes).toBe(110);
 expect(display.evidence.displayComplete).toBe(false);
 expect(display.evidence.originalProviderContext).toBe("UNKNOWN");
 expect(display.digestScope).toBe("bounded-retained-evidence-projection");
 expect(display.evidence.originMeaning).toContain("entry kind");
 expect(JSON.stringify(report)).toBe(before);
});
