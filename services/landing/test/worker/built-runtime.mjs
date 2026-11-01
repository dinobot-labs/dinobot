/** Local-only post-build workerd acceptance; never connects to deployed D1. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { OutputWorkerSchema, InputConfigSchema, convertToWranglerConfig } from "@cloudflare/config";
const output = new URL("../../.cloudflare/output/v0/workers/default/", import.meta.url);
const config = JSON.parse(readFileSync(new URL("worker.config.json", output), "utf8"));
assert.deepEqual(config.limits, { cpuMs: 10 });
assert.deepEqual(config.observability, { enabled: true, headSamplingRate: 0.01, redactQueryString: true, logs: { enabled: true, invocationLogs: false }, traces: { enabled: false } });
assert.deepEqual(config.assets.runWorkerFirst, ["/api/*", "/"]);
assert.equal(config.env.DB.id, "6d10b251-9a75-435d-9eca-a9a10b53f070");
const { manifest, ...workerConfig } = OutputWorkerSchema.parse(config);
assert.equal(manifest.mainModule, "index.js");
const converted = convertToWranglerConfig(InputConfigSchema.parse({ worker: workerConfig }));
assert.deepEqual(converted.limits, { cpu_ms: 10 });
assert.equal(converted.observability.redact_query_string, true);
assert.equal(converted.observability.logs.invocation_logs, false);
const bundle = readFileSync(new URL("bundle/index.js", output), "utf8");
const probe = 'import worker from "./built.js"; export default { async fetch(request, env, ctx) { const response = await worker.fetch(request, env, ctx); const headers = new Headers(response.headers); headers.set("x-local-worker-executed", "yes"); return new Response(response.body, { status: response.status, headers }); } };';
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
 name: "local-restoration", compatibilityDate: config.compatibilityDate,
 modules: [{ type: "ESModule", path: "probe.js", contents: probe }, { type: "ESModule", path: "built.js", contents: bundle }],
 d1Databases: { DB: "local-restoration-only" },
 ratelimits: { RL_IP: { namespace_id: "7321", simple: { limit: 10, period: 60 } } },
 assets: { routerConfig: { has_user_worker: true }, directory: fileURLToPath(new URL("assets/", output)), binding: "ASSETS", run_worker_first: converted.assets.run_worker_first,
 assetConfig: { html_handling: converted.assets.html_handling, not_found_handling: converted.assets.not_found_handling } },
}] }));
const call = (path, init = {}) => mf.dispatchFetch("http://local.test" + path, { redirect: "manual", ...init });
try {
 for (const method of ["GET", "HEAD"]) {
  const ko = await call("/?campaign=x", { method, headers: { "accept-language": "ko" } });
  assert.equal(ko.status, 302); assert.equal(ko.headers.get("location"), "/ko/?campaign=x");
  assert.equal(ko.headers.get("x-local-worker-executed"), "yes"); await ko.text();
  const en = await call("/", { method, headers: { "accept-language": "ko", cookie: "lang=en" } });
  assert.equal(en.status, 200); assert.equal(en.headers.get("x-local-worker-executed"), "yes");
  const html = await en.text(); if (method === "HEAD") assert.equal(html, ""); else assert.ok(html.includes('id="download"'));
 }
 const bot = await call("/", { headers: { "accept-language": "ko", "user-agent": "Googlebot" } });
 assert.equal(bot.status, 200); await bot.text();
 for (const path of ["/ko/", "/privacy/", "/ko/privacy/", "/favicon.svg"]) {
  const response = await call(path); assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-local-worker-executed"), null);
  assert.ok(!response.headers.get("content-security-policy").includes("unsafe-inline")); await response.text();
 }
 const post = async (body, headers = {}) => call("/api/waitlist", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.7", ...headers }, body: JSON.stringify(body) });
 const valid = { email: "local-proof@example.com", consent: true, locale: "ko", elapsedMs: 5000, website: "" };
 const joined = await post(valid); assert.equal(joined.status, 201); assert.deepEqual(await joined.json(), { status: "joined", position: 1 });
 const duplicate = await post({ ...valid, email: "LOCAL-PROOF@example.com" }); assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), { status: "already" });
 const invalid = await post({ ...valid, email: "bad" }); assert.equal(invalid.status, 400); await invalid.text();
 const consent = await post({ ...valid, consent: false }); assert.equal(consent.status, 400); await consent.text();
 const honeypot = await post({ ...valid, email: "bot@example.com", website: "spam" }); assert.equal(honeypot.status, 201); await honeypot.text();
 const large = await post({ ...valid, padding: "x".repeat(4096) }); assert.equal(large.status, 413); await large.text();
 const db = await mf.getD1Database("DB");
 const stored = await db.prepare("SELECT email, locale, consent_version FROM waitlist").all();
 assert.deepEqual(stored.results, [{ email: valid.email, locale: "ko", consent_version: "waitlist-consent-v1" }]);
 for (let n = 0; n < 11; n++) {
  const response = await call("/api/health", { headers: { "cf-connecting-ip": "192.0.2.99" } });
  assert.equal(response.status, n < 10 ? 200 : 429); await response.text();
 }
 const head = await call("/api/waitlist", { method: "HEAD", headers: { "cf-connecting-ip": "192.0.2.100" } });
 assert.equal(head.status, 405); assert.equal(await head.text(), "");
 console.log("PASS built metadata, root locale/cookie/crawler routing, static assets, isolated D1 signup/duplicate/validation/bot/body cap, 10-per-minute limiter and HEAD");
} finally { await mf.dispose(); }
