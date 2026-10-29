import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type RestartDependencies, runRestart } from "../src/cli/restart.ts";

type Route = (init?: RequestInit) => Response | Promise<Response>;

function harness(port = 8786, force = false) {
	const logs: string[] = [];
	const errors: string[] = [];
	const requests: { path: string; body?: unknown }[] = [];
	let spawned = 0;
	let clock = 0;
	const deps: RestartDependencies = {
		port, dataDir: "/data", manifestPath: "/work/dinobot.yaml", force,
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			requests.push({ path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
			const route = routes[url.pathname]?.shift();
			if (!route) throw new Error("unexpected or exhausted " + url.pathname);
			return route(init);
		}) as typeof fetch,
		sleep: async (ms) => { clock += ms; },
		now: () => clock,
		log: (message) => logs.push(message),
		error: (message) => errors.push(message),
		spawn: async () => { spawned++; return { pid: 21 }; },
		logTail: async () => "tail line 1\ntail line 2",
	};
	const routes: Record<string, Route[]> = {};
	return { deps, logs, errors, requests, get spawned() { return spawned; }, routes };
}

const info = (pid: number, version = "1.2.3", busy: string[] = []) => () =>
	Response.json({ pid, version, busy, owner: "external" });
const refused = () => { throw Object.assign(new TypeError("fetch failed: ECONNREFUSED"), { code: "ECONNREFUSED" }); };

