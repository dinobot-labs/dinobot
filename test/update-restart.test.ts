import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { restartDaemonAfterUpdate, type DaemonRestartDependencies } from "../src/cli/update-restart.ts";
import { detectSupervisor, successorArgv } from "../src/core/daemon-restart.ts";

type Route = (init?: RequestInit) => Response | Promise<Response>;

function harness(files: Record<string, string>, routes: { info: Route[]; restart?: Route }) {
	const canonicalFiles = Object.fromEntries(Object.entries(files).map(([path, body]) => [resolve(path), body]));
	const logs: string[] = [];
	const errors: string[] = [];
	const requests: { path: string; body?: unknown }[] = [];
	let clock = 0;
	let infoCalls = 0;
	const deps: DaemonRestartDependencies = {
		env: {}, cwd: "/work", home: "/home/u",
		readFile: async (path) => {
			if (resolve(path) in canonicalFiles) return canonicalFiles[resolve(path)]!;
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		},
		fetch: (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			requests.push({ path: url.pathname, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
			if (url.pathname === "/v1/daemon") {
				const route = routes.info[Math.min(infoCalls++, routes.info.length - 1)]!;
				return route(init);
			}
			if (url.pathname === "/v1/daemon/restart" && routes.restart) return routes.restart(init);
			throw new Error("unexpected " + url.pathname);
		}) as typeof fetch,
		sleep: async (ms) => { clock += ms; },
		now: () => clock,
		log: (message) => logs.push(message),
		error: (message) => errors.push(message),
		comebackMs: 5_000,
	};
	return { deps, logs, errors, requests };
}

const manifest = (port = 8786) => "bot:\n  dataDir: /data\napi:\n  port: " + port + "\n";
const DEFAULT = "/home/u/.config/dinobot/dinobot.yaml";
const info = (pid: number, version: string, busy: string[] = []) => () => Response.json({ pid, version, busy, owner: "external" });
const refused = () => { throw new TypeError("fetch failed: ECONNREFUSED"); };

describe("restartDaemonAfterUpdate", () => {
	test("restarts the daemon of the default manifest and waits for the new version", async () => {
		const h = harness({ [DEFAULT]: manifest() }, {
			info: [info(10, "1.0.0", ["slack:C1"]), refused, info(10, "1.0.0"), info(11, "1.1.0")],
			restart: () => Response.json({ status: "restarting", successorPid: 11, busy: ["slack:C1"] }, { status: 202 }),
		});
		expect(await restartDaemonAfterUpdate("1.1.0", h.deps)).toBe(0);
		expect(h.requests.find((r) => r.path === "/v1/daemon/restart")).toEqual({ path: "/v1/daemon/restart", body: { pid: 10 } });
		expect(h.logs.join("\n")).toContain("1.0.0 → 1.1.0");
		expect(h.logs.join("\n")).toContain("interrupting work in slack:C1");
		expect(h.logs.at(-1)).toBe("Daemon restarted on dinobot 1.1.0 (pid 11).");
		expect(h.errors).toEqual([]);
	});

	test("--config, $DINOBOT_CONFIG and ./dinobot.yaml select the manifest in that order", async () => {
		for (const [config, env, expected] of [
			["custom.yaml", { DINOBOT_CONFIG: "/env.yaml" }, "/work/custom.yaml"],
			[undefined, { DINOBOT_CONFIG: "/env.yaml" }, "/env.yaml"],
			[undefined, {}, "/work/dinobot.yaml"],
		] as const) {
			const h = harness({ [expected]: manifest(9000), [DEFAULT]: manifest(1) }, { info: [info(1, "2.0.0")] });
			h.deps.env = env;
			if (config) h.deps.config = config;
			let port = "";
			const fetcher = h.deps.fetch;
			h.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => { port = new URL(String(input)).port; return fetcher(input, init); }) as typeof fetch;
			expect(await restartDaemonAfterUpdate("2.0.0", h.deps)).toBe(0);
			expect(port).toBe("9000");
		}
	});

	test("nothing to do: no manifest, no api port, no daemon, or the daemon already runs the target", async () => {
		const none = harness({}, { info: [] });
		expect(await restartDaemonAfterUpdate("1.1.0", none.deps)).toBe(0);
		expect(none.requests).toEqual([]);
		expect(none.logs[0]).toContain("no daemon to restart");

		const noApi = harness({ [DEFAULT]: "bot:\n  dataDir: /data\n" }, { info: [] });
		expect(await restartDaemonAfterUpdate("1.1.0", noApi.deps)).toBe(0);
		expect(noApi.requests).toEqual([]);
		expect(noApi.logs[0]).toContain("no api.port");

		const down = harness({ [DEFAULT]: manifest() }, { info: [refused] });
		expect(await restartDaemonAfterUpdate("1.1.0", down.deps)).toBe(0);
		expect(down.logs[0]).toContain("nothing to restart");

		const current = harness({ [DEFAULT]: manifest() }, { info: [info(10, "1.1.0")] });
		expect(await restartDaemonAfterUpdate("1.1.0", current.deps)).toBe(0);
		expect(current.requests.map((r) => r.path)).toEqual(["/v1/daemon"]);
		for (const h of [none, noApi, down, current]) expect(h.errors).toEqual([]);
	});

	test("older daemons without the routes get manual guidance and are never stopped", async () => {
		const noInfo = harness({ [DEFAULT]: manifest() }, { info: [() => new Response("{}", { status: 404 })] });
		expect(await restartDaemonAfterUpdate("1.1.0", noInfo.deps)).toBe(0);
		expect(noInfo.requests.map((r) => r.path)).toEqual(["/v1/daemon"]);
		expect(noInfo.logs[0]).toContain("predates automatic restart");

		const noRestart = harness({ [DEFAULT]: manifest() }, { info: [info(10, "1.0.0")], restart: () => new Response("{}", { status: 404 }) });
		expect(await restartDaemonAfterUpdate("1.1.0", noRestart.deps)).toBe(0);
		expect(noRestart.logs.at(-1)).toContain("predates automatic restart");
	});

	test("a supervised daemon names the manager command instead of racing it", async () => {
		const h = harness({ [DEFAULT]: manifest() }, {
			info: [info(10, "1.0.0")],
			restart: () => Response.json({ status: "refused", error: "supervised", supervisor: { kind: "systemd", unit: "dinobot.service" } }, { status: 409 }),
		});
		expect(await restartDaemonAfterUpdate("1.1.0", h.deps)).toBe(0);
		expect(h.logs.at(-1)).toContain("systemctl --user restart dinobot.service");
	});

	test("a successor that cannot start leaves the old daemon running and fails", async () => {
		const h = harness({ [DEFAULT]: manifest() }, {
			info: [info(10, "1.0.0")],
			restart: () => Response.json({ status: "failed", error: "successor", detail: "the new daemon exited (code 1) before it was ready; see the daemon log" }, { status: 500 }),
		});
		expect(await restartDaemonAfterUpdate("1.1.0", h.deps)).toBe(1);
		expect(h.errors[0]).toContain("exited (code 1)");
		expect(h.errors[0]).toContain("old daemon keeps running 1.0.0");
	});

	test("a daemon that does not come back, or comes back on another version, fails", async () => {
		const restarting = () => Response.json({ status: "restarting", successorPid: 11, busy: [] }, { status: 202 });
		const never = harness({ [DEFAULT]: manifest() }, { info: [info(10, "1.0.0"), refused], restart: restarting });
		expect(await restartDaemonAfterUpdate("1.1.0", never.deps)).toBe(1);
		expect(never.errors[0]).toContain("did not answer");

		const wrong = harness({ [DEFAULT]: manifest() }, { info: [info(10, "1.0.0"), info(11, "1.0.0")], restart: restarting });
		expect(await restartDaemonAfterUpdate("1.1.0", wrong.deps)).toBe(1);
		expect(wrong.errors[0]).toContain("runs 1.0.0, not 1.1.0");
	});

	test("a lost restart request is reported as a failure", async () => {
		const h = harness({ [DEFAULT]: manifest() }, { info: [info(10, "1.0.0")], restart: refused });
		expect(await restartDaemonAfterUpdate("1.1.0", h.deps)).toBe(1);
		expect(h.errors[0]).toContain("Could not ask the daemon to restart");
	});
});

