/** Explicit post-build check; not included in bun test (requires built assets). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { OutputWorkerSchema, InputConfigSchema, convertToWranglerConfig } from "@cloudflare/config";

const output = new URL("../../.cloudflare/output/v0/workers/default/", import.meta.url);
const config = JSON.parse(readFileSync(new URL("worker.config.json", output), "utf8"));
assert.deepEqual(config.limits, { cpuMs: 10 });
assert.deepEqual(config.observability, { enabled: true, headSamplingRate: 0.01, redactQueryString: true, logs: { enabled: true, invocationLogs: false }, traces: { enabled: false } });
assert.deepEqual(config.assets.runWorkerFirst, ["/api/*"]);
assert.equal(config.env.DB.id, "6d10b251-9a75-435d-9eca-a9a10b53f070");
// Build output carries a bundle manifest, not an input setting. Validate output first,
// then convert the supported worker configuration (unchanged field values).
const { manifest, ...workerConfig } = OutputWorkerSchema.parse(config);
assert.equal(manifest.mainModule, "index.js");
const converted = convertToWranglerConfig(InputConfigSchema.parse({ worker: workerConfig }));
assert.deepEqual(converted.limits, { cpu_ms: 10 });
assert.deepEqual(converted.observability, { enabled: true, head_sampling_rate: 0.01, redact_query_string: true, logs: { enabled: true, invocation_logs: false }, traces: { enabled: false } });
assert.deepEqual(converted.assets.run_worker_first, ["/api/*"]);
console.log("BUILT_METADATA", JSON.stringify({ limits: converted.limits, observability: converted.observability, assets: converted.assets }));

const bundle = readFileSync(new URL("bundle/index.js", output), "utf8");
// An observational wrapper marks ONLY actual user-worker execution; asset-first bypasses it.
const probe = 'import worker from "./built.js"; export default { async fetch(request, env, ctx) { const response = await worker.fetch(request, env, ctx); const headers = new Headers(response.headers); headers.set("x-local-worker-executed", "yes"); return new Response(response.body, { status: response.status, headers }); } };';
const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
	name: "local-security",
	compatibilityDate: config.compatibilityDate,
	modules: [{ type: "ESModule", path: "probe.js", contents: probe }, { type: "ESModule", path: "built.js", contents: bundle }],
	assets: { routerConfig: { has_user_worker: true }, directory: fileURLToPath(new URL("assets/", output)), binding: "ASSETS", run_worker_first: converted.assets.run_worker_first,
		assetConfig: { html_handling: converted.assets.html_handling, not_found_handling: converted.assets.not_found_handling } },
}] }));
try {
	for (const path of ["/", "/ko/", "/privacy/", "/ko/privacy/", "/favicon.svg"]) {
		for (const method of ["GET", "HEAD"]) {
			const response = await mf.dispatchFetch("http://local.test" + path, { method, headers: { "accept-language": "ko", cookie: "lang=ko" } });
			assert.equal(response.status, 200, path);
			assert.equal(response.headers.get("x-local-worker-executed"), null, "asset-first " + path);
			assert.equal(response.headers.get("x-content-type-options"), "nosniff");
			const csp = response.headers.get("content-security-policy");
			assert.ok(csp?.includes("script-src 'self'"));
			assert.ok(!csp.includes("unsafe-inline"));
			const text = await response.text();
			if (method === "HEAD") assert.equal(text, "");
			console.log("ASSET_FIRST", method, path, response.status);
		}
	}
	for (const method of ["GET", "HEAD", "POST", "OPTIONS", "PATCH"]) {
		const response = await mf.dispatchFetch("http://local.test/api/waitlist?private=not-reflected", { method });
		assert.equal(response.status, 410, await response.clone().text());
		assert.equal(response.headers.get("x-local-worker-executed"), "yes");
		assert.equal(await response.text(), method === "HEAD" ? "" : '{"error":"gone"}');
		console.log("RETIRED", method, response.status);
	}
	for (const path of ["/api/health", "/api/unknown", "/missing-page?secret=x"]) {
		const response = await mf.dispatchFetch("http://local.test" + path);
		assert.equal(response.status, path === "/api/health" ? 200 : 404);
		console.log("ROUTE", path, response.status, "worker=" + response.headers.get("x-local-worker-executed"));
		await response.text();
	}
	console.log("PASS built config conversion and real workerd asset routing; no DB or limiter bound");
} finally { await mf.dispose(); }