describe("runRestart", () => {
	for (const failure of ["503", "404", "malformed JSON", "timeout", "reset", "unknown", "message-only refusal"] as const) test("initial " + failure + " never spawns or requests restart", async () => {
		const h = harness();
		h.routes["/v1/daemon"] = [() => {
			if (failure === "timeout") throw new DOMException("Timed out", "TimeoutError");
			if (failure === "reset") throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
			if (failure === "unknown") throw new Error("offline");
			if (failure === "message-only refusal") throw new Error("ECONNREFUSED");
			return new Response("not JSON", { status: failure === "503" ? 503 : failure === "404" ? 404 : 200 });
		}, info(21)];
		expect(await runRestart(h.deps)).toBe(1);
		expect(h.spawned).toBe(0);
		expect(h.requests).toEqual([{ path: "/v1/daemon" }]);
		expect(h.errors.length).toBeGreaterThan(0);
	});

	for (const code of ["ECONNREFUSED", "ConnectionRefused"]) test("initial " + code + " starts exactly once", async () => {
		const h = harness();
		h.routes["/v1/daemon"] = [() => { throw Object.assign(new Error("refused"), { code }); }, info(21)];
		expect(await runRestart(h.deps)).toBe(0);
		expect(h.spawned).toBe(1);
		expect(h.errors).toEqual([]);
	});
	for (const status of [200, 404, 503]) test("real occupied HTTP port (" + status + ") never spawns", async () => {
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("not JSON", { status }) });
		try {
			const h = harness(server.port!);
			h.deps.fetch = globalThis.fetch;
			expect(await runRestart(h.deps)).toBe(1);
			expect(h.spawned).toBe(0);
		} finally { await server.stop(true); }
	});

	test("legacy restart 404 uses the guarded compatibility path", async () => {
		const h = harness();
		h.routes["/v1/daemon"] = [info(10)];
		h.routes["/v1/daemon/restart"] = [() => new Response("", { status: 404 })];
		let called = false;
		h.deps.legacyRestart = async (before) => { called = before.pid === 10; return 0; };
		expect(await runRestart(h.deps)).toBe(0);
		expect(called).toBe(true);
	});
	test("restarts the running daemon and waits for the new pid", async () => {
		const h = harness();
		h.routes["/v1/daemon"] = [info(10), info(10), info(11)];
		h.routes["/v1/daemon/restart"] = [() => Response.json({ status: "restarting", successorPid: 11, busy: [] }, { status: 202 })];
		expect(await runRestart(h.deps)).toBe(0);
		expect(h.requests.find((r) => r.path === "/v1/daemon/restart")).toEqual({ path: "/v1/daemon/restart", body: { pid: 10 } });
		expect(h.logs[0]).toBe("Restarting the daemon (pid 10)...");
		expect(h.logs.at(-1)).toBe("Daemon restarted (pid 11, dinobot 1.2.3).");
		expect(h.errors).toEqual([]);
		expect(h.spawned).toBe(0);
	});

	test("busy threads block the restart without --force and nothing is interrupted", async () => {
		const h = harness();
		h.routes["/v1/daemon"] = [info(10, "1.2.3", ["slack:C1", "tui:1"])];
		expect(await runRestart(h.deps)).toBe(1);
		expect(h.requests).toEqual([{ path: "/v1/daemon" }]);
		expect(h.errors.join("\n")).toContain("running work in slack:C1, tui:1");
		expect(h.errors.join("\n")).toContain("--force");
	});

	test("busy threads are interrupted with --force", async () => {
		const h = harness(8786, true);
		h.routes["/v1/daemon"] = [info(10, "1.2.3", ["slack:C1"]), info(11)];
		h.routes["/v1/daemon/restart"] = [() => Response.json({ status: "restarting", successorPid: 11, busy: ["slack:C1"] }, { status: 202 })];
		expect(await runRestart(h.deps)).toBe(0);
		expect(h.logs[0]).toBe("Restarting the daemon (pid 10); interrupting work in slack:C1...");
		expect(h.logs.at(-1)).toBe("Daemon restarted (pid 11, dinobot 1.2.3).");
	});

	test("no daemon running: starts one and waits for it to answer", async () => {
		const h = harness();
		h.routes["/v1/daemon"] = [refused, refused, info(21)];
		expect(await runRestart(h.deps)).toBe(0);
		expect(h.spawned).toBe(1);
		expect(h.logs[0]).toContain("No daemon is running on http://127.0.0.1:8786");
		expect(h.logs.at(-1)).toBe("Daemon started (pid 21, dinobot 1.2.3).");
	});

	test("no daemon running and the start fails: non-zero with the log and the report hint", async () => {
		const h = harness();
		h.routes["/v1/daemon"] = [refused];
		h.deps.comebackMs = h.deps.startMs = 300;
		expect(await runRestart(h.deps)).toBe(1);
		expect(h.spawned).toBe(1);
		const joined = h.errors.join("\n");
		expect(joined).toContain("did not come up");
		expect(joined).toContain(join(h.deps.dataDir, "dinobot.log"));
		expect(joined).toContain("tail line 2");
		expect(joined).toContain("dinobot report send");
	});

	test("a daemon that predates the restart API is refused with manual guidance", async () => {
		const h = harness();
		h.routes["/v1/daemon"] = [() => new Response("{}", { status: 404 })];
		expect(await runRestart(h.deps)).toBe(1);
		expect(h.errors[0]).toContain("predates the restart API");
		expect(h.errors[0]).toContain("dinobot serve");
	});

	test("a supervised daemon is refused with the manager's command", async () => {
		const h = harness();
		h.routes["/v1/daemon"] = [info(10)];
		h.routes["/v1/daemon/restart"] = [() => Response.json({ status: "refused", error: "supervised", supervisor: { kind: "systemd", unit: "dinobot.service" } }, { status: 409 })];
		expect(await runRestart(h.deps)).toBe(1);
		expect(h.errors[0]).toContain("managed by systemd");
		expect(h.errors[0]).toContain("systemctl --user restart dinobot.service");
	});

	test("a failed successor leaves the old daemon running", async () => {
		const h = harness();
		h.routes["/v1/daemon"] = [info(10)];
		h.routes["/v1/daemon/restart"] = [() => Response.json({ status: "failed", error: "successor", detail: "the new daemon exited (code 1)" }, { status: 500 })];
		expect(await runRestart(h.deps)).toBe(1);
		expect(h.errors[0]).toContain("could not start: the new daemon exited (code 1)");
		expect(h.errors[0]).toContain("The old daemon keeps running.");
	});

	test("a successor that never comes back fails after the deadline", async () => {
		const h = harness();
		h.routes["/v1/daemon"] = [info(10), info(10), info(10)];
		h.routes["/v1/daemon/restart"] = [() => Response.json({ status: "restarting", successorPid: 11, busy: [] }, { status: 202 })];
		h.deps.comebackMs = 300;
		expect(await runRestart(h.deps)).toBe(1);
		expect(h.errors[0]).toContain("pid 11) did not answer on http://127.0.0.1:8786");
		expect(h.errors[0]).toContain(join(h.deps.dataDir, "dinobot.log"));
	});

	test("a request that fails mid-restart reports the manual fallback", async () => {
		const h = harness();
		h.routes["/v1/daemon"] = [info(10)];
		h.routes["/v1/daemon/restart"] = [() => { throw new TypeError("fetch failed: ECONNRESET"); }];
		expect(await runRestart(h.deps)).toBe(1);
		expect(h.errors[0]).toContain("Could not ask the daemon to restart");
		expect(h.errors[0]).toContain("dinobot serve");
	});
});
