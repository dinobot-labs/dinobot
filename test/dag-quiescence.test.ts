import { test,expect } from "bun:test";
import {createRun,start,succeed,settleRepairs,fail, type RunState} from "../src/core/dag.ts";
import type {Plan} from "../src/core/plan.ts";
const p:Plan={nodes:[{id:"actor",kind:"act",writes:["out"]},{id:"bad",kind:"verify",reads:["out"],covers:["R"],repair:{predecessorId:"actor",maxRepairs:2}},{id:"peer",kind:"verify",reads:["out"],covers:["S"]}],edges:[["actor","bad"],["actor","peer"]],goal:{requirements:["R","S"]}};
const verdict=(id:string,v="pass")=>JSON.stringify({version:1,requirements:[{id,verdict:v,evidence:"checked actual fixture"}],summary:"checked",repairable:v==="fail"});
function running(){const r=createRun("run",p,0);start(r,"actor","a",1);succeed(r,"actor","prior",2);start(r,"bad","b",3);start(r,"peer","p",4);return r;}
for(const order of [["bad","peer"],["peer","bad"]])test("T17 both outcome orders "+order.join(","),()=>{
 const r=running();for(const id of order)succeed(r,id,verdict(id==="bad"?"R":"S",id==="bad"?"fail":"pass"),5,true);settleRepairs(r,6);
 expect(r.repairsUsed).toBe(1);expect(r.certified).toEqual([]);expect(r.nodes.peer!.proof).toBeUndefined();expect(r.nodes.actor!.repairFeedback).toContain("prior");expect(r.repairHistory![0]!.nodes.peer!.status).toBe("succeeded");
 settleRepairs(r,7);expect(r.repairsUsed).toBe(1);
});
test("T17 live peer negative survives serialization and advances after quiescence",()=>{
 let r=running();succeed(r,"bad",verdict("R","fail"),5);expect(r.repairsUsed).toBe(0);expect(r.nodes.bad!.pendingRepair?.result).toContain("fail");
 r=JSON.parse(JSON.stringify(r)) as RunState;succeed(r,"peer",verdict("S"),6);expect(r.repairsUsed).toBe(1);expect(r.nodes.actor!.generation).toBe(1);
});
test("T17 unknown sibling verdict denies rewind",()=>{const r=running();succeed(r,"bad",verdict("R","fail"),5);succeed(r,"peer",verdict("S","unknown"),6);settleRepairs(r,7);expect(r.repairsUsed).toBe(0);expect(r.status).toBe("blocked");});
test("T17 lost peer effects deny rewind",()=>{const r=running();succeed(r,"bad",verdict("R","fail"),5);fail(r,"peer","lost",6,true);settleRepairs(r,7);expect(r.repairsUsed).toBe(0);expect(r.nodes.peer!.unknownEffects).toBe(true);});
test("T14 credit remains exhausted after restart",()=>{let r=running();r.repairsUsed=2;succeed(r,"bad",verdict("R","fail"),5);r=JSON.parse(JSON.stringify(r));succeed(r,"peer",verdict("S"),6);settleRepairs(r,7);expect(r.repairsUsed).toBe(2);expect(r.nodes.actor!.runs).toBe(1);});
test("T04 STALE generation negative cannot rewind or reject current artifact",()=>{const r=running();r.nodes.actor!.generation=1;succeed(r,"bad",verdict("R","fail"),5);expect(r.repairsUsed).toBe(0);expect(r.rejectedArtifacts??[]).toEqual([]);expect(r.nodes.bad!.pendingRepair).toBeUndefined();});
