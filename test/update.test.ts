import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import {
	CURRENT_VERSION, checkForUpdate, defaultUpdateCachePath, detectUpdateManager,
	isNewerStableVersion, runUpdateCommand, runUpdateWithDependencies,
	type CheckForUpdateOptions, type RunUpdateDependencies, type UpdateCommand,
} from "../src/update.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const dirs: string[] = [];
let inheritedOptOut: string | undefined;
beforeEach(() => {
	inheritedOptOut = process.env.DINOBOT_NO_UPDATE_CHECK;
	delete process.env.DINOBOT_NO_UPDATE_CHECK; // Tests inject every fetch; exercise checks even when CI opts out.
});
afterEach(async () => {
	if (inheritedOptOut === undefined) delete process.env.DINOBOT_NO_UPDATE_CHECK;
	else process.env.DINOBOT_NO_UPDATE_CHECK = inheritedOptOut;
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function temporary(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-update-"));
	dirs.push(dir);
	return dir;
}
const fetcher = (fn: (input: string | URL | Request, init?: RequestInit) => Promise<Response>) => fn as typeof fetch;
const metadataFetch = (version = "1.2.4", name = "dinobot") => fetcher(async () => Response.json({ name, version }));
async function passive(): Promise<CheckForUpdateOptions> {
	return { cachePath: join(await temporary(), "update.json"), now: () => NOW, currentVersion: "1.2.3", fetch: metadataFetch() };
}
async function seed(options: CheckForUpdateOptions, latest = "1.2.4", checkedAt = NOW): Promise<void> {
	await writeFile(options.cachePath!, JSON.stringify({ schemaVersion: 1, latest, checkedAt }));
}

// Every fetch and manager command is injected. No test contacts a registry or installs anything.
test("CURRENT_VERSION is the release-compatible package version", () => {
	expect(CURRENT_VERSION).toBe(packageJson.version);
});

for (const [current, latest, newer] of [
	["0.0.0", "0.0.1", true], ["1.2.9", "1.2.10", true], ["1.9.9", "1.10.0", true],
	["9.99.99", "10.0.0", true], ["2.0.0", "1.99.99", false], ["1.2.3", "1.2.3", false],
	["1.2.3+local", "1.2.3+other", false], ["1.2.3-rc.1", "1.2.3", true],
	["1.2.3-0.01a+build.00", "1.2.3+build.01", true], ["1.3.0-rc.1", "1.2.99", false],
	["1.2.3", "1.2.4+sha.0", true], ["9007199254740992.0.0", "9007199254740993.0.0", true],
	["1.2.3-01", "1.2.4", false], ["1.2.3-", "1.2.4", false], ["v1.2.3", "1.2.4", false],
] as const) test("version precedence " + current + " → " + latest, () => {
	expect(isNewerStableVersion(current, latest)).toBe(newer);
});

const invalidVersions: unknown[] = [null, 12, {}, "", "latest", "v2.0.0", "=2.0.0", "2", "2.0", "02.0.0", "2.00.0", "2.0.00", "2.0.0-rc.1", "2.0.0-01", "2.0.0+", "2.0.0+bad..id", "2.0.0 ", " 2.0.0", "2.0.0\n", "2.0.0; touch /tmp/oops", "2.0.0+$(oops)"];
test("invalid or prerelease latest versions never notify or enter the cache", async () => {
	const options = await passive();
	for (const version of invalidVersions) {
		const fetch = fetcher(async () => Response.json({ name: "dinobot", version }));
		expect(await checkForUpdate({ ...options, force: true, fetch })).toBeNull();
	}
	await expect(readFile(options.cachePath!)).rejects.toThrow();
});

test("passive check uses the fixed registry, disallows redirects and returns an update", async () => {
	const options = await passive();
	let calls = 0;
	const fetch = fetcher(async (url, init) => {
		calls++;
		expect(url).toBe("https://registry.npmjs.org/dinobot/latest");
		expect(init?.redirect).toBe("error");
		expect(init?.signal).toBeInstanceOf(AbortSignal);
		return Response.json({ name: "dinobot", version: "1.2.4" });
	});
	expect(await checkForUpdate({ ...options, fetch })).toEqual({ current: "1.2.3", latest: "1.2.4" });
	expect(calls).toBe(1);
});

test("bad metadata, HTTP errors, redirects, malformed JSON and offline checks are silent", async () => {
	const options = await passive();
	const redirected = Response.json({ name: "dinobot", version: "9.0.0" });
	Object.defineProperty(redirected, "redirected", { value: true });
	const failures = [
		metadataFetch("2.0.0", "other"),
		...[null, [], {}, { version: "2.0.0" }].map((body) => fetcher(async () => Response.json(body))),
		fetcher(async () => new Response("bad JSON")),
		fetcher(async () => new Response("no", { status: 500 })),
		fetcher(async () => new Response(null, { status: 302, headers: { location: "https://example.invalid" } })),
		fetcher(async () => redirected),
		fetcher(async () => { throw new Error("offline"); }),
	];
	for (const fetch of failures) expect(await checkForUpdate({ ...options, fetch })).toBeNull();
	await expect(readFile(options.cachePath!)).rejects.toThrow();
});

test("pre-abort skips fetching; in-flight abort settles even when fetch ignores its signal", async () => {
	const options = await passive();
	const pre = new AbortController();
	pre.abort();
	let calls = 0;
	expect(await checkForUpdate({ ...options, signal: pre.signal, fetch: fetcher(async () => { calls++; throw new Error(); }) })).toBeNull();
	expect(calls).toBe(0);
	const controller = new AbortController();
	let requestSignal: AbortSignal | null | undefined;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => { started = resolve; });
	const pending = checkForUpdate({ ...options, signal: controller.signal, fetch: fetcher(async (_, init) => {
		requestSignal = init?.signal;
		started();
		return new Promise<Response>(() => {});
	}) });
	await ready;
	controller.abort();
	expect(await pending).toBeNull();
	expect(requestSignal?.aborted).toBe(true);
	await expect(readFile(options.cachePath!)).rejects.toThrow();
});

test("five-second deadline covers hanging fetch and body and is an explicit-command failure", async () => {
	const options = await passive();
	const fixture = await installation("npm");
	const signals: AbortSignal[] = [];
	const hangingFetch = fetcher(async (_, init) => {
		signals.push(init!.signal!);
		return new Promise<Response>(() => {});
	});
	const hangingBody = fetcher(async (_, init) => {
		signals.push(init!.signal!);
		const response = Response.json({});
		Object.defineProperty(response, "json", { value: () => new Promise(() => {}) });
		return response;
	});
	const start = performance.now();
	const results = await Promise.all([
		checkForUpdate({ ...options, force: true, fetch: hangingFetch }),
		checkForUpdate({ ...options, force: true, fetch: hangingBody }),
		runUpdateWithDependencies({ ...fixture.deps, fetch: hangingFetch }),
	]);
	expect(results).toEqual([null, null, 1]);
	expect(performance.now() - start).toBeLessThan(6_500);
	expect(signals).toHaveLength(3);
	expect(signals.every((signal) => signal.aborted)).toBe(true);
	expect(fixture.calls).toHaveLength(0);
	expect(fixture.errors.join(" ")).toContain("failed");
}, 10_000);

test("fresh cache suppresses fetches, including current or newer running versions", async () => {
	const options = await passive();
	await seed(options, "1.2.4", NOW - DAY + 1);
	let calls = 0;
	const fetch = fetcher(async () => { calls++; throw new Error("must not fetch"); });
	expect(await checkForUpdate({ ...options, fetch })).toEqual({ current: "1.2.3", latest: "1.2.4" });
	expect(await checkForUpdate({ ...options, fetch, currentVersion: "1.2.4+local" })).toBeNull();
	expect(await checkForUpdate({ ...options, fetch, currentVersion: "2.0.0" })).toBeNull();
	expect(calls).toBe(0);
});

test("successful current-version checks are cached too; force bypasses a fresh cache", async () => {
	const options = await passive();
	expect(await checkForUpdate({ ...options, fetch: metadataFetch("1.2.3") })).toBeNull();
	expect(JSON.parse(await readFile(options.cachePath!, "utf8"))).toEqual({ schemaVersion: 1, latest: "1.2.3", checkedAt: NOW });
	expect(await checkForUpdate(options)).toBeNull();
	expect(await checkForUpdate({ ...options, force: true })).toEqual({ current: "1.2.3", latest: "1.2.4" });
});

test("stale, corrupt, invalid-schema and future cache records require a successful fresh check", async () => {
	const options = await passive();
	const records = [
		"broken", "null", "[]", "{}",
		JSON.stringify({ schemaVersion: 2, latest: "9.0.0", checkedAt: NOW }),
		...[NOW - DAY, NOW - DAY - 1, NOW + 1, -1, "today", null, 1.5].map((checkedAt) => JSON.stringify({ schemaVersion: 1, latest: "9.0.0", checkedAt })),
		...["v9.0.0", "9.0.0-rc.1", 9].map((latest) => JSON.stringify({ schemaVersion: 1, latest, checkedAt: NOW })),
	];
	for (const record of records) {
		await writeFile(options.cachePath!, record);
		expect(await checkForUpdate(options)).toEqual({ current: "1.2.3", latest: "1.2.4" });
		expect(JSON.parse(await readFile(options.cachePath!, "utf8")).latest).toBe("1.2.4");
	}
	await seed(options, "9.0.0", NOW - DAY);
	expect(await checkForUpdate({ ...options, fetch: fetcher(async () => { throw new Error("offline"); }) })).toBeNull();
	expect(JSON.parse(await readFile(options.cachePath!, "utf8")).latest).toBe("9.0.0");
});

test("unreadable/unwritable cache never loses a valid update, and nested cache directories are created", async () => {
	const options = await passive();
	const blockingFile = join(await temporary(), "not-a-directory");
	await writeFile(blockingFile, "blocked");
	for (const cachePath of [join(blockingFile, "update.json"), await temporary(), join(await temporary(), "nested", "update.json")]) {
		expect(await checkForUpdate({ ...options, cachePath })).toEqual({ current: "1.2.3", latest: "1.2.4" });
	}
});

test("cache location honors absolute XDG_CACHE_HOME and otherwise uses ~/.cache", () => {
	expect(defaultUpdateCachePath({ XDG_CACHE_HOME: "/cache" }, "/home/test")).toBe("/cache/dinobot/update.json");
	for (const env of [{}, { XDG_CACHE_HOME: "" }, { XDG_CACHE_HOME: "relative" }])
		expect(defaultUpdateCachePath(env, "/home/test")).toBe("/home/test/.cache/dinobot/update.json");
});

test("opt-out skips even forced passive checks but not explicit updates", async () => {
	const previous = process.env.DINOBOT_NO_UPDATE_CHECK;
	try {
		process.env.DINOBOT_NO_UPDATE_CHECK = "1";
		const options = await passive();
		let calls = 0;
		expect(await checkForUpdate({ ...options, force: true, fetch: fetcher(async () => { calls++; throw new Error(); }) })).toBeNull();
		expect(calls).toBe(0);
		const fixture = await installation("bun");
		expect(await runUpdateWithDependencies(fixture.deps)).toBe(0);
		expect(fixture.calls.filter((call) => call.options.stdio === "inherit")).toHaveLength(1);
	} finally {
		if (previous === undefined) delete process.env.DINOBOT_NO_UPDATE_CHECK;
		else process.env.DINOBOT_NO_UPDATE_CHECK = previous;
	}
});

test("bad current version or clock is best effort and never reaches the network", async () => {
	const options = await passive();
	let calls = 0;
	const fetch = fetcher(async () => { calls++; throw new Error(); });
	for (const currentVersion of ["v1.0.0", "1.0", "1.0.0-01", "1.0.0\n"])
		expect(await checkForUpdate({ ...options, fetch, currentVersion })).toBeNull();
	for (const now of [() => NaN, () => Infinity, () => -1, () => { throw new Error(); }])
		expect(await checkForUpdate({ ...options, fetch, now })).toBeNull();
	expect(calls).toBe(0);
});

async function installation(manager: "bun" | "npm", bunLayout: "default" | "install" | "global" | "xdg" = "default") {
	const home = await temporary();
	const env: NodeJS.ProcessEnv = {};
	const xdgCache = join(home, "xdg cache");
	const bunInstall = bunLayout === "install" ? join(home, "custom bun") : bunLayout === "xdg" ? join(xdgCache, ".bun") : join(home, ".bun");
	const bunGlobal = bunLayout === "global" ? join(home, "custom global") : join(bunInstall, "install", "global");
	if (bunLayout === "install") env.BUN_INSTALL = bunInstall;
	if (bunLayout === "global") env.BUN_INSTALL_GLOBAL_DIR = bunGlobal;
	if (bunLayout === "xdg") env.XDG_CACHE_HOME = xdgCache;
	const roots = { bun: join(bunGlobal, "node_modules"), npm: join(home, "npm", "lib", "node_modules") };
	for (const root of Object.values(roots)) {
		await mkdir(join(root, "dinobot"), { recursive: true });
		await writeFile(join(root, "dinobot", "main.js"), "// fixture, never executed\n");
		await writeFile(join(root, "dinobot", "package.json"), JSON.stringify({ name: "dinobot", version: "1.2.3", bin: { dinobot: "main.js" } }));
	}
	const bin = join(bunInstall, "bin");
	await mkdir(bin, { recursive: true });
	await symlink(join(roots.bun, "dinobot", "main.js"), join(bin, "dinobot"));
	const controls = { installExit: 0, installThrows: false, installNoop: false, bunQueryExit: 0, npmQueryExit: 0, bunBin: bin, npmRoot: roots.npm };
	const calls: { argv: string[]; options: Parameters<UpdateCommand>[1] }[] = [];
	const logs: string[] = [];
	const errors: string[] = [];
	const command: UpdateCommand = async (argv, options) => {
		calls.push({ argv, options });
		if (options.stdio === "pipe") {
			if (argv.join(" ") === "bun pm bin -g") return { exitCode: controls.bunQueryExit, stdout: controls.bunBin + "\n" };
			if (argv.join(" ") === "npm root -g") return { exitCode: controls.npmQueryExit, stdout: controls.npmRoot + "\n" };
			throw new Error("Unexpected probe");
		}
		if (controls.installThrows) throw new Error("spawn EACCES");
		if (!controls.installNoop && controls.installExit === 0) {
			const pkgPath = join(roots[argv[0] as "bun" | "npm"], "dinobot", "package.json");
			const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
			await writeFile(pkgPath, JSON.stringify({ ...pkg, version: argv.at(-1)!.slice("dinobot@".length) }));
		}
		return { exitCode: controls.installExit, stdout: "" };
	};
	const deps: RunUpdateDependencies = {
		main: join(roots[manager], "dinobot", "main.js"), home, env, command, realpath,
		readFile: (path) => readFile(path, "utf8"), currentVersion: "1.2.3", fetch: metadataFetch(),
		log: (message) => logs.push(message), error: (message) => errors.push(message),
	};
	return { deps, controls, calls, logs, errors, roots, bin };
}

for (const manager of ["bun", "npm"] as const) test("canonical " + manager + " global install wins even when both managers are installed", async () => {
	const fixture = await installation(manager);
	const launcher = join(fixture.deps.home, "launcher");
	await symlink(fixture.deps.main, launcher);
	expect(await detectUpdateManager({ ...fixture.deps, main: launcher })).toBe(manager);
	expect(fixture.calls.every((call) => call.options.stdio === "pipe" && call.options.cwd === fixture.deps.home)).toBe(true);
});

for (const layout of ["install", "global"] as const) test("Bun documented custom " + layout + " root is recognized", async () => {
	const fixture = await installation("bun", layout);
	expect(await detectUpdateManager(fixture.deps)).toBe("bun");
});

// Bun 1.4 resolves its global root as BUN_INSTALL_GLOBAL_DIR, else $BUN_INSTALL/install/global, else
// $XDG_CACHE_HOME/.bun/install/global, else ~/.bun/install/global (observed with `bun pm ls -g`).
test("an XDG_CACHE_HOME Bun root is recognized and updated, following Bun's own precedence", async () => {
	const xdg = await installation("bun", "xdg");
	expect(await detectUpdateManager(xdg.deps)).toBe("bun");
	expect(await runUpdateWithDependencies(xdg.deps)).toBe(0);
	expect(xdg.calls.filter((call) => call.options.stdio === "inherit").map((call) => call.argv)).toEqual([["bun", "add", "-g", "dinobot@1.2.4"]]);
	expect(xdg.errors).toEqual([]);
	// BUN_INSTALL outranks XDG_CACHE_HOME, so the XDG root is not where `bun add -g` writes then.
	expect(await detectUpdateManager({ ...xdg.deps, env: { ...xdg.deps.env, BUN_INSTALL: join(xdg.deps.home, "other bun") } })).toBeNull();
	// A relative XDG_CACHE_HOME never names this root (Bun itself fails on it).
	expect(await detectUpdateManager({ ...xdg.deps, env: { XDG_CACHE_HOME: "xdg cache" } })).toBeNull();
	// With XDG_CACHE_HOME set, a ~/.bun install is not Bun's root: refuse instead of installing a shadowing copy.
	const home = await installation("bun");
	expect(await detectUpdateManager({ ...home.deps, env: { XDG_CACHE_HOME: join(home.deps.home, "xdg cache") } })).toBeNull();
	// An explicit BUN_INSTALL still wins over XDG_CACHE_HOME.
	const custom = await installation("bun", "install");
	expect(await detectUpdateManager({ ...custom.deps, env: { ...custom.deps.env, XDG_CACHE_HOME: join(custom.deps.home, "xdg cache") } })).toBe("bun");
});

test("Bun config overrides cannot redirect a verified default installation or turn updates into dry runs", async () => {
	for (const location of ["home-global", "xdg-global", "home-local", "global-local"] as const) {
		const fixture = await installation("bun");
		const xdg = join(fixture.deps.home, "xdg");
		fixture.deps.env.XDG_CONFIG_HOME = xdg;
		const config = location === "home-global" ? join(fixture.deps.home, ".bunfig.toml")
			: location === "xdg-global" ? join(xdg, ".bunfig.toml")
			: location === "home-local" ? join(fixture.deps.home, "bunfig.toml") : join(dirname(fixture.roots.bun), "bunfig.toml");
		await mkdir(dirname(config), { recursive: true });
		for (const content of [
			"[install]\nglobalDir = " + JSON.stringify(join(fixture.deps.home, "other-root")),
			"[install]\ndryRun = true",
			"[broken TOML",
		]) {
			await writeFile(config, content);
			expect(await detectUpdateManager(fixture.deps)).toBeNull();
			expect(await runUpdateWithDependencies(fixture.deps)).toBe(1);
			expect(fixture.calls.some(call => call.options.stdio === "inherit")).toBe(false);
		}
		await writeFile(config, "[install]\nexact = true");
		expect(await detectUpdateManager(fixture.deps)).toBe("bun");
	}
});

test("source, local npm, temporary bunx, unknown, compiled and linked packages are refused", async () => {
	const fixture = await installation("bun");
	for (const suffix of ["src/main.ts", "project/node_modules/dinobot/main.js", "tmp/bunx-123/node_modules/dinobot/main.js", "unknown/main.js", "global/node_modules/dinobot-extra/main.js"]) {
		const main = join(fixture.deps.home, suffix);
		await mkdir(dirname(main), { recursive: true });
		await writeFile(main, "fixture");
		expect(await detectUpdateManager({ ...fixture.deps, main })).toBeNull();
	}
	expect(await detectUpdateManager({ ...fixture.deps, main: "/$bunfs/root/main.ts" })).toBeNull();
	const linked = join(fixture.deps.home, "source-package");
	await mkdir(linked);
	await writeFile(join(linked, "main.js"), "source build");
	await rm(join(fixture.roots.bun, "dinobot"), { recursive: true });
	await symlink(linked, join(fixture.roots.bun, "dinobot"));
	expect(await detectUpdateManager(fixture.deps)).toBeNull();
});

test("root paths are canonicalized, but wrong metadata, bins, manager failures and ambiguity refuse ownership", async () => {
	const fixture = await installation("npm");
	const rootLink = join(fixture.deps.home, "root-link");
	await symlink(fixture.roots.npm, rootLink);
	fixture.controls.npmRoot = rootLink;
	expect(await detectUpdateManager(fixture.deps)).toBe("npm");
	fixture.controls.npmQueryExit = 2;
	expect(await detectUpdateManager(fixture.deps)).toBeNull();
	fixture.controls.npmQueryExit = 0;
	for (const output of ["relative/root", fixture.roots.npm + "\nwarning", ""]) {
		fixture.controls.npmRoot = output;
		expect(await detectUpdateManager(fixture.deps)).toBeNull();
	}
	fixture.controls.npmRoot = fixture.roots.npm;
	for (const pkg of [{ name: "other", bin: "main.js" }, { name: "dinobot", bin: "other.js" }, { name: "dinobot" }]) {
		await writeFile(join(fixture.roots.npm, "dinobot", "package.json"), JSON.stringify(pkg));
		expect(await detectUpdateManager(fixture.deps)).toBeNull();
	}
	const bun = await installation("bun");
	bun.controls.npmRoot = bun.roots.bun;
	expect(await detectUpdateManager(bun.deps)).toBeNull();
	bun.controls.npmQueryExit = 1;
	bun.controls.bunBin = join(bun.deps.home, "missing-bin");
	expect(await detectUpdateManager(bun.deps)).toBeNull();
});

for (const manager of ["bun", "npm"] as const) test(manager + " update installs only the checked pin with inherited stdio and does not restart services", async () => {
	const fixture = await installation(manager);
	let fetches = 0;
	fixture.deps.fetch = fetcher(async () => { fetches++; return Response.json({ name: "dinobot", version: "1.2.4+build.7" }); });
	expect(await runUpdateWithDependencies(fixture.deps)).toBe(0);
	expect(fetches).toBe(1);
	const installs = fixture.calls.filter((call) => call.options.stdio === "inherit");
	expect(installs).toEqual([{ argv: [manager, manager === "bun" ? "add" : "install", "-g", "dinobot@1.2.4+build.7"], options: { stdio: "inherit", cwd: fixture.deps.home } }]);
	expect(fixture.calls).toHaveLength(3);
	expect(fixture.errors).toEqual([]);
	expect(fixture.logs.join(" ")).toContain("Reopen the TUI");
	expect(fixture.logs.join(" ")).toContain("restart any running daemon when it is idle");
});

test("equal, build-equivalent and older registry versions are current without invoking a manager", async () => {
	const fixture = await installation("npm");
	for (const version of ["1.2.3", "1.2.3+other", "1.0.0"]) {
		expect(await runUpdateWithDependencies({ ...fixture.deps, fetch: metadataFetch(version) })).toBe(0);
	}
	expect(fixture.calls).toHaveLength(0);
	expect(fixture.errors).toEqual([]);
});

test("explicit offline/invalid checks return failure, never report current and never install", async () => {
	const fixture = await installation("npm");
	for (const fetch of [fetcher(async () => { throw new Error("offline"); }), metadataFetch("9.0.0-rc.1"), metadataFetch("9.0.0", "wrong"), fetcher(async () => new Response("{}", { status: 503 }))]) {
		expect(await runUpdateWithDependencies({ ...fixture.deps, fetch })).not.toBe(0);
	}
	expect(fixture.calls).toHaveLength(0);
	expect(fixture.logs.some((line) => line.includes("is current"))).toBe(false);
	expect(fixture.errors).toHaveLength(4);
});

test("unknown install gets manual guidance, not a shadowing global install", async () => {
	const fixture = await installation("bun");
	expect(await runUpdateWithDependencies({ ...fixture.deps, main: "/$bunfs/root/main.ts" })).toBe(1);
	expect(fixture.calls).toHaveLength(0);
	expect(fixture.errors.join(" ")).toContain("original install/build workflow");
	expect(fixture.errors.join(" ")).toContain("dinobot@1.2.4");
	expect(fixture.errors.join(" ")).toContain("shadows");
});

test("real subprocess adapter passes literal argv, captures probe output and preserves inherited-stdio exit status", async () => {
	const cwd = await temporary();
	const literal = "dinobot@1.2.4; echo NOT_A_SHELL";
	const result = await runUpdateCommand([process.execPath, "-e", "console.log(process.argv.at(-1)); process.exit(7)", literal], { stdio: "pipe", cwd });
	expect(result).toEqual({ exitCode: 7, stdout: literal + "\n" });
	expect(await runUpdateCommand([process.execPath, "-e", "process.exit(9)"], { stdio: "inherit", cwd })).toEqual({ exitCode: 9, stdout: "" });
});

test("a manager no-op is not reported as a successful update", async () => {
	const fixture = await installation("npm");
	fixture.controls.installNoop = true;
	expect(await runUpdateWithDependencies(fixture.deps)).toBe(1);
	expect(fixture.logs.some(line => line.startsWith("Updated to"))).toBe(false);
});

test("install nonzero exits propagate; spawn failures and signals fail without success instructions", async () => {
	const fixture = await installation("npm");
	fixture.controls.installExit = 23;
	expect(await runUpdateWithDependencies(fixture.deps)).toBe(23);
	fixture.controls.installExit = -1;
	expect(await runUpdateWithDependencies(fixture.deps)).toBe(1);
	fixture.controls.installThrows = true;
	expect(await runUpdateWithDependencies(fixture.deps)).toBe(1);
	expect(fixture.logs.some((line) => line.includes("Reopen") || line.includes("Updated to"))).toBe(false);
	expect(fixture.calls.filter((call) => call.options.stdio === "inherit")).toHaveLength(3);
	expect(fixture.errors).toHaveLength(3);
});

test("after a verified install the daemon is restarted onto exactly the installed version, and its status is the exit code", async () => {
	const fixture = await installation("npm");
	const targets: string[] = [];
	fixture.deps.restartDaemon = async (target) => { targets.push(target); return 1; };
	expect(await runUpdateWithDependencies(fixture.deps)).toBe(1);
	expect(targets).toEqual(["1.2.4"]);
	expect(fixture.logs.join(" ")).not.toContain("No daemon or service was stopped");
	fixture.deps.restartDaemon = async () => { throw new Error("boom"); };
	await writeFile(join(fixture.roots.npm, "dinobot", "package.json"), JSON.stringify({ name: "dinobot", version: "1.2.3", bin: { dinobot: "main.js" } }));
	expect(await runUpdateWithDependencies(fixture.deps)).toBe(1);
	expect(fixture.errors.at(-1)).toBe("Daemon restart failed: boom");
});

test("failed, refused and no-op installs never restart the daemon", async () => {
	const fixture = await installation("npm");
	let restarts = 0;
	fixture.deps.restartDaemon = async () => { restarts++; return 0; };
	fixture.controls.installExit = 23;
	expect(await runUpdateWithDependencies(fixture.deps)).toBe(23);
	fixture.controls.installExit = 0;
	fixture.controls.installNoop = true;
	expect(await runUpdateWithDependencies(fixture.deps)).toBe(1);
	expect(await runUpdateWithDependencies({ ...fixture.deps, main: "/$bunfs/root/main.ts" })).toBe(1);
	expect(await runUpdateWithDependencies({ ...fixture.deps, fetch: fetcher(async () => { throw new Error("offline"); }) })).toBe(1);
	expect(restarts).toBe(0);
});

test("when already current, a stale daemon is restarted only from a verified global install", async () => {
	const fixture = await installation("bun");
	const targets: string[] = [];
	fixture.deps.restartDaemon = async (target) => { targets.push(target); return 0; };
	expect(await runUpdateWithDependencies({ ...fixture.deps, fetch: metadataFetch("1.2.3") })).toBe(0);
	expect(targets).toEqual(["1.2.3"]);
	expect(await runUpdateWithDependencies({ ...fixture.deps, fetch: metadataFetch("1.2.3"), main: "/$bunfs/root/main.ts" })).toBe(0);
	expect(targets).toEqual(["1.2.3"]);
	expect(fixture.calls.filter((call) => call.options.stdio === "inherit")).toHaveLength(0);
});
