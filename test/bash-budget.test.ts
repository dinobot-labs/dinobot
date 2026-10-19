import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { BASH_BUDGET, type BashBudget, bashBudgetExtension, checkBashTimeout, wrapBashWithBudget } from "../src/extensions/bash-budget.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function harness(budget: BashBudget = BASH_BUDGET) {
	const cwd = await mkdtemp(join(tmpdir(), "dinobot-bash-budget-"));
	dirs.push(cwd);
	const output: string[] = [];
	const api = { env: new NodeExecutionEnv({ cwd }), output: (text: string) => output.push(text), diagnostic: () => {} } as unknown as ToolExecutionApi;
	const bash = wrapBashWithBudget(createBashTool() as ToolRegistration, budget);
	return { cwd, output, run: (args: Record<string, unknown>) => bash.execute(args as never, api, context), bash };
}

test("an omitted timeout gets the default budget and the timeout error says how to extend it", async () => {
	const { run } = await harness({ defaultSeconds: 1, maxSeconds: 60 });
	const started = Date.now();
	const error = await run({ command: "sleep 30" }).then(() => undefined, (e: Error) => e);
	expect(Date.now() - started).toBeLessThan(10_000);
	expect(error?.message).toContain("timed out after 1 seconds (the default when no timeout is given)");
	expect(error?.message).toContain("larger timeout in seconds (up to 60)");
});

test("millisecond-looking timeouts are rejected with a seconds hint before the command runs", async () => {
	const { cwd, run } = await harness();
	const error = await run({ command: "touch ran", timeout: 120_000 }).then(() => undefined, (e: Error) => e);
	expect(error?.message).toContain("in seconds");
	expect(error?.message).toContain("pass 120");
	expect(await stat(join(cwd, "ran")).then(() => true, () => false)).toBe(false);
	for (const bad of [0, -5, Number.NaN, "60"]) expect(() => checkBashTimeout(bad)).toThrow("positive number of seconds");
});

test("explicit timeouts inside the budget are honoured unchanged, including the largest real one seen", async () => {
	const { run, output } = await harness();
	await run({ command: "echo ok", timeout: 5 });
	expect(output.join("")).toContain("ok");
	expect(checkBashTimeout(14_600)).toBe(14_600);
	expect(checkBashTimeout(BASH_BUDGET.maxSeconds)).toBe(BASH_BUDGET.maxSeconds);
	expect(() => checkBashTimeout(BASH_BUDGET.maxSeconds + 1)).toThrow("in seconds");
	// An explicit short timeout keeps the plain error (no default-budget hint).
	const error = await run({ command: "sleep 30", timeout: 1 }).then(() => undefined, (e: Error) => e);
	expect(error?.message).toBe("Command timed out after 1 seconds");
});

test("the installed bot bash tool applies the budget in every tool mode (end to end through a turn)", async () => {
	const { createModels } = await import("@earendil-works/pi-ai/models");
	const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
	const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
	const { openBot } = await import("../src/core/bot.ts");
	for (const toolMode of ["direct", "codemode-only"] as const) {
		const dir = await mkdtemp(join(tmpdir(), "dinobot-bash-budget-bot-"));
		dirs.push(dir);
		const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const bot = await openBot({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "faux-1" }, toolMode, plugins: [], workspaceRoot: dir }, context);
		try {
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "touch ran", timeout: 90_000 }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await bot.handle({ channel: "http", threadKey: `budget-${toolMode}`, messageId: "m1", userId: "u", text: "run it" }, context);
			const conversation = await bot.conversation("http", `budget-${toolMode}`, context);
			const result = (await conversation.context(context)).messages.find(message => message.role === "toolResult");
			expect(result?.isError).toBe(true);
			expect(JSON.stringify(result?.content)).toContain("pass 90");
			expect(await stat(join(dir, "ran")).then(() => true, () => false)).toBe(false);
		} finally { await bot.close(context); }
	}
});

test("the model-facing contract states the unit, default and maximum", async () => {
	const { bash } = await harness();
	const timeout = (bash.parameters as { properties: { timeout: { description: string } } }).properties.timeout;
	expect(timeout.description).toContain("SECONDS (not milliseconds)");
	expect(timeout.description).toContain(`Default ${BASH_BUDGET.defaultSeconds}`);
	expect(bash.description).toContain(`stopped after ${BASH_BUDGET.defaultSeconds} seconds`);
	const wrap = bashBudgetExtension().wraps![0]!;
	expect("tool" in wrap && wrap.tool).toBe("bash");
});
