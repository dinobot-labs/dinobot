import { resolve } from 'node:path';

/** Build without network access; entry override supports isolated installer fixtures. */
export async function buildReleaseModules(installerEntry = resolve(import.meta.dir, "../../src/managed-install.ts")): Promise<Record<string, { content: string; type: string }>> {
 const installer = await Bun.build({entrypoints:[installerEntry],target:"bun",format:"esm",minify:true,sourcemap:"none"});
 if (!installer.success || installer.outputs.length !== 1) throw new Error("Installer build failed");
 const worker = await Bun.build({entrypoints:[resolve(import.meta.dir, "deploy-entry.ts")],target:"browser",format:"esm",minify:true,sourcemap:"none",external:["*.txt"]});
 if (!worker.success || worker.outputs.length !== 1) throw new Error("Worker build failed");
 return {
  "worker.js": {content:await worker.outputs[0]!.text(),type:"application/javascript+module"},
  "install.sh.txt": {content:await Bun.file(resolve(import.meta.dir,"../install/install.sh")).text(),type:"text/plain"},
  "install.ps1.txt": {content:await Bun.file(resolve(import.meta.dir,"../install/install.ps1")).text(),type:"text/plain"},
  "install.mjs.txt": {content:await installer.outputs[0]!.text(),type:"text/plain"},
 };
}

/** Deploy only the dedicated core-release Worker; never the Desktop download service. */
export async function deployReleaseWorker(env: NodeJS.ProcessEnv = process.env, dependencies: { fetch?: typeof fetch; build?: typeof buildReleaseModules } = {}): Promise<void> {
 const account = env.CLOUDFLARE_ACCOUNT_ID;
 const apiToken = env.CLOUDFLARE_API_TOKEN;
 const publishToken = env.CORE_PUBLISH_TOKEN;
 const bucket = env.CLOUDFLARE_RELEASE_BUCKET;
 if (!account || !/^[a-f0-9]{32}$/.test(account) || !apiToken || (publishToken !== undefined && publishToken.length < 32) || !bucket || !/^[a-z0-9][a-z0-9-]+$/.test(bucket)) throw new Error('Missing or invalid deployment settings');
 const modules = await (dependencies.build ?? buildReleaseModules)();
 const api = 'https://api.cloudflare.com/client/v4/accounts/' + account + '/workers/scripts/releases';
 const request = async (url: string, init: RequestInit) => {
  const response = await (dependencies.fetch ?? fetch)(url, {...init,redirect:'error',signal:AbortSignal.timeout(60000),headers:{...init.headers,authorization:'Bearer ' + apiToken}});
  const data = await response.json() as {success?:boolean;result?:{id?:string;bindings?:{name:string;type:string;bucket_name?:string}[]}};
  if (!response.ok || data.success !== true) throw new Error('Cloudflare operation failed (HTTP ' + response.status + ')');
  return data.result;
 };
 // Redeploys preserve the existing publication secret rather than requiring its plaintext.
 // Fail closed on wrong/missing bindings; first deployment still requires a new secret.
 if (publishToken === undefined) {
  const current = await request(api + '/settings', {method:'GET'});
  if (!current?.bindings?.some(b => b.name === 'CORE_PUBLISH_TOKEN' && b.type === 'secret_text')
   || !current.bindings.some(b => b.name === 'BUCKET' && b.type === 'r2_bucket' && b.bucket_name === bucket)) throw new Error('Existing release Worker bindings do not match');
 }
 const form = new FormData();
 form.set('metadata', new Blob([JSON.stringify({main_module:'worker.js',compatibility_date:'2026-10-31',...(publishToken === undefined ? {keep_bindings:['secret_text']} : {}),bindings:[{type:'r2_bucket',name:'BUCKET',bucket_name:bucket},...(publishToken === undefined ? [] : [{type:'secret_text',name:'CORE_PUBLISH_TOKEN',text:publishToken}])]})],{type:'application/json'}));
 for (const [name, module] of Object.entries(modules)) form.set(name, new Blob([module.content], {type:module.type}), name);
 const result = await request(api,{method:'PUT',body:form});
 console.log(JSON.stringify({worker:'releases',uploaded:true,id:result?.id ?? null}));
 await request(api + '/subdomain',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:true,previews_enabled:false})});
 console.log('Worker deployment complete: releases (Desktop get Worker unchanged)');
}

if (import.meta.main) {
 try { await deployReleaseWorker(); } catch (error) { console.error('Worker deployment failed; check build inputs and deployment settings.'); process.exitCode = 1; }
}
