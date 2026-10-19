import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createRegistry } from "@earendil-works/pi-durable";
import { repairArguments, repairingRegistry, withArgumentRepair } from "../src/core/argument-repair.ts";
import { runCell } from "../src/core/codemode/worker.ts";
import { imagesExtension } from "../src/extensions/images.ts";

const bash = CodingTools.tools!.find((tool) => tool.name === "bash")!;
const strings = Type.Array(Type.String());
const plan = Type.Union([
	Type.Object({ op: Type.Literal("describe") }, { additionalProperties: false }),
	Type.Object({ op: Type.Literal("informational"), sourceIds: strings, rationale: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object({ op: Type.Literal("cancel"), workId: Type.String() }, { additionalProperties: false }),
]);
const validate = (tool: { name: string; parameters: unknown }, args: unknown) =>
	validateToolArguments(tool as never, { type: "toolCall", id: "t", name: tool.name, arguments: args as never });

describe("argument repair", () => {
	test("a bare string for a single required string field becomes that field (recorded #1226 step 2)", () => {
		const args = "git log --oneline -20 && git status -sb";
		expect(() => validate(bash, args)).toThrow(/must be object/);
		const repaired = repairArguments(bash.parameters as never, args);
		expect(repaired).toEqual({ command: args });
		expect(validate(bash, repaired)).toEqual({ command: args });
	});
	test("JSON text of the whole object or of an array field is parsed (recorded work_plan sourceIds)", () => {
		const tool = { name: "work_plan", parameters: plan };
		const args = { op: "informational", sourceIds: "[\"1696\"]", rationale: "read-only question" };
		expect(() => validate(tool, args)).toThrow(/Validation failed/);
		const repaired = repairArguments(plan as never, args);
		expect(repaired).toEqual({ op: "informational", sourceIds: ["1696"], rationale: "read-only question" });
		expect(validate(tool, repaired)).toEqual(repaired);
		expect(repairArguments(bash.parameters as never, "{\"command\":\"ls\"}")).toEqual({ command: "ls" });
	});
	test("identity and idempotence: valid input and string-typed fields are never changed", () => {
		const samples: [unknown, unknown][] = [
			[bash.parameters, { command: "[1,2]" }],
			[bash.parameters, { command: "ls", timeout: 5 }],
			[plan, { op: "cancel", workId: "{\"x\":1}" }],
			[plan, { op: "informational", sourceIds: ["a"], rationale: "[\"r\"]" }],
		];
		for (const [schema, args] of samples) {
			expect(repairArguments(schema as never, args)).toBe(args);
			const once = repairArguments(schema as never, args);
			expect(repairArguments(schema as never, once)).toEqual(once);
		}
		// Unparseable or wrongly-typed JSON stays as is, so validation still reports the real error.
		const bad = { op: "informational", sourceIds: "[not json", rationale: "x" };
		expect(repairArguments(plan as never, bad)).toBe(bad);
		const multi = Type.Object({ a: Type.String(), b: Type.String() });
		expect(repairArguments(multi as never, "plain")).toBe("plain");
	});
	test("repair composes with a tool's own prepareArguments and is installed registry-wide", () => {
		const seen: unknown[] = [];
		const tool = withArgumentRepair({ ...bash, prepareArguments: (args: unknown) => (seen.push(args), args) } as typeof bash);
		expect(tool.prepareArguments!("ls")).toEqual({ command: "ls" });
		expect(seen).toEqual([{ command: "ls" }]);
		const registry = repairingRegistry(createRegistry());
		registry.install(CodingTools);
		const installed = registry.snapshot().tools().find(({ tool }) => tool.name === "bash")!.tool;
		expect(installed.prepareArguments!("pwd")).toEqual({ command: "pwd" });
	});
});

describe("codemode cell diagnostics", () => {
	const names = ["edit", "read", "work_plan"];
	test("a unique case/underscore variant resolves to the allowed tool (recorded #11681 tools.Edit)", async () => {
		const calls: string[] = [];
		const result = await runCell({ code: "await tools.Edit({path: 'a'}); await tools.WorkPlan({op: 'describe'}); return typeof tools.nope", names, call: async (_id, name) => (calls.push(name), { content: [] }) });
		expect(result.error).toBeUndefined();
		expect(calls).toEqual(["edit", "work_plan"]);
		expect(result.value).toBe("undefined");
	});
	test("an unknown tool names the nearest allowed tools", async () => {
		const result = await runCell({ code: "await tools.raed({path: 'a'})", names, call: async () => null });
		expect(result.error).toContain("tools.raed is not a function");
		expect(result.error).toContain("Did you mean tools.read?");
	});
	test("syntax errors point at the cell line and column (recorded #5599 unterminated string)", async () => {
		const result = await runCell({ code: "const a = 1;\ntext(await tools.write({path:'x',content:'---\nmore'}));", names, call: async () => null });
		expect(result.error).toContain("Cell line 2:");
		expect(result.error).toContain("text(await tools.write({path:'x',content:'---");
		expect(result.error).toContain("^");
	});
	test("runtime errors carry the cell line (recorded #1226 step 26)", async () => {
		const result = await runCell({ code: "const a = 1;\nconst b = 2;\nreturn name.length;", names, call: async () => null });
		expect(result.error).toMatch(/name is not defined/);
		expect(result.error).toContain("Cell line 3:");
		expect(result.error).toContain("return name.length;");
	});
});

describe("read on a directory", () => {
	test("names the directory entries instead of a bare regular-file error", async () => {
		const root = await mkdtemp(join(tmpdir(), "dwb-readdir-"));
		try {
			await mkdir(join(root, "src", "core"), { recursive: true });
			await writeFile(join(root, "src", "a.ts"), "x");
			const read = imagesExtension().wraps![0]!;
			const base = CodingTools.tools!.find((tool) => tool.name === "read")!;
			const tool = (read as { wrap(tool: unknown): typeof base }).wrap(base);
			const { NodeExecutionEnv } = await import("@earendil-works/pi-durable/env/node");
			const env = new NodeExecutionEnv({ cwd: root });
			const result = await tool.execute({ path: "src" } as never, { env } as never, {} as never);
			expect(result.isError).toBe(true);
			const text = (result.content?.[0] as { text: string }).text;
			expect(text).toContain("is a directory");
			expect(text).toContain("a.ts");
			expect(text).toContain("core/");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
