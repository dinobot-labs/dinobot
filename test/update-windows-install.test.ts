import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { detectUpdateManager, runUpdateWithDependencies, type UpdateCommand } from "../src/update.ts";

// Real Bun tarball installs, but all global paths and HOME are disposable. No daemon is launched.
test.skipIf(process.platform !== "win32")("Windows Bun tgz ownership and checksum-first update use the installed shim target", async () => {
	const home = await mkdtemp(join(tmpdir(), "dinobot-shim-test-"));
	const env = { ...process.env, HOME: home, USERPROFILE: home, BUN_INSTALL: join(home, "bun"), BUN_INSTALL_GLOBAL_DIR: join(home, "global"), BUN_INSTALL_BIN: join(home, "bin"), XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache") };
	async function run(argv: string[]) {
		const p = Bun.spawn(argv, { cwd: home, env, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
		const [stdout, stderr, exitCode] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		if (exitCode) throw new Error(JSON.stringify({ argv, exitCode, stdout, stderr }));
		return { stdout, exitCode };
	}
	try {
		const pkg = join(home, "package");
		await mkdir(pkg);
		for (const version of ["1.2.3", "1.2.4"]) {
			await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "dinobot", version, bin: { dinobot: "main.js" } }));
			await writeFile(join(pkg, "main.js"), ['#!/usr/bin/env bun', 'console.log("' + version + '");', ''].join(String.fromCharCode(10)));
			await run([join(process.env.SystemRoot!, "System32", "tar.exe"), "-czf", "dinobot-" + version + ".tgz", "package"]);
		}
		await run([process.execPath, "add", "-g", join(home, "dinobot-1.2.3.tgz")]);
		const main = join(env.BUN_INSTALL_GLOBAL_DIR, "node_modules", "dinobot", "main.js");
		const bytes = await readFile(join(home, "dinobot-1.2.4.tgz"));
		const release = { name: "dinobot", version: "1.2.4", dist: { tarball: "https://releases.dinobot.workers.dev/core/releases/1.2.4/dinobot-1.2.4.tgz", integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") } };
		let installs = 0;
		const command: UpdateCommand = async (argv, options) => {
			if (argv[0] === "npm") return { exitCode: 1, stdout: "" }; // Never inspect the user's npm global root.
			if (options.stdio === "inherit") { installs++; expect(await readFile(argv.at(-1)!)).toEqual(bytes); }
			return run([process.execPath, ...argv.slice(1)]);
		};
		const deps = { main, home, env, command, realpath, readFile: (path: string) => readFile(path, "utf8") };
		expect(await detectUpdateManager(deps)).toBe("bun");
		const errors: string[] = [];
		expect(await runUpdateWithDependencies({ ...deps, currentVersion: "1.2.3", fetch: (async (url: string | URL | Request) => String(url).endsWith(".json") ? Response.json(release) : new Response(bytes)) as typeof fetch, log: () => {}, error: message => errors.push(message) })).toBe(0);
		expect(errors).toEqual([]);
		expect(installs).toBe(1);
		expect(JSON.parse(await readFile(join(env.BUN_INSTALL_GLOBAL_DIR, "node_modules", "dinobot", "package.json"), "utf8")).version).toBe("1.2.4");
		expect((await run([process.execPath, main])).stdout.trim()).toBe("1.2.4");
		expect(await detectUpdateManager(deps)).toBe("bun");
		const shimPath = join(env.BUN_INSTALL_BIN, "dinobot.bunx");
		const shim = await readFile(shimPath);
		const corrupt = Buffer.from(shim); corrupt[0] = 120;
		await writeFile(shimPath, corrupt);
		expect(await detectUpdateManager(deps)).toBeNull();
		await writeFile(shimPath, shim.subarray(0, shim.length - 1));
		expect(await detectUpdateManager(deps)).toBeNull();
		await writeFile(shimPath, shim);
		await rm(join(env.BUN_INSTALL_BIN, "dinobot.exe"));
		expect(await detectUpdateManager(deps)).toBeNull();
	} finally { await rm(home, { recursive: true, force: true }); }
}, 60_000);
