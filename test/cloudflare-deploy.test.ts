import { expect, test } from "bun:test";
import { deployReleaseWorker } from "../script/cloudflare/deploy.ts";
const env = {CLOUDFLARE_ACCOUNT_ID:"a".repeat(32),CLOUDFLARE_API_TOKEN:"fixture",CLOUDFLARE_RELEASE_BUCKET:"release-fixture"};
const bindings = [{name:"BUCKET",type:"r2_bucket",bucket_name:"release-fixture"},{name:"CORE_PUBLISH_TOKEN",type:"secret_text"}];
const build = async () => ({"worker.js":{content:"export default {}",type:"application/javascript+module"}});
test("redeploy preserves an existing secret without reading its value",async()=>{
 const calls:string[]=[]; let metadata:any;
 const fetcher=(async(url:any,init:any)=>{calls.push(init.method); if(init.method==="PUT") metadata=JSON.parse(await init.body.get("metadata").text()); return Response.json({success:true,result:{bindings,id:"fixture"}});}) as typeof fetch;
 await deployReleaseWorker(env,{fetch:fetcher,build});
 expect(calls).toEqual(["GET","PUT","POST"]); expect(metadata.keep_bindings).toEqual(["secret_text"]);
 expect(metadata.bindings).toEqual([bindings[0]]);
});
for(const wrong of [[],[bindings[0]],[{...bindings[0],bucket_name:"wrong"},bindings[1]]]) test("mismatched existing bindings cannot mutate deployment "+JSON.stringify(wrong),async()=>{
 const calls:string[]=[];
 const fetcher=(async(url:any,init:any)=>{calls.push(init.method);return Response.json({success:true,result:{bindings:wrong}});}) as typeof fetch;
 await expect(deployReleaseWorker(env,{fetch:fetcher,build})).rejects.toThrow("bindings do not match");
 expect(calls).toEqual(["GET"]);
});
test("initial deploy supplies explicit new publication secret",async()=>{
 const secret="x".repeat(32); let metadata:any; const calls:string[]=[];
 const fetcher=(async(url:any,init:any)=>{calls.push(init.method);if(init.method==="PUT") metadata=JSON.parse(await init.body.get("metadata").text());return Response.json({success:true,result:{id:"fixture"}});}) as typeof fetch;
 await deployReleaseWorker({...env,CORE_PUBLISH_TOKEN:secret},{fetch:fetcher,build});
 expect(calls).toEqual(["PUT","POST"]); expect(metadata.keep_bindings).toBeUndefined();
 expect(metadata.bindings[1]).toEqual({name:"CORE_PUBLISH_TOKEN",type:"secret_text",text:secret});
});
