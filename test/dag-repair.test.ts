import { expect, test } from "bun:test";
import { createRun, fail, start, succeed, frontier, rekey, replan, reviseFact, readFact, type RunState } from "../src/core/dag.ts";
import { compilePlan, nodeKey, type Plan } from "../src/core/plan.ts";
import { dagPrompt, parseVerdict } from "../src/core/dag-verification.ts";
const verdict = (v="pass",repairable=false) => JSON.stringify({version:1,requirements:[{id:"R",verdict:v,evidence:"actual failing assertion line 7"}],summary:"checked",repairable});
const plan = (): Plan => ({nodes:[{id:"a",kind:"act",writes:["out"]},{id:"v",kind:"verify",reads:["out"],covers:["R"],repair:{predecessorId:"a",maxRepairs:2}},{id:"next",kind:"act"},{id:"final",kind:"verify",covers:["done"]}],edges:[["a","v"],["v","next"],["next","final"]],goal:{requirements:["R","done"]}});
function review(r:RunState, value:string) { start(r,"a","actor",1); succeed(r,"a","original artifact",2); start(r,"v","reviewer"+r.nodes.v!.runs,3); succeed(r,"v",value,4); }
test.each([verdict("fail"), verdict("unknown"), "looks bad\n" + verdict("fail").slice(0, 60)])("completed negative verdict never passes and rejects the artifact: %s", value=>{const r=createRun("r",plan(),0);review(r,value); expect(r.certified).toEqual([]);expect(r.status).toBe("blocked");expect(frontier(r)).toEqual([]);});
test.each(["looks good", "{}", JSON.stringify({version:1,requirements:[],summary:"missing",repairable:false})])("malformed/prose never passes; the verifier is retried, then fails without rejecting the artifact: %s", value=>{
 const r=createRun("r",plan(),0); review(r,value);
 expect(r.certified).toEqual([]); expect(r.nodes.v!.status).toBe("pending"); expect(frontier(r)).toEqual(["v"]); expect(r.rejectedArtifacts ?? []).toEqual([]);
 expect(dagPrompt(r,r.plan.nodes[1]!)).toContain("no readable verdict");
 for (let t=10; r.nodes.v!.status==="pending"; t+=2) { start(r,"v","reviewer",t); succeed(r,"v",value,t+1); }
 expect(r.nodes.v!.attempt).toBe(3); expect(r.status).toBe("blocked"); expect(r.certified).toEqual([]); expect(r.rejectedArtifacts ?? []).toEqual([]);
 // A replacement verifier may still review the unchanged artifact: nothing judged it negatively.
 const q=plan(); q.nodes[1]!.id="v2"; q.edges=q.edges.map(([a,b])=>[a==="v"?"v2":a,b==="v"?"v2":b]);
 expect(replan(r,q,30).ok).toBe(true); expect(frontier(r)).toEqual(["v2"]); expect(r.nodes.a!.runs).toBe(1);
});
test("a readable verdict after a malformed attempt certifies and clears the protocol feedback",()=>{const r=createRun("r",plan(),0);review(r,"looks good");start(r,"v","reviewer2",5);succeed(r,"v",verdict(),6);expect(r.certified).toEqual(["R"]);expect(r.nodes.v!.protocolFeedback).toBeUndefined();expect(frontier(r)).toEqual(["next"]);});
test("repair invalidates generations, delivers failure and requires fresh verification",()=>{const r=createRun("r",plan(),0); const old=r.nodes.a!.key;review(r,verdict("fail",true));expect(r.repairsUsed).toBe(1);expect(r.nodes.a!.key).not.toBe(old);expect(frontier(r)).toEqual(["a"]);expect(r.nodes.v!.generation).toBe(1);expect(dagPrompt(r,r.plan.nodes[0]!)).toContain("actual failing assertion");expect(dagPrompt(r,r.plan.nodes[0]!)).toContain("original artifact");review(r,verdict());expect(frontier(r)).toEqual(["next"]);expect(r.certified).toEqual(["R"]);});
test("repair lifetime cap survives serialization, rekey and replan",()=>{let r=createRun("r",plan(),0); for(let i=0;i<2;i++){review(r,verdict("fail",true));r=JSON.parse(JSON.stringify(r));rekey(r);expect(replan(r,plan(),10).ok).toBe(true);}review(r,verdict("fail",true));expect(r.repairsUsed).toBe(2);expect(r.status).toBe("blocked");expect(r.nodes.a!.runs).toBe(3);const before=JSON.stringify(r);const last=replan(r,plan(),20);expect(last.ok).toBe(false);expect(last.ok?"":last.reason).toContain("v already failed for R");expect(JSON.stringify(r)).toBe(before);expect(r.repairsUsed).toBe(2);expect(frontier(r)).toEqual([]);});
test("unknown cannot spend credit and running effects cannot rewind",()=>{const p=plan();p.nodes.push({id:"busy",kind:"act"});p.edges.push(["a","busy"]);const r=createRun("r",p,0);start(r,"a","a",1);succeed(r,"a","out",2);start(r,"busy","busy",3);start(r,"v","v",4);succeed(r,"v",verdict("fail",true),5);expect(r.repairsUsed).toBe(0);expect(r.nodes.a!.status).toBe("succeeded");expect(r.nodes.busy!.status).toBe("running");});
test("late changed dependency verdict cannot certify; the stale verifier is retried without rejecting the artifact",()=>{
 const r=createRun("r",plan(),0);start(r,"a","a",1);readFact(r,"a","f","one");succeed(r,"a","out",2);start(r,"v","v",3);reviseFact(r,"f","two",4);succeed(r,"v",verdict(),5);
 expect(r.certified).toEqual([]);expect(r.nodes.v!.status).toBe("pending");expect(r.rejectedArtifacts ?? []).toEqual([]);expect(frontier(r)).toEqual(["a"]);
 // The fresh artifact is verified normally: a stale outcome never freezes its verifier.
 start(r,"a","a2",6);readFact(r,"a","f","two");succeed(r,"a","out2",7);expect(frontier(r)).toEqual(["v"]);start(r,"v","v2",8);succeed(r,"v",verdict(),9);expect(r.certified).toEqual(["R"]);
});
test("strict verdict exact set, evidence and enum validation",()=>{for(const requirements of [[{id:"R",verdict:"pass",evidence:""}],[{id:"other",verdict:"pass",evidence:"x"}],[{id:"R",verdict:"yes",evidence:"x"}],[{id:"R",verdict:"pass",evidence:"x"},{id:"R",verdict:"pass",evidence:"x"}]]) expect(parseVerdict(JSON.stringify({version:1,requirements,summary:"x",repairable:false}),["R"])).toBeUndefined();expect(parseVerdict(verdict(),["R"])).toBeDefined();});
test("repair compiler rejects non-ancestor, irreversible, non-writer, and excessive credit",()=>{for(const change of [{predecessorId:"next",maxRepairs:2},{predecessorId:"a",maxRepairs:3},{predecessorId:"a",maxRepairs:1.5}]){const p=plan();p.nodes[1]!.repair=change;expect(compilePlan(p).ok).toBe(false);}for(const field of [{writes:[]},{irreversible:true},{kind:"ask" as const}]){const p=plan();Object.assign(p.nodes[0]!,field);expect(compilePlan(p).ok).toBe(false);}const n=plan().nodes[1]!;expect(nodeKey(n,[])).not.toBe(nodeKey({...n,description:"changed"},[]));});
test("predecessor evidence is clipped to the context budget; only an oversized contract overflows; historical success is not strict proof",()=>{
 const r=createRun("r",plan(),0);r.nodes.a!.result="x".repeat(25000);
 const prompt=dagPrompt(r,r.plan.nodes[1]!);
 expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(24*1024);expect(prompt).toContain('"id":"a"');expect(prompt).toMatch(/bytes omitted\]/);
 const huge=plan();huge.goal.requirements.push("r".repeat(25000));huge.nodes[3]!.covers!.push("r".repeat(25000));
 const h=createRun("h",huge,0);expect(()=>dagPrompt(h,h.plan.nodes[3]!)).toThrow("overflow");
 delete r.semantics;r.nodes.v!.status="succeeded";rekey(r);expect(r.certified).toEqual([]);
});

