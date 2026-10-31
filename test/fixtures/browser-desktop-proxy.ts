import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPrivateFile } from "../../src/telegram-private-files/index.ts";
import { callDesktop } from "../../src/plugins/browser/desktop-bridge.ts";

// Bun caches ambient proxy configuration beyond process.env restoration.
// This security check therefore owns a disposable process.
const root = await mkdtemp(join(tmpdir(), "desktop-proxy-"));
const token = "a".repeat(64);
let proxyRequests = 0;
const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
 proxyRequests++;
 return Response.json({ id: 0, ok: true, result: { text: "proxy" } });
} });
const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ id: 0, ok: true, result: { text: "direct" } }) });
const redirect = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 307, headers: { Location: String(proxy.url) + "steal" } }) });
try {
 for (const name of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"]) {
  process.env[name] = name.toLowerCase() === "no_proxy" ? "" : String(proxy.url);
 }
 const path = join(root, "desktop.json");
 createPrivateFile(path, JSON.stringify({ version: 1, port: endpoint.port, token }));
 assert.equal((await callDesktop(path, "open", { url: "https://example.test" }))?.text, "direct");
 assert.equal(proxyRequests, 0);
 const redirectPath = join(root, "redirect.json");
 createPrivateFile(redirectPath, JSON.stringify({ version: 1, port: redirect.port, token }));
 await assert.rejects(callDesktop(redirectPath, "open", { url: "https://example.test" }));
 assert.equal(proxyRequests, 0);
 console.log("desktop credentials bypass proxy and redirects");
} finally {
 await proxy.stop(true); await endpoint.stop(true); await redirect.stop(true);
 await rm(root, { recursive: true, force: true });
}
