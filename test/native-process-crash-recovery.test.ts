import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot } from "../src/core/bot.ts";
import { autoReconcile } from "../src/core/claim-reconcile.ts";
import { acquire, ClaimsDoc } from "../src/core/claims.ts";

/**
 * The daemon dies (SIGKILL) while a claim holder's Bash descendant still runs. The fence must survive that (see
 * native-process-crash.test.ts); once the descendant exits on its own, a restarted daemon must be able to prove it and
 * free the resource without manual abandonment, otherwise every daemon restart can lock a key forever. Startup recovery
 * settles the interrupted Bash task asynchronously, so the proof may need a moment after open; it must not need a human.
 */
test("a fence left by a daemon crash clears once the orphaned process exits", async () => {
	const dir = await mkdtemp(join(tmpdir(), "native-crash-recovery-"));
	const host = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/native-process-crash.ts"), dir, "direct"], { stdout: "pipe", stderr: "pipe" });
	try {
		let cut: { claims: { claims: { key: string; holder: string; token: number }[] }; child: { pid: number }; nonce: string } | undefined;
		for (let i = 0; i < 1000 && !cut; i++) {
			try { cut = JSON.parse(await readFile(join(dir, "cut.json"), "utf8")); } catch { await Bun.sleep(10); }
			if (host.exitCode !== null) throw Error(await new Response(host.stderr).text());
		}
		expect(cut).toBeTruthy();
		host.kill("SIGKILL");
		await host.exited;
		for (let i = 0; ; i++) {
			try { if ((await readFile(join(dir, "child-settled"), "utf8")) === cut!.nonce) break; } catch {}
			if (i > 1500) throw Error("orphan did not exit");
			await Bun.sleep(10);
		}
		for (let i = 0; i < 200; i++) { try { process.kill(cut!.child.pid, 0); await Bun.sleep(10); } catch { break; } }

		const models = createModels();
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		models.setProvider(faux.provider);
		faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("recover")));
		const bot = await openBot({ storage: await openNodeSqliteStorage(join(dir, "host.sqlite")), models, defaultModel: { provider: "faux", modelId: "m" }, workspaceRoot: dir, toolMode: "direct", plugins: [] }, context);
		try {
			const claim = cut!.claims.claims[0]!;
			const before = (await bot.harness.snapshot(ClaimsDoc, context))!.claims.find((c) => c.token === claim.token);
			expect(before?.quarantined).toContain("UNKNOWN");
			let outcome = await autoReconcile(bot.harness, [before!], "test: orphan exited", context);
			for (let i = 0; i < 40 && outcome.blockers.length; i++) { await Bun.sleep(250); outcome = await autoReconcile(bot.harness, [before!], "test: orphan exited", context); }
			expect(outcome.blockers).toEqual([]);
			const later = Date.now() + 24 * 60 * 60_000 + 1;
			const status = await bot.harness.commit(async (tx) => acquire(await tx.doc(ClaimsDoc), { key: claim.key, holder: "fixture:foreign", intent: "after crash", ttlMs: 60_000 }, later).status, context);
			expect(status).toBe("granted");
		} finally {
			await bot.close(context);
		}
	} finally {
		if (host.exitCode === null) { host.kill("SIGKILL"); await host.exited; }
		await rm(dir, { recursive: true, force: true });
	}
}, 60_000);
