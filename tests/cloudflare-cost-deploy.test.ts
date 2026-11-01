import {expect,test} from "bun:test";
import {deployReleaseWorker} from "../script/cloudflare/deploy.ts";
const env={CLOUDFLARE_ACCOUNT_ID:"a".repeat(32),CLOUDFLARE_API_TOKEN:"fixture",CLOUDFLARE_RELEASE_BUCKET:"fixture-bucket",CLOUDFLARE_RELEASE_RATE_NAMESPACE:"1234"};
const build=async()=>({"worker.js":{content:"export default {}",type:"application/javascript+module"}});
test("release limiter upload uses explicit namespace while preserving secret",async()=>{
 let metadata:any;
 const fetcher=(async(_url:any,init:any)=>{
  if(init.method==="PUT") metadata=JSON.parse(await init.body.get("metadata").text());
  return Response.json({success:true,result:{bindings:[{name:"BUCKET",type:"r2_bucket",bucket_name:"fixture-bucket"},{name:"CORE_PUBLISH_TOKEN",type:"secret_text"}]}});
 }) as typeof fetch;
 await deployReleaseWorker(env,{fetch:fetcher,build});
 expect(metadata.keep_bindings).toEqual(["secret_text"]);
 expect(metadata.bindings).toContainEqual({type:"ratelimit",name:"RELEASE_READ_LIMITER",namespace_id:"1234",simple:{limit:120,period:60}});
 expect(metadata.bindings.some((b:any)=>b.type==="secret_text")).toBe(false);
});
test("invalid rate namespace fails before build or network",async()=>{
 for(const value of ["", "0", "-1", "1.5", "bad"]) {
  await expect(deployReleaseWorker({...env,CLOUDFLARE_RELEASE_RATE_NAMESPACE:value},{build:async()=>{throw new Error("must not build");}})).rejects.toThrow("Invalid release rate namespace");
 }
});
