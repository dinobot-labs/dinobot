import { expect, test } from "bun:test";
import { createReleaseWorker, ORIGIN, type Env } from "../script/cloudflare/worker.ts";

class MemoryCache {
 now = 0;
 entries = new Map<string, {response: Response; until: number}>();
 async match(key: Request) { const entry = this.entries.get(key.url); return entry && entry.until > this.now ? new Response(entry.response.clone().body, entry.response) : undefined; }
 async put(key: Request, response: Response) { const ttl = Number(/max-age=([0-9]+)/.exec(response.headers.get("cache-control") ?? "")?.[1] ?? 0); this.entries.set(key.url, {response: new Response(await response.arrayBuffer(), response), until: this.now + ttl}); }
}
function fixture(cache = new MemoryCache()) {
 let reads = 0;
 let version = "1.0.0";
 const env: Env = {CORE_PUBLISH_TOKEN:"fixture", BUCKET:{async get(key) {
  reads++;
  const data = key.endsWith(".tgz") ? "archive" : JSON.stringify({name:"dinobot",version,sourceSha:"a".repeat(40),size:7,publishedAt:"2026-01-01T00:00:00.000Z",dist:{tarball:ORIGIN+"/core/releases/"+version+"/dinobot-"+version+".tgz",integrity:"sha512-"+"A".repeat(86)+"=="}});
  return {etag:version,size:data.length,body:new Response(data).body!,text:async()=>data,arrayBuffer:async()=>new TextEncoder().encode(data).buffer};
 },async put(){throw new Error("unexpected write");}}};
 const worker = createReleaseWorker(undefined, cache);
 const get = (path:string, init?:RequestInit) => worker.fetch(new Request(ORIGIN+path,init),env) as Promise<Response>;
 return {cache,env,get,reads:()=>reads,setVersion:(value:string)=>{version=value;}};
}
test("query variants reuse one public R2 read", async()=>{
 const f=fixture();
 for(const query of ["", "?a=1", "?a=2", "?random=evil"]) {
  const response=await f.get("/core/latest.json"+query);
  expect(response.status).toBe(200); expect((await response.json() as any).version).toBe("1.0.0");
 }
 expect(f.reads()).toBe(1);
});

test("immutable query variants reuse bytes and cached hits bypass the limiter", async()=>{
 for(const path of ["/core/releases/1.0.0/manifest.json", "/core/releases/1.0.0/dinobot-1.0.0.tgz"]) {
  const f=fixture(); let limited=0;
  f.env.RELEASE_READ_LIMITER={async limit(){return {success:++limited===1};}};
  const expected=await (await f.get(path)).text();
  for(let i=0;i<3;i++) {
   const response=await f.get(path+"?nonce="+i);
   expect(response.status).toBe(200); expect(await response.text()).toBe(expected);
  }
  expect(limited).toBe(1); expect(f.reads()).toBe(1);
 }
});

