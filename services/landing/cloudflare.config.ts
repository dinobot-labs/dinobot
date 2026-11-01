import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

// D1 `dinobot-waitlist` (APAC location hint, read replication disabled), created by the deploy node on 2026-10-11.
// Retained historical binding only: the retired API never reads or writes D1.
export default defineConfig({
	worker: {
		name: "www",
		compatibilityDate: "2026-10-06",
		entrypoint,
		workersDev: true,
		// Per-request technical bound, NOT a monthly spend cap.
		limits: { cpuMs: 10 },
		observability: { enabled: true, headSamplingRate: 0.01, redactQueryString: true, logs: { enabled: true, invocationLogs: false }, traces: { enabled: false } },
		assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "404-page", runWorkerFirst: ["/api/*"] },
		env: {
			ASSETS: bindings.assets(),
			DB: bindings.d1({ name: "dinobot-waitlist", id: "6d10b251-9a75-435d-9eca-a9a10b53f070" }),
			RL_IP: bindings.rateLimit({ namespace: "7321", simple: { limit: 10, period: 60 } }),
		},
	},
});
