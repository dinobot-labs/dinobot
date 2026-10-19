import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { type JsonObject, type ToolResultMessage, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openBot, type Bot } from "../src/core/bot.ts";
import type { ToolMode } from "../src/core/toolmode.ts";
import { EvidenceDoc, WorkspaceCoordDoc, type WorkState } from "../src/core/verification.ts";
import { TodoDoc } from "../src/extensions/todo.ts";
import { NativeProvenanceDoc } from "../src/core/claim-cleanup.ts";
import { AgentsDoc, ProgressDoc } from "../src/extensions/subagents.ts";
import { definePlugin, loadPlugin, type LoadedPlugin } from "../src/plugins/types.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const required = ["work_status", "work_plan", "verify_run", "work_finish"];
const fixture = 'import { expect, test } from "bun:test"; import { add } from "./sum.ts"; test("adds positive operands", () => expect(add(2, 3)).toBe(5));\n';

test("opt-in strict work_status pages retained real failure output and named report without leaking full logs in summaries", async () => {
	const { bot, conversation, steps, run } = await setup("direct", [], true);
	const noisyFixture = 'import {test,expect} from "bun:test"; test("adds positive operands",()=>{console.log("failure-start:"+"가".repeat(9000)+":failure-end"); expect(2+3).toBe(6);});\n';
	await run([...steps.slice(0, 3), { tool: "write", args: { path: "sum.test.ts", content: noisyFixture } }, steps[4]!]);
	const attempt = (await bot.harness.snapshot(EvidenceDoc, conversation.id, context))!.attempts[0]!;
	expect(attempt.status).not.toBe("passed");
	const retained = (await bot.work.inspectAttempt(conversation.id, attempt.id, context))!;
	expect(retained.observation!.output).toContain("failure-end");
	expect(Buffer.byteLength(retained.observation!.output)).toBeGreaterThan(16 * 1024);
	const summary = (await conversation.context(context)).messages.filter((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "verify_run").at(-1)!;
	expect(JSON.stringify(summary.content)).not.toContain("가".repeat(100));
	for (const part of ["output", "report"] as const) {
		let offset = 0, recovered = "", hash: string | undefined;
		for (let pageCount = 0; ; pageCount++) {
			expect(pageCount).toBeLessThan(16);
			await run([{ tool: "work_status", args: { attemptId: attempt.id, part, offset } }]);
			const result = (await conversation.context(context)).messages.filter((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "work_status").at(-1)!;
			const block = result.content.find(block => block.type === "text");
			if (!block || block.type !== "text") throw new Error("Missing evidence page");
			const page = JSON.parse(block.text);
			expect(result.isError).not.toBe(true);
			expect(page.offset).toBe(offset);
			expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(16 * 1024);
			expect(page.text).not.toContain("�");
			expect(page.receipt.observation.output).toBeUndefined();
			expect(page.receipt.observation.report).toBeUndefined();
			hash ??= page.contentHash;
			expect(page.contentHash).toBe(hash);
			recovered += page.text;
			if (page.nextOffset === null) {
				expect(Buffer.byteLength(recovered)).toBe(page.totalBytes);
				break;
			}
			expect(page.nextOffset).toBeGreaterThan(offset);
			offset = page.nextOffset;
		}
		expect(recovered).toBe(retained.observation![part]);
		if (part === "report") expect(recovered).toContain("adds positive operands");
	}
}, 30_000);

type Step = { tool: string; args: Record<string, unknown> | ((state: WorkState) => Record<string, unknown>) } | string;
/** Omitted flags exercise default YOLO; strict tests opt into enforcement explicitly. */
async function setup(mode: ToolMode = "direct", plugins: LoadedPlugin[] = [], enforceVerification?: boolean, gateToolExecution?: boolean) {
	const root = await mkdtemp(join(tmpdir(), "verification-lifecycle-"));
	cleanup.push(() => rm(root, { recursive: true, force: true }));
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	const models = createModels(); models.setProvider(faux.provider);
	const bot: Bot = await openBot({ ...(enforceVerification === undefined ? {} : { enforceVerification }), ...(gateToolExecution === undefined ? {} : { gateToolExecution }), storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "one" }, toolMode: mode, workspaceRoot: root, plugins, agents: [{ name: "inspector", description: "Inspect verification", prompt: "Inspect only", tools: [...required, "codemode"] }] }, context);
	cleanup.push(() => bot.close(context));
	const conversation = await bot.conversation("test", "lifecycle", context);
	const method = { command: process.execPath, cwd: root, runner: "bun", args: ["./sum.test.ts"], timeout: 10, adapterVersion: 1, locators: [{ scenarioId: "addition", file: "sum.test.ts", name: "adds positive operands" }] };
	const contract = { requirements: [{ id: "sum", assertion: "Addition returns the sum", checkIds: ["behavior"], scenarioIds: ["addition"] }], scenarios: [{ id: "addition", assertion: "2 plus 3 is 5" }], checks: [{ id: "behavior", requirementIds: ["sum"], scenarioIds: ["addition"], evidence: "behavioral" as const, expected: "5" }] };
	const registration = (state: WorkState) => ({ op: "register", sourceIds: Object.keys(state.sources), contract, scope: { root, inputs: [], disposable: [] }, methods: { behavior: method } });
	const workArgs = (state: WorkState) => ({ workId: state.activeId! });
	const steps: Step[] = [
		{ tool: "work_plan", args: registration },
		{ tool: "write", args: { path: "sum.ts", content: "export const add = (a: number, b: number) => a - b;\n" } },
		{ tool: "edit", args: { path: "sum.ts", edits: [{ oldText: "a - b", newText: "a + b" }] } },
		{ tool: "write", args: { path: "sum.test.ts", content: fixture } },
		{ tool: "verify_run", args: state => ({ ...workArgs(state), checkId: "behavior" }) },
		{ tool: "work_finish", args: workArgs },
	];
	async function run(sequence: Step[]) {
		faux.setResponses([...sequence.map(step => async () => {
			if (typeof step === "string") return fauxAssistantMessage(step);
			const args = typeof step.args === "function" ? step.args(await bot.work.snapshot(conversation.id, context)) : step.args;
			return fauxAssistantMessage(fauxToolCall(mode === "direct" ? step.tool : "codemode", mode === "direct" ? args as JsonObject : { code: `text(await tools.${step.tool}(${JSON.stringify(args)}));` }), { stopReason: "toolUse" });
		}), ...Array.from({ length: 3 }, () => fauxAssistantMessage("done"))]);
		const submission = await conversation.submit({ type: "input", content: "Implement and verify addition" }, context);
		await submission.wait(context);
		return { submission, projection: await bot.work.projectSubmission(conversation.id, String(submission.id), "done", context) };
	}
	return { bot, conversation, root, faux, method, contract, registration, workArgs, steps, run };
}

for (const mode of ["direct", "hybrid", "codemode-only"] as const) {
	test(`${mode}: common registry, actual write/edit, named Bun report and certificate`, async () => {
		const { bot, conversation, root, steps, run } = await setup(mode, [], true);
		const names = (await conversation.agent(context)).tools.map(tool => tool.name);
		for (const name of required) expect(names).toContain(name);
		const { submission, projection } = await run(steps);
		expect(projection.workflow.status).toBe("verified");
		expect(projection.text).toContain("certificate");
		expect(await readFile(join(root, "sum.ts"), "utf8")).toContain("a + b");
		const state = await bot.work.snapshot(conversation.id, context);
		expect(state.works[0]!.sourceIds).toContain(String(submission.id));
		const attempts = (await bot.harness.snapshot(EvidenceDoc, conversation.id, context))!.attempts;
		expect(attempts).toHaveLength(1);
		expect(attempts[0]!.status).toBe("passed");
		expect(projection.workflow.certificate!.evidenceIds).toEqual([attempts[0]!.id]);
		const evidence = await bot.work.inspectAttempt(conversation.id, attempts[0]!.id, context);
		expect(JSON.stringify(evidence)).toContain("adds positive operands");
		expect(JSON.stringify(evidence)).toContain("sum.test.ts");
		await writeFile(join(root, "bunfig.toml"), "[test]\ntimeout = 2000\n");
		expect((await bot.work.status(conversation.id, context)).status).not.toBe("verified");
	}, 30_000);
	test(`${mode}: actual failed typo is repaired without lowering acceptance`, async () => {
		const { bot, conversation, steps, run, registration, method, workArgs, contract } = await setup(mode, [], true);
		const result = await run([
			{ tool: "work_plan", args: state => ({ ...registration(state), methods: { behavior: { ...method, args: ["./typo.test.ts"] } } }) },
			...steps.slice(1, 5),
			"done",
			{ tool: "work_plan", args: state => ({ op: "repair_method", ...workArgs(state), checkId: "behavior", expectedRevision: 1, method, rationale: "The failed path was a typo; the existing adds-positive-operands fixture enforces the identical immutable expectation" }) },
			...steps.slice(4),
		]);
		expect(result.projection.workflow.status).toBe("verified");
		const state = await bot.work.snapshot(conversation.id, context);
		expect(state.works[0]!.contract).toEqual(contract);
		expect(state.works[0]!.methods.behavior).toHaveLength(2);
		const attempts = (await bot.harness.snapshot(EvidenceDoc, conversation.id, context))!.attempts;
		expect(attempts).toHaveLength(2);
		expect(attempts[0]!.status).not.toBe("passed");
		expect(attempts[1]!.status).toBe("passed");
		expect(result.projection.workflow.certificate!.evidenceIds).toEqual([attempts[1]!.id]);
	}, 30_000);
}

test("initial informational answer needs neither a dummy plan nor a dummy check", async () => {
	const { bot, conversation, faux } = await setup();
	faux.setResponses([fauxAssistantMessage("Bun runs JavaScript and TypeScript.")]);
	const reply = await bot.handle({ channel: "test", threadKey: "lifecycle", messageId: "info", userId: "u", text: "What is Bun?" }, context);
	expect(reply).toMatchObject({ status: "answered", text: "Bun runs JavaScript and TypeScript." });
	expect((await bot.work.snapshot(conversation.id, context)).works).toEqual([]);
	expect((await bot.harness.snapshot(EvidenceDoc, conversation.id, context))?.attempts ?? []).toEqual([]);
});

test("early done and successful shell exit cannot stand in for a named behavioral receipt", async () => {
	const { bot, conversation, steps, run } = await setup("direct", [], true);
	const result = await run([...steps.slice(0, 4), "done", { tool: "bash", args: { command: "exit 0" } }, steps[5]!]);
	expect(result.projection.workflow.status).not.toBe("verified");
	expect(result.projection.workflow.certificate).toBeNull();
	expect((await bot.harness.snapshot(EvidenceDoc, conversation.id, context))?.attempts ?? []).toEqual([]);
	expect(result.projection.text).not.toBe("done");
});

test("passing Bun process without the required named scenario cannot certify", async () => {
	const { bot, conversation, steps, run } = await setup();
	const changed = [...steps];
	changed[3] = { tool: "write", args: { path: "sum.test.ts", content: 'import {test,expect} from "bun:test"; test("unrelated",()=>expect(true).toBe(true));' } };
	const result = await run(changed);
	expect(result.projection.workflow.certificate).toBeNull();
	expect((await bot.harness.snapshot(EvidenceDoc, conversation.id, context))!.attempts[0]!.status).not.toBe("passed");
});

test("required criteria cannot be lowered after registration", async () => {
	const { bot, conversation, contract, registration, run } = await setup();
	await run([{ tool: "work_plan", args: registration }, { tool: "work_plan", args: state => ({ ...registration(state), contract: { ...contract, checks: [{ ...contract.checks[0], expected: "anything" }] } }) }]);
	expect((await bot.work.snapshot(conversation.id, context)).works[0]!.contract).toEqual(contract);
	expect(JSON.stringify((await conversation.context(context)).messages)).toContain("acceptance_cannot_be_removed_or_lowered");
});

test("new source and shared answer cannot inherit a historical certificate; source edit stales it", async () => {
	const { bot, conversation, root, steps, run } = await setup();
	const first = await run(steps);
	expect(first.projection.workflow.status).toBe("verified");
	const next = await run(["done"]);
	expect(next.projection.workflow.status).not.toBe("verified");
	expect(next.projection.workflow.certificate).toBeNull();
	// The same assistant text does not change source identity or confer another input's evidence.
	expect((await bot.work.projectSubmission(conversation.id, String(next.submission.id), first.projection.text, context)).workflow.status).not.toBe("verified");
	await writeFile(join(root, "sum.ts"), "export const add = () => 0;\n");
	expect((await bot.work.projectSubmission(conversation.id, String(first.submission.id), "done", context)).workflow.status).not.toBe("verified");
});

for (const outcome of ["blocked", "cancelled"] as const) {
	test(`${outcome} finish projects an honest non-certificate answer`, async () => {
		const { run, registration, workArgs } = await setup("direct", [], true);
		const result = await run([{ tool: "work_plan", args: registration }, { tool: "work_finish", args: state => ({ ...workArgs(state), outcome, reason: "Required acceptance cannot be independently established" }) }]);
		expect(result.projection.workflow.status).toBe(outcome);
		expect(result.projection.workflow.certificate).toBeNull();
		expect(result.projection.text).toContain(outcome);
	});
}

test("ordinary TODO is progress; linked overall TODO requires an actual certificate", async () => {
	const { bot, conversation, steps, workArgs, run } = await setup("codemode-only", [], true);
	await run([...steps.slice(0, 4),
		{ tool: "todo_write", args: { todos: [{ id: "progress", content: "Implementation edited", status: "completed" }] } },
		{ tool: "todo_write", args: state => ({ todos: [{ id: "overall", content: "Certified result", status: "completed", ...workArgs(state) }] }) },
		{ tool: "work_status", args: {} },
	]);
	expect((await bot.harness.snapshot(TodoDoc, conversation.id, context))!.todos).toEqual([{ id: "progress", content: "Implementation edited", status: "completed" }]);
	await run([{ tool: "work_plan", args: state => ({ op: "register", sourceIds: Object.keys(state.sources), contract: state.works[0]!.contract, scope: state.works[0]!.scope, methods: { behavior: state.works[0]!.methods.behavior!.at(-1)!.method } }) }, ...steps.slice(4), { tool: "todo_write", args: state => ({ todos: [{ id: "overall", content: "Certified result", status: "completed", ...workArgs(state) }] }) }]);
	expect((await bot.harness.snapshot(TodoDoc, conversation.id, context))!.todos.find(todo => todo.id === "overall")?.status).toBe("completed");
});

test("unknown plugin effects are guarded, but explicitly readOnly probes remain available", async () => {
	let effects = 0, probes = 0;
	const plugin = await loadPlugin(definePlugin({ id: "surface", config: Type.Object({}), load: () => ({ tools: [
		{ name: "effect", description: "Unknown effect", inputSchema: { type: "object", properties: {} }, execute: async () => { effects++; return "effect"; } },
		{ name: "probe", description: "Non-effectful probe", readOnly: true, inputSchema: { type: "object", properties: {} }, execute: async () => { probes++; return "probe"; } },
	] }) }), {});
	if (Array.isArray(plugin)) throw new Error(plugin.join("; "));
	if (Array.isArray(plugin)) throw new Error(plugin.join("; "));
	const { run, registration } = await setup("codemode-only", [plugin], true, true);
	await run([{ tool: "surface_probe", args: {} }, { tool: "surface_effect", args: {} }]);
	expect(probes).toBe(1); expect(effects).toBe(0);
	await run([{ tool: "work_plan", args: registration }, { tool: "surface_effect", args: {} }]);
	expect(effects).toBe(1);
});

test("reset preserves obligations while fork never inherits the parent's certificate", async () => {
	const { bot, conversation, run, steps } = await setup();
	const original = await run(steps);
	const entry = (await conversation.entries({}, 1, undefined, context)).items[0]!;
	const fork = await conversation.fork(entry.id, { ownership: { kind: "ownerless" } }, context);
	expect((await bot.work.snapshot(fork.id, context)).works).toEqual([]);
	expect((await bot.work.status(fork.id, context, String(original.submission.id))).status).not.toBe("verified");
	await conversation.reset(undefined, context);
	const state = await bot.work.snapshot(conversation.id, context);
	expect(state.works[0]!.sourceIds).toContain(String(original.submission.id));
	const after = await run(["done"]);
	expect(after.projection.workflow.status).not.toBe("verified");
	expect((await bot.work.snapshot(conversation.id, context)).works[0]!.contract).toEqual(state.works[0]!.contract);
});

test("steering during a shared answer cannot borrow an earlier source certificate", async () => {
	const { bot, conversation, faux, run, steps } = await setup();
	await run(steps);
	let entered!: () => void, release!: () => void;
	const started = new Promise<void>(resolve => { entered = resolve; });
	const gate = new Promise<void>(resolve => { release = resolve; });
	faux.setResponses([
		async () => { entered(); await gate; return fauxAssistantMessage("done"); },
		...Array.from({ length: 5 }, () => fauxAssistantMessage("done")),
	]);
	const first = await conversation.submit({ type: "input", content: "Add negative operand behavior" }, context);
	await started;
	const steer = await conversation.submit({ type: "input", content: "Also handle zero", whenBusy: "steer" }, context);
	release();
	await first.wait(context); await steer.wait(context);
	for (const submission of [first, steer]) {
		const projected = await bot.work.projectSubmission(conversation.id, String(submission.id), "done", context);
		expect(projected.workflow.status).not.toBe("verified");
		expect(projected.workflow.certificate).toBeNull();
	}
});

test("child allowlist exposes all four work tools through the shared codemode bridge", async () => {
	const { bot, conversation, faux } = await setup("codemode-only");
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("codemode", { code: 'text(await tools.task({description:"Inspect",subagent_type:"inspector",prompt:"List your tools"}));' }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("codemode", { code: "text(Object.keys(tools).sort());" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Inspection complete"),
		fauxAssistantMessage("done"),
	]);
	await (await conversation.submit({ type: "input", content: "Inspect available controls" }, context)).wait(context);
	const ref = (await bot.harness.snapshot(AgentsDoc, conversation.id, context))!.agents[0]!;
	const child = (await bot.harness.conversation(ref.conversationId, context))!;
	expect((await child.agent(context)).tools.map(tool => tool.name).sort()).toEqual([...required, "codemode"].sort());
	const result = (await child.context(context)).messages.filter(message => message.role === "toolResult").at(-1)!;
	expect(JSON.stringify(result.content)).toContain("work_finish");
	expect(JSON.stringify(result.content)).not.toContain("write");
});

test("child premature done after a guarded write reports failed workflow metadata, not completed coding", async () => {
	const { bot, conversation, faux } = await setup("direct", [], true, true);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("task", { description: "Implement", prompt: "Write without registering" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("write", { path: "unplanned.txt", content: "must not happen" }), { stopReason: "toolUse" }),
		...Array.from({ length: 6 }, () => fauxAssistantMessage("done")),
	]);
	await (await conversation.submit({ type: "input", content: "Delegate implementation" }, context)).wait(context);
	const ref = (await bot.harness.snapshot(AgentsDoc, conversation.id, context))!.agents[0]!;
	const progress = await bot.harness.snapshot(ProgressDoc, conversation.id, String(ref.runnerId), context);
	expect(progress!.subagent!.status).toBe("failed");
	expect(progress!.subagent!.workflow?.status).not.toBe("verified");
	expect(progress!.subagent!.workflow?.certificate).toBeNull();
	expect(progress!.answer).not.toBe("done");
});

for (const mode of ["direct", "hybrid", "codemode-only"] as const) {
	test(`${mode}: settled shell failure and edit mismatch release leases for legitimate repair`, async () => {
		const { bot, conversation, root, steps, run } = await setup(mode, [], true, true);
		// A fast echo/exit can disappear before the native OS identity read. That is
		// correctly UNKNOWN, not the settled-failure precondition exercised here.
		// Hold the actual shell until its durable started receipt has been observed.
		const running = run([
			...steps.slice(0, 2),
			{ tool: "bash", args: { command: "while [ ! -f shell-release ]; do sleep 0.01; done; echo recoverable-shell-failure; exit 1", timeout: 10 } },
			{ tool: "edit", args: { path: "sum.ts", edits: [{ oldText: "this text does not exist", newText: "a + b" }] } },
			...steps.slice(2),
		]);
		let result!: Awaited<ReturnType<typeof run>>;
		try {
			const deadline = Date.now() + 5_000;
			let started;
			do {
				started = (await bot.harness.snapshot(NativeProvenanceDoc, conversation.id, context))?.calls[0]?.processes?.find(event => event.phase === "started");
				if (started) break;
				await Bun.sleep(10);
			} while (Date.now() < deadline);
			expect(started?.startTime).toBeTruthy();
		} finally {
			// Release and join the owned invocation even if observing its identity fails.
			await writeFile(join(root, "shell-release"), "release");
			result = await running;
		}
		const results = (await conversation.context(context)).messages.filter(message => message.role === "toolResult");
		expect(JSON.stringify(results[2]!.content)).toContain("recoverable-shell-failure");
		expect(JSON.stringify(results[2]!.content)).toContain("code 1");
		const native = (await bot.harness.snapshot(NativeProvenanceDoc, conversation.id, context))!.calls[0]!;
		expect(native.phase).toBe("settled");
		expect(native.processes!.find(event => event.phase === "settled")).toMatchObject({ code: 1, canonical: true });
		expect((await bot.harness.snapshot(WorkspaceCoordDoc, context))!.leases).toEqual([]);
		const mismatch = results[3]!;
		expect(JSON.stringify(mismatch.content)).toContain("Could not find the exact text");
		if (mode === "direct") expect(mismatch.isError).toBe(true);
		else {
			const block = mismatch.content.find(block => block.type === "text");
			if (!block || block.type !== "text") throw new Error("Missing nested edit result");
			expect(JSON.parse(block.text).isError).toBe(true);
		}
		expect(await readFile(join(root, "sum.ts"), "utf8")).toContain("a + b");
		expect(result.projection.workflow.status).toBe("verified");
		const attempts = (await bot.harness.snapshot(EvidenceDoc, conversation.id, context))!.attempts;
		expect(attempts).toHaveLength(1);
		expect(attempts[0]!.status).toBe("passed");
		expect(result.projection.workflow.certificate!.evidenceIds).toEqual([attempts[0]!.id]);
	}, 30_000);
}

for (const mode of ["direct", "hybrid", "codemode-only"] as const) {
	test(`${mode}: default YOLO runs shell, edits and plugin effects without a plan`, async () => {
		let effects = 0;
		const plugin = await loadPlugin(definePlugin({ id: "yolo", config: Type.Object({}), load: () => ({ tools: [
			{ name: "effect", description: "Count effect", inputSchema: { type: "object", properties: {} }, execute: async () => { effects++; return "effect observed"; } },
		] }) }), {});
		if (Array.isArray(plugin)) throw new Error(plugin.join("; "));
		const { bot, conversation, root, run } = await setup(mode, [plugin]);
		expect(bot.work.enforced).toBe(false);
		expect(bot.work.gated).toBe(false);
		const result = await run([
			{ tool: "bash", args: { command: "printf shell-ok > shell.txt" } },
			{ tool: "write", args: { path: "result.txt", content: "before" } },
			{ tool: "edit", args: { path: "result.txt", edits: [{ oldText: "before", newText: "after" }] } },
			{ tool: "yolo_effect", args: {} },
			{ tool: "todo_write", args: { todos: [{ id: "ordinary", content: "Completed without certification", status: "completed" }] } },
		]);
		expect(await readFile(join(root, "shell.txt"), "utf8")).toBe("shell-ok");
		expect(await readFile(join(root, "result.txt"), "utf8")).toBe("after");
		expect(effects).toBe(1);
		expect((await bot.harness.snapshot(TodoDoc, conversation.id, context))!.todos[0]!.status).toBe("completed");
		expect(result.projection.workflow.certificate).toBeNull();
		expect(result.projection.text).toBe("done");
		expect((await bot.work.snapshot(conversation.id, context)).works).toEqual([]);
	}, 30_000);

	for (const outcome of ["blocked", "cancelled"] as const) test(`${mode}: default YOLO ignores old ${outcome} work for execution, answers and linked todos`, async () => {
		const { bot, conversation, root, run, registration, workArgs } = await setup(mode);
		await run([
			{ tool: "work_plan", args: registration },
			{ tool: "work_finish", args: state => ({ ...workArgs(state), outcome, reason: "Old unmet check" }) },
		]);
		await bot.harness.commit(async tx => {
			(await tx.doc(WorkspaceCoordDoc)).leases.push({ id: "old-unknown", taskId: "old-task", workId: (await bot.work.snapshot(conversation.id, context)).activeId!, root, environment: "node:local", conversationId: String(conversation.id), reason: "mutation", phase: "blocked-unknown" });
		}, context);
		const result = await run([
			{ tool: "bash", args: { command: "printf recovered > recovered.txt" } },
			{ tool: "todo_write", args: state => ({ todos: [{ id: "overall", content: "Done", status: "completed", ...workArgs(state) }] }) },
		]);
		expect(await readFile(join(root, "recovered.txt"), "utf8")).toBe("recovered");
		expect(result.projection.text).toBe("done");
		expect((await bot.work.status(conversation.id, context)).status).toBe(outcome);
		expect(result.projection.workflow.certificate).toBeNull();
		expect((await bot.harness.snapshot(TodoDoc, conversation.id, context))!.todos[0]!.status).toBe("completed");
		expect(await bot.work.coach(conversation.id, "should-not-coach", context)).toBeUndefined();
	}, 30_000);

	test(`${mode}: optional finish rejects missing required evidence while the answer remains available`, async () => {
		const { bot, conversation, steps, run } = await setup(mode);
		const result = await run([...steps.slice(0, 4), { tool: "bash", args: { command: "exit 0" } }, steps[5]!]);
		expect(result.projection.text).toBe("done");
		expect(result.projection.workflow.status).not.toBe("verified");
		expect(result.projection.workflow.certificate).toBeNull();
		expect(result.projection.workflow.unmetCheckIds).toContain("behavior");
		expect((await bot.harness.snapshot(EvidenceDoc, conversation.id, context))?.attempts ?? []).toEqual([]);
	}, 30_000);

	test(`${mode}: YOLO still supports explicit evidence and invalidates it after a tool effect`, async () => {
		const { bot, conversation, steps, run } = await setup(mode);
		const certified = await run(steps);
		expect(certified.projection.workflow.status).toBe("verified");
		await run([{ tool: "bash", args: { command: "true" } }]);
		expect((await bot.work.status(conversation.id, context)).certificate).toBeNull();
	}, 30_000);
}

for (const mode of ["direct", "hybrid", "codemode-only"] as const) {
	test(`${mode}: explicit enforcement still runs shell, writes and plugin effects without a plan`, async () => {
		let effects = 0;
		const plugin = await loadPlugin(definePlugin({ id: "open", config: Type.Object({}), load: () => ({ tools: [
			{ name: "effect", description: "Count effect", inputSchema: { type: "object", properties: {} }, execute: async () => { effects++; return "effect observed"; } },
		] }) }), {});
		if (Array.isArray(plugin)) throw new Error(plugin.join("; "));
		const { bot, root, run } = await setup(mode, [plugin], true);
		expect(bot.work.enforced).toBe(true);
		expect(bot.work.gated).toBe(false);
		await run([
			{ tool: "bash", args: { command: "printf shell-ok > shell.txt" } },
			{ tool: "write", args: { path: "result.txt", content: "written" } },
			{ tool: "open_effect", args: {} },
		]);
		expect(await readFile(join(root, "shell.txt"), "utf8")).toBe("shell-ok");
		expect(await readFile(join(root, "result.txt"), "utf8")).toBe("written");
		expect(effects).toBe(1);
	}, 30_000);
}

test("explicit enforcement replaces the answer of registered but unverified work with the host projection", async () => {
	const { run, steps } = await setup("direct", [], true);
	const { projection } = await run(steps.slice(0, 2));
	expect(projection.workflow.status).toBe("implementing");
	expect(projection.text).toStartWith("Work implementing: ");
	expect(projection.text).toContain("unmet behavior");
});

test("explicit enforcement treats a plan-less file edit as unregistered coding work, but not a shell probe", async () => {
	const edited = await setup("direct", [], true);
	const { projection } = await edited.run([{ tool: "write", args: { path: "sum.ts", content: "export const add = (a: number, b: number) => a - b;\n" } }]);
	expect(await readFile(join(edited.root, "sum.ts"), "utf8")).toContain("a - b");
	expect(projection.workflow.status).not.toBe("informational");
	expect(projection.text).toStartWith("Work planning: ");
	const probed = await setup("direct", [], true);
	const probe = await probed.run([{ tool: "bash", args: { command: "ls" } }]);
	expect(probe.projection.workflow.status).toBe("informational");
});

test("gateToolExecution still refuses a plan-less write", async () => {
	const { bot, conversation, root, run } = await setup("direct", [], undefined, true);
	expect(bot.work.gated).toBe(true);
	await run([{ tool: "write", args: { path: "unplanned.txt", content: "must not happen" } }]);
	expect(await Bun.file(join(root, "unplanned.txt")).exists()).toBe(false);
	expect(JSON.stringify((await conversation.context(context)).messages)).toContain("work_plan_required_for_current_sources");
});

for (const mode of ["direct", "hybrid", "codemode-only"] as const) {
	test(`${mode}: YOLO child executes shell and completes without certification`, async () => {
		const { bot, conversation, root, faux } = await setup(mode);
		const call = (tool: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(
			mode === "direct" ? tool : "codemode",
			mode === "direct" ? args as JsonObject : { code: `text(await tools.${tool}(${JSON.stringify(args)}));` },
		), { stopReason: "toolUse" });
		faux.setResponses([
			call("task", { description: "Implement", prompt: "Write child marker" }),
			call("bash", { command: "printf child-ok > child.txt" }),
			fauxAssistantMessage("child done"), fauxAssistantMessage("parent done"),
		]);
		await (await conversation.submit({ type: "input", content: "Delegate implementation" }, context)).wait(context);
		const ref = (await bot.harness.snapshot(AgentsDoc, conversation.id, context))!.agents[0]!;
		const progress = await bot.harness.snapshot(ProgressDoc, conversation.id, String(ref.runnerId), context);
		expect(progress!.subagent!.status).toBe("completed");
		expect(progress!.answer).toBe("child done");
		expect(await readFile(join(root, "child.txt"), "utf8")).toBe("child-ok");
	}, 30_000);
}

for (const mode of ["direct", "hybrid", "codemode-only"] as const) {
	test(`${mode}: describe/preflight share registry and repeated registration failures give bounded recovery without gating normal tools`, async () => {
		const { bot, conversation, run, registration, root } = await setup(mode);
		await run([
			{ tool: "work_plan", args: { op: "describe" } },
			{ tool: "work_plan", args: state => ({ ...registration(state), op: "preflight", methods: {} }) },
			{ tool: "work_plan", args: state => ({ ...registration(state), methods: {} }) },
			{ tool: "work_plan", args: state => ({ ...registration(state), methods: {} }) },
			{ tool: "write", args: { path: "after-errors.txt", content: "ordinary work still available" } },
		]);
		const messages = (await conversation.context(context)).messages.filter(message => message.role === "toolResult");
		const outputs = messages.map(message => JSON.stringify(message.content));
		expect(outputs[0]).toContain(root);
		expect(outputs[0]).toContain("behavioralMethodExample");
		expect(outputs[1]).toContain("missing_method");
		expect(outputs[1]).toContain("certification");
		expect(outputs[2]).toContain('repeatedFailure\\":false');
		expect(outputs[3]).toContain('repeatedFailure\\":true');
		expect(outputs[3]).toContain("stop guessing");
		expect(await readFile(join(root, "after-errors.txt"), "utf8")).toContain("ordinary work");
		expect((await bot.work.snapshot(conversation.id, context)).works).toHaveLength(0);
		expect((await bot.harness.snapshot(EvidenceDoc, conversation.id, context))?.attempts ?? []).toEqual([]);
	});
}
