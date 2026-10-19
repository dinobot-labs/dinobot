import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

async function exists(path: string) {
	return stat(path).then(
		() => true,
		() => false,
	);
}
async function until(check: () => Promise<boolean>, ms = 5000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(10);
	}
	throw new Error("Fixture did not reach crash cut");
}
for (const cut of ["before-call", "intent", "effect", "receipt", "foreground", "background"])
	test(`SIGKILL at ${cut}: reopen SQLite, no automatic side-effect replay, no owned orphan`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "dinobot-crash-"));
		const command = (mode: string) => [
			process.execPath,
			join(import.meta.dir, "fixtures/codemode-crash.ts"),
			dir,
			mode,
			cut,
		];
		const child = Bun.spawn(command("initial"), { stdout: "pipe", stderr: "pipe" });
		let recovery: ReturnType<typeof Bun.spawn> | undefined;
		try {
			await until(async () => await exists(join(dir, "cut")));
			child.kill("SIGKILL");
			await child.exited;
			const beforeDb = new Database(join(dir, "state.sqlite"), { readonly: true });
			const childIds = (
				beforeDb.query("select id from conversations where owner_task_id is not null").all() as { id: number }[]
			).map((row) => row.id);
			beforeDb.close();
			const before = await readFile(join(dir, "effects"), "utf8").catch(() => "");
			expect(before.split("\n").filter(Boolean).length).toBe(cut === "effect" || cut === "receipt" ? 1 : 0);
			recovery = Bun.spawn(command("recover"), { stdout: "pipe", stderr: "pipe" });
			const code = await Promise.race([
				recovery.exited,
				Bun.sleep(8000).then(() => {
					throw new Error("Recovery timed out");
				}),
			]);
			if (code !== 0) throw new Error(await new Response(recovery.stderr as ReadableStream<Uint8Array>).text());
			expect(await readFile(join(dir, "effects"), "utf8").catch(() => "")).toBe(before);
			expect(JSON.parse(await readFile(join(dir, "recovered"), "utf8")).tasks).toEqual([]);
			const db = new Database(join(dir, "state.sqlite"), { readonly: true });
			try {
				expect(db.query("select count(*) as n from tasks where status != 'terminal'").get()).toEqual({ n: 0 });
				const records = db
					.query("select record from tasks where json_extract(record, '$.kind')='dinobot.codemode.call'")
					.all() as { record: string }[];
				expect(records.length).toBe(cut === "before-call" ? 0 : 1);
				if (cut === "receipt") expect(JSON.parse(records[0]!.record).state.outcome.status).toBe("completed");
				if (cut === "foreground" || cut === "background") {
					const afterIds = (
						db.query("select id from conversations where owner_task_id is not null").all() as { id: number }[]
					).map((row) => row.id);
					expect(childIds).toHaveLength(1);
					expect(afterIds).toEqual(childIds);
					const runner = db
						.query("select record from tasks where json_extract(record,'$.kind')='dinobot.subagent'")
						.get() as { record: string };
					// Children are conversation-owned (ADR 0030): a crash of the waiting orchestrator does not discard
					// their work; the resumed orchestrator collects the durable result with task_output.
					expect(JSON.parse(runner.record).state.outcome.status).toBe("completed");
				}
				const outer = db.query("select record from tasks where json_extract(record, '$.kind')='pi.tool'").all() as {
					record: string;
				}[];
				expect(outer.some((r) => JSON.parse(r.record).state.outcome.status === "failed")).toBe(true);
			} finally {
				db.close();
			}
		} finally {
			if (child.exitCode === null) {
				child.kill("SIGKILL");
				await child.exited;
			}
			if (recovery && recovery.exitCode === null) {
				recovery.kill("SIGKILL");
				await recovery.exited;
			}
			await rm(dir, { recursive: true, force: true });
		}
	}, 15000);
