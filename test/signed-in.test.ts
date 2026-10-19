import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signedIn } from "../src/api/server.ts";
import { createBotModels } from "../src/auth/index.ts";
import { openCredentialFile } from "../src/auth/store.ts";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

test("a fresh install is not signed in; a stored key signs the provider in; unknown models never prompt", async () => {
	const saved = process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_API_KEY;
	try {
		const dir = await mkdtemp(join(tmpdir(), "dinobot-signed-in-")); dirs.push(dir);
		const credentials = openCredentialFile(dir);
		const models = createBotModels({ credentials });
		expect(await signedIn(models, "anthropic/claude-sonnet-4-6")).toBe(false);
		await credentials.addAccount("anthropic", { type: "api_key", key: "sk-ant-test" });
		expect(await signedIn(models, "anthropic/claude-sonnet-4-6")).toBe(true);
		expect(await signedIn(models, "nobody/none")).toBe(true);
	} finally {
		if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
	}
});
