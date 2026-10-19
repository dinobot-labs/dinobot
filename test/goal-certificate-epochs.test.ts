import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { openFixture, contract, context } from "./fixtures/verification-crash.ts";
import { EvidenceDoc, WorkDoc, type Work } from "../src/core/verification.ts";

const variants: [string, (w: Work) => void][] = [
 ["wrong work identity",w=>{w.certificate!.workId="foreign";}],
 ["stale version",w=>{w.certificate!.version--;}],
 ["stale method epoch",w=>{w.certificate!.methodEpoch--;}],
 ["stale mutation epoch",w=>{w.certificate!.mutationEpoch++;}],
 ["same-ID assertion weakening",w=>{w.contract.requirements[0]!.assertion="ID-only success";}],
 ["unbound human source",w=>{w.certificate!.sourceIds.push("foreign-source");}],
 ["missing selected receipt",w=>{w.certificate!.evidenceIds=["absent"];}]
];
for(const [name,tamper] of variants) test("T09 native certificate rejects "+name,async()=>{
 const dir=await mkdtemp(resolve(tmpdir(),"phase2-epoch-")); const f=await openFixture(dir);
 try {
  await writeFile(resolve(f.root,"addition.test.ts"),'import {test,expect} from "bun:test"; test("adds",()=>expect(1+1).toBe(2));\n');
  const {conversation,sourceId}=await f.source();
  const registered=await f.service.register(conversation.id,{sourceIds:[sourceId],contract,scope:{root:f.root,inputs:[],disposable:[]},methods:{a:f.method}},"register",context);
  await f.run(conversation.id,registered.workId!);
  const native=await f.service.finish(conversation.id,registered.workId!,"finish",context);
  expect(native.status).toBe("verified"); expect(native.certificate?.evidenceIds.length).toBe(1);
  const receipt=(await f.harness.snapshot(EvidenceDoc,conversation.id,context))!.attempts[0]!;
  const task=await f.harness.getTask(Number(receipt.taskId) as any,context); expect(task?.kind).toBe("dinobot.check"); expect(task?.state.status).toBe("terminal");
  await f.harness.commit(async tx=>{tamper((await tx.doc(WorkDoc,conversation.id)).works[0]!);},context);
  const status=await f.service.status(conversation.id,context);
  expect(status.certificate).toBeNull(); expect(status.status).not.toBe("verified");
 } finally {await f.harness.close(context);if(process.platform==="win32")Bun.gc(true);}
},10000);