describe("detectSupervisor", () => {
	const linux = (path: string, mainPid?: number) => {
		const queries: [string, boolean][] = [];
		return { queries, probe: { env: {}, pid: 50, ppid: 1, platform: "linux" as const, readCgroup: () => "0::" + path + "\n", mainPid: (unit: string, user: boolean) => { queries.push([unit, user]); return mainPid; } } };
	};
	test("the main process of a systemd service, a launchd job and container init are supervised", () => {
		const user = linux("/user.slice/user-1000.slice/user@1000.service/app.slice/dinobot.service", 50);
		expect(detectSupervisor(user.probe)).toEqual({ kind: "systemd", unit: "dinobot.service" });
		expect(user.queries).toEqual([["dinobot.service", true]]);
		const system = linux("/system.slice/dinobot.service", 50);
		expect(detectSupervisor(system.probe)).toEqual({ kind: "systemd", unit: "dinobot.service" });
		expect(system.queries).toEqual([["dinobot.service", false]]);
		// Unknown MainPID is conservatively supervised.
		expect(detectSupervisor(linux("/system.slice/dinobot.service").probe)).toEqual({ kind: "systemd", unit: "dinobot.service" });
		expect(detectSupervisor({ env: { XPC_SERVICE_NAME: "com.example.dinobot" }, pid: 50, ppid: 1, platform: "darwin" })).toEqual({ kind: "launchd", unit: "com.example.dinobot" });
		expect(detectSupervisor({ env: {}, pid: 1, platform: "linux", readCgroup: () => "0::/\n" })).toEqual({ kind: "container" });
	});
	test("terminals, nohup, processes started inside another service and GUI-launched shells are not", () => {
		expect(detectSupervisor(linux("/user.slice/user-1000.slice/user@1000.service/app.slice/vte-spawn-1.scope").probe)).toBeUndefined();
		expect(detectSupervisor(linux("/user.slice/user-1000.slice/session-2.scope").probe)).toBeUndefined();
		// e.g. a CI job or a tool run by another service: same cgroup, different main process.
		expect(detectSupervisor(linux("/system.slice/actions.runner.service", 7).probe)).toBeUndefined();
		expect(detectSupervisor({ env: {}, pid: 50, platform: "linux", readCgroup: () => { throw new Error("no /proc"); } })).toBeUndefined();
		for (const xpc of [undefined, "0", "application.com.apple.Terminal.1234"]) {
			expect(detectSupervisor({ env: xpc === undefined ? {} : { XPC_SERVICE_NAME: xpc }, pid: 50, ppid: 1, platform: "darwin" })).toBeUndefined();
		}
		// A launchd label inherited by a process whose parent is not launchd.
		expect(detectSupervisor({ env: { XPC_SERVICE_NAME: "com.example.dinobot" }, pid: 50, ppid: 49, platform: "darwin" })).toBeUndefined();
	});
});

describe("successorArgv", () => {
	test("reruns the same program and arguments, making the default serve command explicit", () => {
		expect(successorArgv("/bin/bun", "/g/dinobot/main.js", ["/bin/bun", "/home/.bun/bin/dinobot", "serve", "--config", "a.yaml"], "serve"))
			.toEqual(["/bin/bun", "/home/.bun/bin/dinobot", "serve", "--config", "a.yaml"]);
		expect(successorArgv("/bin/bun", "/g/dinobot/main.js", ["/bin/bun", "/home/.bun/bin/dinobot", "--config", "a.yaml"], undefined))
			.toEqual(["/bin/bun", "/home/.bun/bin/dinobot", "serve", "--config", "a.yaml"]);
		expect(successorArgv("/usr/local/bin/dinobot", "/$bunfs/root/dinobot", ["/usr/local/bin/dinobot", "/$bunfs/root/dinobot", "serve"], "serve"))
			.toEqual(["/usr/local/bin/dinobot", "serve"]);
	});
});