test("latest and redirect expire after 30 seconds without downstream caching", async()=>{
 for (const path of ["/core/latest.json", "/core/dinobot.tgz"]) {
  const f=fixture(); const first=await f.get(path);
  expect(first.headers.get("cache-control")).toBe("no-store");
  f.setVersion("2.0.0"); f.cache.now=29;
  const cached=await f.get(path+"?bust=1");
  expect(cached.headers.get("cache-control")).toBe("no-store");
  expect(f.reads()).toBe(1);
  if(path.endsWith("json")) expect((await cached.json() as any).version).toBe("1.0.0");
  else expect(cached.headers.get("location")).toContain("1.0.0");
  f.cache.now=30; const fresh=await f.get(path);
  if(path.endsWith("json")) expect((await fresh.json() as any).version).toBe("2.0.0");
  else expect(fresh.headers.get("location")).toContain("2.0.0");
  expect(f.reads()).toBe(2);
 }
});
test("HEAD, conditional and Range cannot poison immutable GET bytes", async()=>{
 const f=fixture(); const path="/core/releases/1.0.0/dinobot-1.0.0.tgz";
 expect(await (await f.get(path,{method:"HEAD"})).text()).toBe("");
 expect(f.cache.entries.size).toBe(0);
 const ranged=await f.get(path,{headers:{Range:"bytes=1-2"}});
 expect(ranged.status).toBe(200); expect(await ranged.text()).toBe("archive");
 const conditional=await f.get(path,{headers:{"If-None-Match":'W/"1.0.0"'}});
 expect(conditional.status).toBe(304); expect(await conditional.text()).toBe("");
 expect(conditional.headers.has("content-length")).toBe(false);
 const head=await f.get(path,{method:"HEAD"});
 expect(await head.text()).toBe(""); expect(head.headers.get("content-length")).toBe("7");
 const full=await f.get(path+"?other=2",{headers:{"If-Range":'"wrong"',Range:"bytes=99-"}});
 expect(full.status).toBe(200); expect(await full.text()).toBe("archive");
 expect(full.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
 expect(f.reads()).toBe(2);
});
test("private headers and publication never access cache; bootstrap stays no-store", async()=>{
 const f=fixture();
 for(const headers of [{Authorization:"Bearer fixture"},{Cookie:"private=yes"}]) {
  for(let i=0;i<2;i++) expect((await f.get("/core/latest.json",{headers})).status).toBe(200);
 }
 expect(f.reads()).toBe(4); expect(f.cache.entries.size).toBe(0);
 f.env.RELEASE_READ_LIMITER={async limit(){throw new Error("must not limit publication");}};
 expect((await f.get("/core/publish",{method:"POST",body:"private"})).status).toBe(401);
 const bootstrap=createReleaseWorker({"/install.sh":"shell","/install.ps1":"ps","/install.mjs":"js"},f.cache);
 const response=await bootstrap.fetch(new Request(ORIGIN+"/install.sh"),f.env);
 expect(await response.text()).toBe("shell"); expect(response.headers.get("cache-control")).toBe("no-store");
 expect(f.cache.entries.size).toBe(0); expect(f.reads()).toBe(4);
});
test("valid nonexistent versions share limiter, never negative-cache, malformed routes cost no R2", async()=>{
 const f=fixture(); let reads=0; const keys:string[]=[];
 f.env.BUCKET.get=async()=>{reads++;return null;};
 f.env.RELEASE_READ_LIMITER={async limit({key}){keys.push(key);return {success:keys.length<=2};}};
 for(let i=0;i<5;i++) {
  const response=await f.get("/core/releases/"+i+".0.0/manifest.json?bust="+i,{headers:{"CF-Connecting-IP":"192.0.2.1"}});
  expect(response.status).toBe(i<2?404:429);
  expect(response.headers.get("cache-control")).toBe("no-store");
 }
 expect(reads).toBe(2); expect(new Set(keys).size).toBe(1); expect(f.cache.entries.size).toBe(0);
 expect((await f.get("/core/releases/bad/manifest.json")).status).toBe(404);
 expect(reads).toBe(2); expect(keys.length).toBe(5);
});
test("missing objects and storage failures never hide a subsequent publication", async()=>{
 const f=fixture(); const original=f.env.BUCKET.get;
 f.env.BUCKET.get=async()=>null;
 expect((await f.get("/core/latest.json")).status).toBe(404);
 f.env.BUCKET.get=async()=>{throw new Error("backend failure");};
 expect((await f.get("/core/latest.json")).status).toBe(503);
 expect(f.cache.entries.size).toBe(0);
 f.env.BUCKET.get=original;
 expect((await f.get("/core/latest.json")).status).toBe(200);
});
test("cache outages degrade to R2 and waitUntil owns cache writes", async()=>{
 const f=fixture();
 const broken={async match(){throw new Error("cache down");},async put(){throw new Error("cache down");}};
 const promises:Promise<unknown>[]=[];
 const response=await createReleaseWorker(undefined,broken).fetch(new Request(ORIGIN+"/core/latest.json"),f.env,{waitUntil(p){promises.push(p);}});
 expect(response.status).toBe(200); expect(promises.length).toBe(1);
 await Promise.all(promises);
 expect(f.reads()).toBe(1);
});

