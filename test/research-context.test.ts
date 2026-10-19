import {expect,test} from "bun:test";
import {researchContext} from "../src/core/research-context.ts";
import {createMission,reserveAttempt,nextAction,bindAttempt,acceptEvaluation} from "../src/core/research.ts";
test("complete generated context is bounded and missing referenced feedback fails closed",()=>{
 const m=createMission({id:"m",ownerConversationId:"c",controllerTaskId:"t",projectRoot:"/p",baselineId:"B",now:0,contract:{question:"Meaning of correctness",hypotheses:[],requirements:[{id:"K",mandatory:true}],scope:"scope",exclusions:[],mode:"evidence",baseline:{definition:"baseline",artifactHash:"hash"},evaluator:{profile:"p",revision:"r",environmentFingerprint:"e",inputFingerprint:"i"},policy:{kind:"qualitative",maxNoProgressRounds:2,maxDebugChildren:1,confirmation:"none"},reportAuthorityRef:"none"}});
 const action=nextAction(m,1); if(action.kind!=="evaluate") throw Error("fixture");
 const a=reserveAttempt(m,{id:"a",reservationKey:"k",epoch:0,now:1,action});
 const artifacts={B:{content:"parent source"}};
 const first=researchContext(m,a,artifacts,"instructions"); expect(first).toEqual(researchContext(m,a,artifacts,"instructions")); expect(first.prompt).toContain("Meaning of correctness"); expect(first.prompt).toContain("parent source");
 expect(()=>researchContext(m,a,{B:{content:"x".repeat(24576)}},"instructions")).toThrow("24 KiB");
 m.candidates[0]!.feedbackReceiptIds=["missing"]; expect(()=>researchContext(m,a,artifacts,"instructions")).toThrow("feedback");
});
