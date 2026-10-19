import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NativeProvenanceDoc } from "../../src/core/claim-cleanup.ts";
import { ClaimsDoc } from "../../src/core/claims.ts";
import { openBot } from "../../src/core/bot.ts";
const [dir, mode]=process.argv.slice(2) as [string,"direct"|"codemode-only"];const nonce=randomUUID();
await writeFile(join(dir,"owned-child.ts"),'const nonce=process.argv[2];await Bun.write("ready.json",JSON.stringify({pid:process.pid,nonce}));await Bun.sleep(12000);await Bun.write("child-settled",nonce);');
const models=createModels();const faux=fauxProvider({provider:"faux",models:[{id:"m"}]});models.setProvider(faux.provider);
const call=(name:string,args:Record<string,string>)=>fauxAssistantMessage(mode==="direct"?fauxToolCall(name,args):fauxToolCall("codemode",{code:"text(await tools."+name+"("+JSON.stringify(args)+"));"}),{stopReason:"toolUse"});
const bun=process.execPath.replaceAll("\\","/");const command="\""+bun+"\" owned-child.ts "+nonce+" >/dev/null 2>&1 & sleep 3";
faux.setResponses([call("work_claim",{key:"owned:crash",intent:"exact acquisition"}),call("bash",{command}),fauxAssistantMessage("parent returned")]);
const storage=await openNodeSqliteStorage(join(dir,"host.sqlite"));const bot=await openBot({storage,models,defaultModel:{provider:"faux",modelId:"m"},workspaceRoot:dir,toolMode:mode,plugins:[]},context);const root=await bot.conversation("test",mode+"crash",context);await root.submit({type:"input",content:"run"},context);
for(let i=0;i<1000;i++){const journal=await bot.harness.snapshot(NativeProvenanceDoc,root.id,context);let child;try{child=JSON.parse(await readFile(join(dir,"ready.json"),"utf8"));}catch{}const event=journal?.calls.find(c=>c.kind==="process")?.processes?.find(e=>e.phase==="started");if(child && event?.startTime){if(child.nonce!==nonce)throw Error("fixture nonce mismatch");await writeFile(join(dir,"cut.json"),JSON.stringify({rootId:root.id,claims:await bot.harness.snapshot(ClaimsDoc,context),journal,child,nonce}));break;}if(i===999)throw Error("real process cut not reached");await Bun.sleep(10);}
await Bun.sleep(30000);throw Error("parent failed to SIGKILL fixture");
