import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import baseline from "../SOUL.md" with { type: "text" };
import { loadSoul } from "../src/core/soul.ts";
import { dinobotExtension } from "../src/extensions/dinobot.ts";

const directories: string[] = [];
async function workspace() {
	const path = await mkdtemp(join(tmpdir(), "dinobot-soul-"));
	directories.push(path);
	return path;
}

afterEach(async () => {
	for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("SOUL snapshot", () => {
	test("missing optional file uses bundled baseline without looking in ancestors", async () => {
		const root = await workspace();
		await writeFile(join(root, "SOUL.md"), "Ancestor guidance must not leak");
		const child = join(root, "child");
		await mkdir(child);
		const soul = await loadSoul(child);
		expect(soul.valid).toBe(true);
		expect(soul.diagnostics).toEqual([]);
		expect(soul.text).toBe(baseline);
		expect(soul.text).not.toContain("Ancestor guidance must not leak");
	});

	test("normal workspace text is additive and content edits change the byte digest", async () => {
		const cwd = await workspace();
		await writeFile(join(cwd, "SOUL.md"), "Use the customer's terminology.\n");
		const first = await loadSoul(cwd);
		expect(first.valid).toBe(true);
		expect(first.text).toStartWith(baseline.trimEnd());
		expect(first.text).toContain("## Workspace SOUL (additive)");
		expect(first.text).toContain("Use the customer's terminology.");
		expect(await loadSoul(cwd)).toEqual(first);
		await writeFile(join(cwd, "SOUL.md"), "Use the customer's terminology.\n\n");
		expect((await loadSoul(cwd)).digest).not.toBe(first.digest);
	});

	test("duplicate baseline renders once but retains local byte identity", async () => {
		const cwd = await workspace();
		const missing = await loadSoul(cwd);
		await writeFile(join(cwd, "SOUL.md"), baseline);
		const duplicate = await loadSoul(cwd);
		expect(duplicate.text).toBe(baseline);
		expect(duplicate.valid).toBe(true);
		expect(duplicate.digest).not.toBe(missing.digest);
		await writeFile(join(cwd, "SOUL.md"), `\n${baseline}\n`);
		const padded = await loadSoul(cwd);
		expect(padded.text).toBe(baseline);
		expect(padded.digest).not.toBe(duplicate.digest);
	});

	test("a baseline copy with other line endings, a BOM or trailing spaces renders once", async () => {
		const cwd = await workspace();
		const lf = baseline.replace(/\r\n/g, "\n");
		for (const copy of [lf.replace(/\n/g, "\r\n"), lf, `\uFEFF${lf}`, lf.replace(/\n/g, "  \n")]) {
			await writeFile(join(cwd, "SOUL.md"), copy);
			const soul = await loadSoul(cwd);
			expect(soul.text).toBe(baseline);
			expect(soul.text).not.toContain("## Workspace SOUL (additive)");
		}
	});

	test("a baseline copy with local additions injects only the additions under their headings", async () => {
		const cwd = await workspace();
		const lf = baseline.replace(/\r\n/g, "\n").trimEnd();
		await writeFile(join(cwd, "SOUL.md"), `${lf.replace(/\n/g, "\r\n")}\r\n\r\nAlways answer in Korean.\r\n\r\n## Project rules\r\n\r\nRun bun test before pushing.\r\n`);
		const soul = await loadSoul(cwd);
		const added = soul.text.slice(baseline.trimEnd().length);
		expect(soul.text).toStartWith(baseline.trimEnd());
		expect(added).toContain("Always answer in Korean.");
		expect(added).toContain("## Project rules\n\nRun bun test before pushing.");
		// No baseline paragraph appears a second time.
		expect(added).not.toContain("Implement the smallest correct change");
		expect(soul.text.split("Implement the smallest correct change")).toHaveLength(2);
		// The heading the additions sit under is kept for context; baseline-only headings are not.
		expect(added).toContain("## Scope and controls\n\nAlways answer in Korean.");
		expect(added).not.toContain("## Plan");
	});

	test("empty and BOM-only policies render baseline while hashing original bytes", async () => {
		const cwd = await workspace();
		await writeFile(join(cwd, "SOUL.md"), "");
		const empty = await loadSoul(cwd);
		await writeFile(join(cwd, "SOUL.md"), Buffer.from([0xef, 0xbb, 0xbf]));
		const bom = await loadSoul(cwd);
		expect(empty.text).toBe(baseline);
		expect(bom.text).toBe(baseline);
		expect(bom.valid).toBe(true);
		expect(bom.digest).not.toBe(empty.digest);
	});

	test("invalid UTF-8 retains baseline and produces explicit invalid diagnostics", async () => {
		const cwd = await workspace();
		await writeFile(join(cwd, "SOUL.md"), Buffer.from([0xc3, 0x28]));
		const soul = await loadSoul(cwd);
		expect(soul.valid).toBe(false);
		expect(soul.text).toBe(baseline);
		expect(soul.diagnostics.join("\n")).toContain("invalid UTF-8");
		await writeFile(join(cwd, "SOUL.md"), Buffer.from([0xc3, 0x29]));
		expect((await loadSoul(cwd)).digest).not.toBe(soul.digest);
	});

	test("64 KiB boundary counts bytes, not characters", async () => {
		const cwd = await workspace();
		const boundary = "é".repeat(32768);
		await writeFile(join(cwd, "SOUL.md"), boundary);
		const accepted = await loadSoul(cwd);
		expect(accepted.valid).toBe(true);
		expect(accepted.text).toContain(boundary);
		await writeFile(join(cwd, "SOUL.md"), `${boundary}x`);
		const rejected = await loadSoul(cwd);
		expect(rejected.valid).toBe(false);
		expect(rejected.text).toBe(baseline);
		expect(rejected.diagnostics.join("\n")).toContain("exceeds 65536 bytes");
	});

	test("unreadable non-file policy is an explicit error, including when run as root", async () => {
		const cwd = await workspace();
		await mkdir(join(cwd, "SOUL.md"));
		const soul = await loadSoul(cwd);
		expect(soul.valid).toBe(false);
		expect(soul.text).toBe(baseline);
		expect(soul.diagnostics.join("\n")).toContain("SOUL read failed");
	});

	test("unresolvable cwd is invalid, not a missing optional policy", async () => {
		const root = await workspace();
		const soul = await loadSoul(join(root, "missing"));
		expect(soul.valid).toBe(false);
		expect(soul.text).toBe(baseline);
		expect(soul.diagnostics.join("\n")).toContain("cwd resolution failed");
	});

	test("cwd identity is canonical: aliases match, distinct roots do not", async () => {
		const first = await workspace();
		const second = await workspace();
		const alias = join(second, "alias");
		await symlink(first, alias, "dir");
		expect((await loadSoul(first)).digest).toBe((await loadSoul(alias)).digest);
		expect((await loadSoul(first)).digest).not.toBe((await loadSoul(second)).digest);
	});

	test("static text import embeds baseline bytes and identity without runtime baseline file reads", async () => {
		const source = await readFile(new URL("../src/core/soul.ts", import.meta.url), "utf8");
		expect(source).toContain('import baseline from "../../SOUL.md" with { type: "text" }');
		expect(baseline).toBe(await readFile(new URL("../SOUL.md", import.meta.url), "utf8"));
		const cwd = await workspace();
		// Reconstruct the framed missing-policy digest to check baseline bytes participate.
		const { realpath } = await import("node:fs/promises");
		const bytes = Buffer.from(baseline, "utf8");
		const expected = createHash("sha256")
			.update(JSON.stringify({ version: 1, cwd: await realpath(cwd), state: "missing", valid: true, baselineLength: bytes.length, workspaceLength: 0 }))
			.update(bytes)
			.digest("hex");
		expect((await loadSoul(cwd)).digest).toBe(expected);
	});
});

describe("SOUL prompt section", () => {
	test.each(["direct", "hybrid", "codemode-only"] as const)("%s uses live child cwd and retains common workflow policy", async (mode) => {
		const parent = await workspace();
		const child = join(parent, "child");
		await mkdir(child);
		await writeFile(join(parent, "SOUL.md"), "Parent-only policy");
		await writeFile(join(child, "SOUL.md"), "Child-only policy");
		const extension = dinobotExtension(mode, []);
		const section = extension.sections!.find((item) => item.key === "soul")!;
		const render = (cwd: string) => section.render({ env: { cwd } } as Parameters<typeof section.render>[0], BACKGROUND_CONTEXT);
		expect(await render(parent)).toContain("Parent-only policy");
		const text = await render(child);
		expect(text).toContain("Child-only policy");
		expect(text).not.toContain("Parent-only policy");
		for (const term of ["work_plan", "verify_run", "work_finish", "repair_method", "Informational", "invariants"]) {
			expect(text).toContain(term);
		}
		expect(text).toContain("requesting `verified` only with actual, current evidence");
		expect(text).toContain("Truthful `blocked` or `cancelled` outcomes are allowed without complete evidence");
		const preamble = extension.sections!.find((item) => item.key === "preamble")!;
		const common = await preamble.render({} as Parameters<typeof preamble.render>[0], BACKGROUND_CONTEXT);
		expect(common).toContain("The verification section states whether tools are gated and whether certification is enforced");
		await writeFile(join(child, "SOUL.md"), Buffer.from([0xff]));
		expect(await render(child)).toContain("SOUL policy is invalid");
		expect(await render(child)).toContain("invalid UTF-8");
	});
});
