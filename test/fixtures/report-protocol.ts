import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
/** Captures client wire messages. Does not model D1/R2/Queue, server redaction or retention. */
export function reportProtocol() {
 const uploads = new Map<string, {body: Uint8Array; manifest: any}>();
 const deleted = new Set<string>();
 const posts: string[] = [];
 return {uploads, deleted, posts, async handle(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && path === "/v1/reports") {
   const body = new Uint8Array(await request.arrayBuffer());
   expect(request.headers.get("content-type")).toBe("application/vnd.dinobot.report+gzip");
   expect(request.headers.get("x-dinobot-body-sha256")).toBe(hash(body));
   const manifest = JSON.parse(gunzipSync(body).toString("utf8").split("\n")[0]!);
   expect(manifest.schema).toBe("dinobot.report/v1");
   uploads.set(manifest.reportId,{body,manifest}); posts.push(manifest.reportId);
   return Response.json({id:manifest.reportId},{status:202});
  }
  const credential = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (request.method === "DELETE" && path.startsWith("/v1/reports/")) {
   const id=path.split("/").at(-1)!; const value=uploads.get(id);
   expect(value).toBeDefined(); expect(hash(credential)).toBe(value!.manifest.deleteTokenSha256);
   deleted.add(id); return new Response(null,{status:204});
  }
  if (request.method === "POST" && path.endsWith("/withdraw")) {
   const install=path.split("/")[3]; let count=0;
   for(const [id,value] of uploads) if(value.manifest.installId===install && !deleted.has(id)) {
    expect(hash(credential)).toBe(value.manifest.installKeySha256); deleted.add(id); count++;
   }
   return Response.json({deleted:count});
  }
  return new Response("unexpected fixture route",{status:404});
 }};
}
export async function uploadedContent(fixture: ReturnType<typeof reportProtocol>, id: string, token: string): Promise<string> {
 const value=fixture.uploads.get(id)!; expect(hash(token)).toBe(value.manifest.deleteTokenSha256);
 return gunzipSync(value.body).toString("utf8");
}