test("replan cannot reroll a rejected artifact by changing verifier description or id",()=>{const r=createRun("r",plan(),0);review(r,verdict("fail"));const before=JSON.stringify(r);const p=plan();p.nodes[1]!.description="try again";const first=replan(r,p,5);expect(first.ok).toBe(false);expect(first.ok?"":first.reason).toContain("v re-checks the already rejected artifact for R");expect(JSON.stringify(r)).toBe(before);const q=plan();q.nodes[1]!.id="renamed";q.edges=q.edges.map(([a,b])=>[a === "v"?"renamed":a,b === "v"?"renamed":b]);expect(replan(r,q,6).ok).toBe(false);expect(JSON.stringify(r)).toBe(before);expect(frontier(r)).toEqual([]);});
test("settled irreversible descendants and unknown verdict cannot rewind",()=>{
 // A gate verifies the artifact before the effect (pre-effect verification) and a check after it certifies E (certifying dominance).
 const p=plan();
 p.nodes.push({id:"authority",kind:"ask"},{id:"gate",kind:"verify",reads:["out"],covers:["G"]},{id:"effect",kind:"act",irreversible:true,writes:["sent"]},{id:"check",kind:"verify",reads:["sent"],covers:["E"]});
 p.edges.push(["authority","a"],["a","gate"],["gate","effect"],["effect","check"]);p.goal.requirements.push("G","E");
 expect(compilePlan(p).ok).toBe(true);
 const gate=(id:string)=>JSON.stringify({version:1,requirements:[{id,verdict:"pass",evidence:"checked"}],summary:"ok",repairable:false});
 const r=createRun("r",p,0);start(r,"authority","ask",1);succeed(r,"authority","authorized",2);start(r,"a","a",3);succeed(r,"a","artifact",4);
 start(r,"gate","g",5);succeed(r,"gate",gate("G"),6);start(r,"effect","effect",7);succeed(r,"effect","sent",8);
 // The later reviewer asks to repair a, but the admitted irreversible descendant forbids rewinding it.
 start(r,"v","v",9);succeed(r,"v",verdict("fail",true),10);expect(r.repairsUsed).toBe(0);expect(r.nodes.effect!.status).toBe("succeeded");expect(r.nodes.v!.status).toBe("failed");
 const unknown=createRun("u",plan(),0);review(unknown,verdict("unknown",true));expect(unknown.repairsUsed).toBe(0);expect(unknown.status).toBe("blocked");
});
test("missing actual repair feedback fails closed",()=>{const r=createRun("r",plan(),0);review(r,verdict("fail",true));delete r.nodes.a!.repairFeedback;expect(()=>dagPrompt(r,r.plan.nodes[0]!)).toThrow("missing failure feedback");});


