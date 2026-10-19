import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mission } from "../src/core/research.ts";

const fixture = new URL("./fixtures/research-process.ts", import.meta.url).pathname;
type Child = ReturnType<typeof Bun.spawn>;
async function poll<T>(read: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(40);
	}
	throw new Error("Research process fixture deadline exceeded");
}
async function optional(path: string) {
	try { return await readFile(path, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return undefined; }
}
function alive(pid: number) {
	try { process.kill(pid, 0); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
function killEvaluator(pid: number) {
	try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
async function git(cwd: string, ...args: string[]) {
	const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (code !== 0) throw new Error(`Fixture Git failed: ${err}`);
	return out.trim();
}

test.each(["crash", "cancel", "preflight-crash", "canary-crash"] as const)("real research evaluator %s retains honest durable accounting without reinvocation", async (scenario) => {
	const root = await mkdtemp(join(tmpdir(), "research-process-"));
	const children: Child[] = [];
	let evaluatorPid: number | undefined;
	const marker = join(root, "invocations.jsonl");
	const summary = join(root, "summary.json");
	try {
		await git(root, "init");
		await git(root, "config", "user.email", "fixture@example.invalid");
		await git(root, "config", "user.name", "Research process fixture");
		await writeFile(join(root, "candidate.txt"), "100\n");
		// The absolute marker argument is explicitly authorized by this fixed host profile.
		// This evaluator is trusted local fixture code, not sandboxed untrusted code.
		const readinessStage = scenario === "preflight-crash" ? "preflight" : scenario === "canary-crash" ? "canary" : undefined;
		let runner = fixture;
		if (readinessStage) {
			let source = await readFile(fixture, "utf8");
			source = source.replace('argv: ["evaluator.ts", marker]', 'argv: ["evaluator.ts", "evaluation", marker]');
			source = source.replace('resultSchema: "research-numeric-v1"', 'resultSchema: "research-numeric-v2", readiness: { preflight: { argv: ["evaluator.ts", "preflight", marker], checkIds: ["ready"] }, canary: { argv: ["evaluator.ts", "canary", marker], checkIds: ["ready"] } }');
			for (const dependency of ["@earendil-works/chord/context", "@earendil-works/pi-ai/models", "@earendil-works/pi-ai/providers/faux", "@earendil-works/pi-durable/storage/sqlite/node", "@earendil-works/pi-durable"]) {
				source = source.replaceAll(JSON.stringify(dependency), JSON.stringify(import.meta.resolve(dependency)));
			}
			for (const name of ["bot", "research"]) source = source.replace(JSON.stringify(`../../src/core/${name}.ts`), JSON.stringify(new URL(`../src/core/${name}.ts`, import.meta.url).href));
			runner = join(root, "runner.ts");
			await writeFile(runner, source);
		}
		await writeFile(join(root, "evaluator.ts"), [
			'import { appendFileSync, readFileSync } from "node:fs";',
			...(readinessStage ? [
				`if (process.argv[2] !== ${JSON.stringify(readinessStage)}) { console.log(JSON.stringify({ version: "research-readiness-v1", checks: [{ id: "ready", verdict: "pass" }], feedback: "ready" })); process.exit(0); }`,
				'process.argv[2] = process.argv[3]!;',
			] : []),
			'const value = Number(readFileSync("candidate.txt", "utf8"));',
			'appendFileSync(process.argv[2]!, JSON.stringify({ pid: process.pid, cwd: process.cwd(), value }) + "\\n");',
			'await Bun.sleep(120_000);',
			'console.log(JSON.stringify({ samples: [value, value], metric: "latency", unit: "ms", guardrails: true, feedback: "fixture" }));',
		].join("\n"));
		await git(root, "add", "candidate.txt", "evaluator.ts");
		await git(root, "commit", "-m", "controlled evaluator");
		const base = await git(root, "rev-parse", "HEAD");
		const spawn = (mode: string) => {
			const child = Bun.spawn([process.execPath, runner, mode, root, join(root, "bot.sqlite"), base, marker, summary], { stdout: "pipe", stderr: "pipe" });
			children.push(child);
			return { child, output: Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]) };
		};
		const first = spawn(scenario !== "cancel" ? "start" : "cancel");
		const rawMarker = await poll(async () => {
			const content = await optional(marker);
			return content?.endsWith("\n") ? content : undefined;
		});
		const invocation = JSON.parse(rawMarker.trim()) as { pid: number; cwd: string; value: number };
		evaluatorPid = invocation.pid;
		expect(invocation.value).toBe(100);
		expect(invocation.cwd).toContain(join(root, ".dinobot", "research"));
		const before = JSON.parse(await poll(async () => {
			const value = await optional(join(root, "before.json"));
			if (!value) return undefined;
			try { JSON.parse(value); return value; } catch { return undefined; }
		})) as Mission;
		expect(before.evaluations).toHaveLength(0);
		expect(before.ledger.attemptsAdmitted).toBe(1);
		expect(before.ledger.activeAttemptIds).toHaveLength(1);
		if (scenario !== "cancel") {
			expect(alive(evaluatorPid)).toBe(true);
			first.child.kill("SIGKILL");
			await poll(async () => first.child.exitCode === null && !first.child.signalCode ? undefined : true);
			expect(await first.child.exited).not.toBe(0);
			expect(first.child.signalCode).toBe("SIGKILL");
			// Detached evaluator is fixture-owned; kill its known group explicitly after bot death.
			killEvaluator(evaluatorPid);
			await first.output;
			const second = spawn("reopen");
			await poll(async () => second.child.exitCode === null && !second.child.signalCode ? undefined : true);
			const output = await second.output;
			expect(await second.child.exited, output.join("\n")).toBe(0);
		} else {
			await poll(async () => first.child.exitCode === null && !first.child.signalCode ? undefined : true);
			const output = await first.output;
			expect(await first.child.exited, output.join("\n")).toBe(0);
			await poll(async () => alive(evaluatorPid!) ? undefined : true, 5_000);
		}
		const result = JSON.parse(await readFile(summary, "utf8")) as { mission: Mission; missionCount: number; providerCalls: number; controllerWaitCompleted: boolean };
		expect(result.missionCount).toBe(1);
		expect(result.mission.id).toBe(before.id);
		expect(result.mission.ledger.attemptsAdmitted).toBe(1);
		expect(result.mission.evaluations).toHaveLength(0);
		expect(result.controllerWaitCompleted).toBe(true);
		if (scenario !== "cancel") {
			expect(result.providerCalls).toBe(0);
			expect(result.mission.status).toBe("blocked");
			expect(result.mission.attempts[0]!.state).toBe("unknown");
			expect(result.mission.ledger.activeAttemptIds).toEqual(before.ledger.activeAttemptIds);
		} else {
			expect(result.mission.status).toBe("cancelled");
			expect(result.mission.attempts[0]!.state).toBe("cancelled");
			expect(result.mission.ledger.activeAttemptIds).toEqual([]);
		}
		expect(await readFile(marker, "utf8")).toBe(rawMarker);
		expect(await readFile(join(root, "candidate.txt"), "utf8")).toBe("100\n");
	} finally {
		for (const child of children) {
			if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
			await child.exited;
		}
		// Recover marker ownership even if an assertion failed before parsing the pid.
		const recorded = await optional(marker);
		for (const line of recorded?.trim().split("\n") ?? []) {
			try { const value = JSON.parse(line) as { pid: number }; if (Number.isSafeInteger(value.pid) && value.pid > 0) killEvaluator(value.pid); }
			catch (error) { if (!(error instanceof SyntaxError)) throw error; }
		}
		await rm(root, { recursive: true, force: true });
	}
}, 60_000);
