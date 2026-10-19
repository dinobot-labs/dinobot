import { expect, test } from "bun:test";
import { mkdtemp, mkdir, stat, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, type TaskId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot } from "../src/core/bot.ts";
import { ResearchServiceDoc } from "../src/core/research-service.ts";
import type { CommandSpec, Contract } from "../src/core/research.ts";
async function git(cwd:string,...args:string[]) { const p=Bun.spawn(['git','-c','core.hooksPath=/dev/null',...args],{cwd,stdout:'pipe',stderr:'pipe'}); const out=await new Response(p.stdout).text(); if(await p.exited) throw new Error(await new Response(p.stderr).text()); return out.trim(); }
const brokenSource = 'export function inject(t) { const i=t.messages.length-1; if(t.messages[i]?.role==="user") t.messages[i].content += "\\nTREATMENT"; return t; } // broken tail assumption';
const fixedSource = 'export function inject(t) { const i=t.messages.findLastIndex(m=>m.role==="user"); if(i>=0) t.messages[i].content += "\\nTREATMENT"; return t; }';
const evaluatorSource = [
 'import {appendFileSync} from "node:fs";',
 'import {inject} from "./candidate.ts";',
 'import {openBot} from '+JSON.stringify(new URL('../src/core/bot.ts',import.meta.url).href)+';',
 'import {createModels} from '+JSON.stringify(import.meta.resolve('@earendil-works/pi-ai/models'))+';',
 'import {fauxProvider,fauxAssistantMessage} from '+JSON.stringify(import.meta.resolve('@earendil-works/pi-ai/providers/faux'))+';',
 'import {MemoryStorage} from '+JSON.stringify(import.meta.resolve('@earendil-works/pi-durable'))+';',
 'import {BACKGROUND_CONTEXT as ctx} from '+JSON.stringify(import.meta.resolve('@earendil-works/chord/context'))+';',
 'const stage=process.argv[2]; appendFileSync(process.argv[3],stage+String.fromCharCode(10));',
 'let ok=false, expected; const faux=fauxProvider({provider:"faux",models:[{id:"m"}]});',
 'faux.setResponses([t=>{ok=JSON.stringify(t)===JSON.stringify(expected);return fauxAssistantMessage("fixture");}]);',
 'function transform(t) { const input=structuredClone(t); input.messages.push({role:"system",content:"COMMON FROZEN SCHEMA",timestamp:0}); expected=structuredClone(input); const i=expected.messages.findLastIndex(m=>m.role==="user"); expected.messages[i].content += String.fromCharCode(10)+"TREATMENT"; return inject(input); }',
 'const provider={...faux.provider,stream:(m,t,o)=>faux.provider.stream(m,transform(t),o),streamSimple:(m,t,o)=>faux.provider.streamSimple(m,transform(t),o)};',
 'const models=createModels(); models.setProvider(provider); const bot=await openBot({storage:new MemoryStorage(),models,defaultModel:{provider:"faux",modelId:"m"},workspaceRoot:process.cwd(),toolMode:"direct",plugins:[],settings:{retry:{enabled:false}}},ctx);',
 'try { await bot.handle({channel:"test",threadKey:"preflight",messageId:"m1",userId:"u",text:"INPUT"},ctx); } finally { await bot.close(ctx); }',
 'console.log(JSON.stringify(stage==="evaluation"?{version:"research-numeric-v2",samples:[1],metric:"score",unit:"points",guardrails:true,requirements:[{id:"correct",verdict:ok?"pass":"fail",evidenceIds:[]}],feedback:"actual provider-facing candidate request checked"}:{version:"research-readiness-v1",checks:[{id:stage,verdict:ok?"pass":"fail"}],feedback:ok?"ready":"candidate injection broken for [user,system]; exact provider-facing request differs"}));',
].join('\n');
test.each(['repair','no-opt-in','unknown-preflight','missing-preflight','canary-fail','forbidden-edit','repeat-failure','schema-mutation','context-overflow','alias-main-dot','alias-main-parent','alias-preflight-dot','alias-preflight-parent','alias-canary-dot','alias-canary-parent'] as const)('frozen readiness and permitted baseline repair: %s', async(scenario)=>{
 const root=await mkdtemp(join(tmpdir(),'research-repair-')); let bot: Awaited<ReturnType<typeof openBot>>|undefined;
 try {
  await git(root,'init'); await git(root,'config','user.email','fixture@example.invalid'); await git(root,'config','user.name','fixture');
  const original = scenario==='context-overflow' ? brokenSource+'x'.repeat(25000) : brokenSource;
  await writeFile(join(root,'candidate.ts'),original);
  let frozenEvaluator = evaluatorSource;
  if(scenario==='unknown-preflight') frozenEvaluator=frozenEvaluator.replace('verdict:ok?"pass":"fail"}],feedback', 'verdict:"unknown"}],feedback');
  if(scenario==='missing-preflight') frozenEvaluator=frozenEvaluator.replace('checks:[{id:stage,verdict:ok?"pass":"fail"}]', 'checks:[]');
  if(scenario==='canary-fail') frozenEvaluator=frozenEvaluator.replace('verdict:ok?"pass":"fail"}],feedback','verdict:stage==="canary"?"fail":ok?"pass":"fail"}],feedback');
  await writeFile(join(root,'evaluator.ts'), frozenEvaluator);
  await git(root,'add','.'); await git(root,'commit','-m','fixture'); const base=await git(root,'rev-parse','HEAD');
  const marker=join(root,'calls');
  const profile:CommandSpec={executable:process.execPath,argv:['evaluator.ts','evaluation',marker],cwdPolicy:'candidate',environmentAllowlist:[],timeoutMs:5000,resultSchema:'research-numeric-v2',baseCommit:base,permittedPaths:['candidate.ts'],readiness:{preflight:{argv:['evaluator.ts','preflight',marker],checkIds:['preflight']},canary:{argv:['evaluator.ts','canary',marker],checkIds:['canary']}}};
  const alias = scenario.startsWith('alias-');
  if(alias) {
   await mkdir(join(root,'sub'));
   const argv = scenario.includes('-main-') ? profile.argv : scenario.includes('-preflight-') ? profile.readiness!.preflight.argv : profile.readiness!.canary.argv;
   argv[0] = scenario.endsWith('-dot') ? '././candidate.ts' : 'sub/../candidate.ts';
  }
  const frozenProfile = structuredClone(profile);
  const worktrees = await git(root,'worktree','list','--porcelain');
  const faux=fauxProvider({provider:'faux',models:[{id:'m'}]}); const prompts:string[]=[];
  faux.setResponses(Array.from({length:20},()=>t=>{ const msg=t.messages.findLast(m=>m.role==='user'); const text=String(msg?.content);
   if(!text.startsWith('{"researchRole"')) {
    const result = t.messages.findLast(m=>m.role==='toolResult');
    if(alias && result) {
     expect(result.toolName).toBe('research_start');
     expect(result.isError).toBe(true);
     expect(JSON.stringify(result.content)).toContain('author-editable');
    }
    return result ? fauxAssistantMessage('Started') : fauxAssistantMessage(fauxToolCall('research_start',{contract}),{stopReason:'toolUse'});
   }
   prompts.push(text);
   const content=scenario==='repeat-failure'?brokenSource:scenario==='schema-mutation'?fixedSource.replace('return t;', 't.messages.at(-1).content="WEAKENED SCHEMA"; return t;'):fixedSource;
   return fauxAssistantMessage(JSON.stringify({hypothesis:'Repair actual failed injection',edits:[{path:scenario==='forbidden-edit'?'evaluator.ts':'candidate.ts',content}]})); }));
  const models=createModels(); models.setProvider(faux.provider);
  bot=await openBot({storage:alias ? await openNodeSqliteStorage(join(root,'admission.sqlite')) : new MemoryStorage(),models,defaultModel:{provider:'faux',modelId:'m'},workspaceRoot:root,toolMode:'direct',plugins:[],researchCodeProfiles:{fixture:profile},settings:{retry:{enabled:false}}},context);
  const parent=await bot.conversation('test','repair',context);
  const contract={question:'Preserve correct injection',hypotheses:['repair works'],requirements:[{id:'correct',mandatory:true}],scope:'candidate.ts',exclusions:['evaluator'],mode:'trusted-local-code',baseline:{definition:'Original broken candidate'},policy:{kind:'numeric',numeric:{metric:'score',unit:'points',direction:'max',repetitions:1,aggregation:'mean',minimumEffect:1,goalThreshold:1},maxNoProgressRounds:2,maxDebugChildren:2,confirmation:'required-once'},repair:{baseline:true,candidate:true,maxPerFailure:2},reportAuthorityRef:'fixture',codeAuthorityRef:'host:fixture'} as Contract;
  if(scenario==='no-opt-in') delete contract.repair;
  await bot.handle({channel:'test',threadKey:'repair',messageId:'start',userId:'fixture',text:'Start bounded repair'},context);
  const started=(await bot.research.status(parent.id,context)).mission!;
  if(alias) {
   expect(started).toBeUndefined();
   expect(Object.keys((await bot.harness.snapshot(ResearchServiceDoc,parent.id,context))?.records ?? {})).toHaveLength(0);
   expect(prompts).toHaveLength(0);
   await expect(stat(marker)).rejects.toMatchObject({code:'ENOENT'});
   await expect(stat(join(root,'.dinobot','research'))).rejects.toMatchObject({code:'ENOENT'});
   expect(await git(root,'worktree','list','--porcelain')).toBe(worktrees);
   expect(await readFile(join(root,'candidate.ts'),'utf8')).toBe(original);
   expect(profile).toEqual(frozenProfile);
   return;
  }
  expect(started).toBeDefined();
  await bot.harness.waitForTask(Number(started.controllerTaskId) as TaskId<string>,context);
  const m=(await bot.research.status(parent.id,context)).mission!;
  if(scenario!=='repair') {
   expect(m.status,JSON.stringify(m)).toBe('blocked');
   const calls=await readFile(marker,'utf8'); expect(calls).not.toContain('evaluation');
   expect(m.selectedId).toBeUndefined();
   expect(prompts.length).toBeLessThanOrEqual(2);
   if(['unknown-preflight','missing-preflight','no-opt-in','context-overflow'].includes(scenario)) expect(prompts).toHaveLength(0);
   if(scenario==='canary-fail') expect(calls).toContain('canary');
   if(scenario==='repeat-failure'||scenario==='schema-mutation') { expect(prompts).toHaveLength(2); expect(calls).toBe('preflight\npreflight\npreflight\n'); }
   expect(await readFile(join(root,'candidate.ts'),'utf8')).toBe(original);
   if(scenario==='context-overflow') expect(m.attempts.at(-1)!.error).toContain('24 KiB');
   return;
  }
  expect(m.status,JSON.stringify((await bot.harness.snapshot(ResearchServiceDoc,parent.id,context))!.records[m.id])).toBe('concluded'); expect(m.candidates).toHaveLength(2); expect(m.selectedId).not.toBe(m.candidates[0]!.id);
  expect(await readFile(marker,'utf8')).toBe('preflight\npreflight\ncanary\nevaluation\npreflight\ncanary\nevaluation\n');
  expect(await readFile(join(root,'candidate.ts'),'utf8')).toBe(brokenSource);
  expect(prompts).toHaveLength(1); expect(prompts[0]).toContain('candidate injection broken'); expect(prompts[0]).toContain('broken');
  const s=(await bot.harness.snapshot(ResearchServiceDoc,parent.id,context))!.records[m.id]!;
  expect(Object.values(s.stages!)).toHaveLength(7); expect(Object.values(s.stages!).every(s=>s.state==='done' && s.receiptHash)).toBe(true);
 } finally { await bot?.close(context); await rm(root,{recursive:true,force:true}); }
},30000);