test("coverage growth cannot reroll rejected R without actor execution", () => {
 const r=createRun("growth",plan(),0); review(r,verdict("fail"));
 const p=plan(); p.goal.requirements.push("S"); p.nodes[1]!.covers!.push("S");
 const before=JSON.stringify(r); expect(replan(r,p,5).ok).toBe(false); expect(JSON.stringify(r)).toBe(before);
 expect(frontier(r)).toEqual([]); expect(r.nodes.a!.runs).toBe(1); expect(r.certified).toEqual([]);
});
test.each(["same","changed","renamed"])("unknown effects cannot replay via %s replan", mode => {
 const r=createRun("unknown",plan(),0); start(r,"a","actor",1); fail(r,"a","lost executor",2,true);
 const p=plan(); if(mode==="changed") p.nodes[0]!.description="retry";
 if(mode==="renamed") { p.nodes[0]!.id="other"; p.nodes[1]!.repair!.predecessorId="other"; p.edges[0]![0]="other"; }
 const before=JSON.stringify(r); expect(replan(r,p,3).ok).toBe(false); expect(JSON.stringify(r)).toBe(before); expect(frontier(r)).toEqual([]);
});
function irreversibleRun() {
 const p=plan(); delete p.nodes[1]!.repair; p.nodes[0]!.irreversible=true;
 p.nodes.push({id:"authority",kind:"ask"}); p.edges.push(["authority","a"]);
 const r=createRun("effect",p,0); start(r,"authority","ask",1); succeed(r,"authority","authorized",2);
 start(r,"a","actor",3); readFact(r,"a","fact","old"); succeed(r,"a","sent",4);
 start(r,"v","reviewer",5); succeed(r,"v",verdict("fail"),6); return r;
}
test.each(["description","rename","remove"])("settled irreversible effect cannot be replayed by %s", mode=> {
 const r=irreversibleRun(); const p=structuredClone(r.plan);
 if(mode==="description") p.nodes[0]!.description="send again";
 if(mode==="rename") {p.nodes[0]!.id="other"; p.edges=p.edges.map(([a,b])=>[a==="a"?"other":a,b==="a"?"other":b]);}
 if(mode==="remove") {p.nodes=p.nodes.filter(n=>n.id!=="a");p.edges=p.edges.filter(e=>!e.includes("a"));}
 expect(replan(r,p,7).ok).toBe(false); expect(r.nodes.a!.runs).toBe(1);
});
test("fact changes and direct rekey cannot replay settled irreversible effects",()=> {
 const r=irreversibleRun(); reviseFact(r,"fact","new",7); rekey(r);
 expect(r.nodes.a!.status).toBe("failed"); expect(frontier(r)).toEqual([]); expect(r.nodes.a!.runs).toBe(1);
});
