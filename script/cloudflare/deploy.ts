import { resolve } from 'node:path';

/** Deploy only the dedicated core-release Worker; never the Desktop download service. */
export async function deployReleaseWorker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
 const account = env.CLOUDFLARE_ACCOUNT_ID;
 const apiToken = env.CLOUDFLARE_API_TOKEN;
 const publishToken = env.CORE_PUBLISH_TOKEN;
 const bucket = env.CLOUDFLARE_RELEASE_BUCKET;
 if (!account || !/^[a-f0-9]{32}$/.test(account) || !apiToken || !publishToken || publishToken.length < 32 || !bucket || !/^[a-z0-9][a-z0-9-]+$/.test(bucket)) throw new Error('Missing or invalid deployment settings');
 const build = await Bun.build({entrypoints:[resolve(import.meta.dir, 'worker.ts')],target:'browser',format:'esm',minify:true,sourcemap:'none'});
 if (!build.success || build.outputs.length !== 1) throw new Error('Worker build failed');
 const api = 'https://api.cloudflare.com/client/v4/accounts/' + account + '/workers/scripts/releases';
 const request = async (url: string, init: RequestInit) => {
  const response = await fetch(url, {...init,redirect:'error',signal:AbortSignal.timeout(60000),headers:{...init.headers,authorization:'Bearer ' + apiToken}});
  const data = await response.json() as {success?:boolean;result?:{id?:string}};
  if (!response.ok || data.success !== true) throw new Error('Cloudflare operation failed (HTTP ' + response.status + ')');
  return data.result;
 };
 const form = new FormData();
 form.set('metadata', new Blob([JSON.stringify({main_module:'worker.js',compatibility_date:'2026-10-31',bindings:[{type:'r2_bucket',name:'BUCKET',bucket_name:bucket},{type:'secret_text',name:'CORE_PUBLISH_TOKEN',text:publishToken}]})],{type:'application/json'}));
 form.set('worker.js',new Blob([await build.outputs[0]!.text()],{type:'application/javascript+module'}),'worker.js');
 const result = await request(api,{method:'PUT',body:form});
 console.log(JSON.stringify({worker:'releases',uploaded:true,id:result?.id ?? null}));
 await request(api + '/subdomain',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:true,previews_enabled:false})});
 console.log('Worker deployment complete: releases (Desktop get Worker unchanged)');
}

if (import.meta.main) {
 try { await deployReleaseWorker(); } catch (error) { console.error(error instanceof Error ? error.message : 'Worker deployment failed'); process.exitCode = 1; }
}
