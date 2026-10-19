import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import packageJson from "../package.json";

async function cli(args: string[], latest = packageJson.version) {
	const home = await mkdtemp(join(tmpdir(), "dinobot-update-cli-"));
	try {
		const preload = join(home, "registry.ts");
		await writeFile(preload, "globalThis.fetch = async () => Response.json(" + JSON.stringify({ name: "dinobot", version: latest }) + ");");
		const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", preload, resolve("src/main.ts"), ...args], {
			cwd: home, env: { HOME: home, DINOBOT_CONFIG: join(home, "absent.yaml"), PATH: "", DINOBOT_NO_UPDATE_CHECK: "1" }, stdout: "pipe", stderr: "pipe", timeout: 5000,
		});
		const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		const createdConfig = await access(join(home, ".config/dinobot/dinobot.yaml")).then(() => true, () => false);
		return { out, err, code, createdConfig };
	} finally { await rm(home, { recursive: true, force: true }); }
}

test("update and root help advertise the command without resolving a manifest", async () => {
	for (const args of [["--help"], ["update", "--help"]]) {
		const result = await cli(args);
		expect(result.code).toBe(0);
		expect(result.out).toContain("dinobot update");
		expect(result.createdConfig).toBe(false);
	}
});

test("explicit update bypasses passive opt-out, checks before manifest loading, and exits current without daemon startup", async () => {
	const result = await cli(["update"]);
	expect(result.code).toBe(0);
	expect(result.out).toContain("current");
	expect(result.out).not.toContain("dinobot up:");
	expect(result.err).toBe("");
	expect(result.createdConfig).toBe(false);
});

test("source install refuses an unsafe migration and extra update operands fail before any configuration", async () => {
	const result = await cli(["update"], "999.0.0");
	expect(result.code).toBe(1);
	expect(result.err).toContain("original install/build workflow");
	expect(result.err).not.toContain("absent.yaml");
	expect(result.createdConfig).toBe(false);
	const extra = await cli(["update", "unexpected"]);
	expect(extra.code).toBe(2);
	expect(extra.err).toContain("unknown command");
	expect(extra.createdConfig).toBe(false);
});
