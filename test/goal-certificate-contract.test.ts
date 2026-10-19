import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { openFixture, contract, context } from "./fixtures/verification-crash.ts";
import { WorkDoc } from "../src/core/verification.ts";
import { fingerprint } from "../src/core/verification-execution.ts";

test("T09 WorkService rejects forged current-fingerprint certificate absent native check receipt",async()=>{
 const dir=await mkdtemp(resolve(tmpdir(),"phase2-forged-")); const f=await openFixture(dir);
 try {
  await writeFile(resolve(f.root,"addition.test.ts"),'import {test,expect} from "bun:test"; test("adds",()=>expect(1+1).toBe(2));\n');
  const {conversation,sourceId}=await f.source();
  const registered=await f.service.register(conversation.id,{sourceIds:[sourceId],contract,scope:{root:f.root,inputs:[],disposable:[]},methods:{a:f.method}},"register",context);
  const fp=await fingerprint({root:f.root,inputs:[],disposable:[]},f.service.options.hostStorage,"node:local",context);
  // Adversarial persisted fixture: a certificate-shaped claim is not host-generated evidence.
  await f.harness.commit(async tx=>{const w=(await tx.doc(WorkDoc,conversation.id)).works[0]!; w.state="verified"; w.certificate={id:"forged",workId:w.id,sourceIds:w.sourceIds,contractHash:w.contractHash,version:w.version,methodEpoch:w.methodEpoch,mutationEpoch:w.mutationEpoch,fingerprint:fp.hash,evidenceIds:["absent-native-receipt"],at:Date.now(),limitations:[]};},context);
  const status=await f.service.status(conversation.id,context); console.log("T09 actual host",JSON.stringify({status:status.status,certificate:status.certificate?.id,unmet:status.unmetCheckIds}));
  expect(status.workId).toBe(registered.workId); expect(status.unmetCheckIds).toContain("a");
  expect(status.certificate).toBeNull(); expect(status.status).not.toBe("verified");
 } finally { await f.harness.close(context); if(process.platform==="win32") Bun.gc(true); }
},10000);
