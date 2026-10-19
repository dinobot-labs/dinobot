import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Terminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { PromptBox } from "../src/tui/chrome.ts";
import { expandContextReferences, listWorkspaceEntries, parseContextReferences, type WorkspaceEntry } from "../src/tui/context-refs.ts";
import { SlashMenu, type SlashSource } from "../src/tui/slash.ts";

let root: string;
let repo: string;
let outside: string;
const git = (...args: string[]): void => {
	const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};

beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "dinobot-refs-")));
	repo = join(root, "repo");
	outside = join(root, "outside.txt");
	mkdirSync(join(repo, "src", "deep"), { recursive: true });
	writeFileSync(outside, "OUTSIDE-SECRET\n");
	writeFileSync(join(repo, "a.ts"), "line one\nline two\nline three\nline four\n");
	writeFileSync(join(repo, "src", "x.ts"), "export const x = 1;\n");
	writeFileSync(join(repo, "src", "deep", "y.md"), "# y\n");
	git("init", "-q");
	git("add", ".");
	git("commit", "-qm", "first commit");
	writeFileSync(join(repo, "a.ts"), "line one\nline two CHANGED\nline three\nline four\n");
	writeFileSync(join(repo, "b.ts"), "export const staged = true;\n");
	git("add", "b.ts");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const options = (extra: Partial<Parameters<typeof expandContextReferences>[1]> = {}) => ({ cwd: repo, contextWindow: 128_000, home: join(root, "home"), ...extra });

test("parse: kinds, line ranges, quoted paths, trailing punctuation and unbalanced closers; e-mail-like text is not a reference", () => {
	const refs = parseContextReferences("see @file:a.ts:2-3, (and @folder:src) @diff @staged @git:3. me@diff.com @file:`a b.ts`:4");
	expect(refs.map((ref) => [ref.kind, ref.target, ref.lineStart, ref.lineEnd])).toEqual([
		["file", "a.ts", 2, 3], ["folder", "src", undefined, undefined], ["diff", "", undefined, undefined],
		["staged", "", undefined, undefined], ["git", "3", undefined, undefined], ["file", "a b.ts", 4, 4],
	]);
	expect(refs[1]?.raw).toBe("@folder:src");
	expect(parseContextReferences("no refs here, mail me@staged.dev")).toEqual([]);
});

test("expand: @file range, @folder listing, @diff, @staged and @git:N land under Attached Context with the text kept inline", async () => {
	const message = "see @file:a.ts:2-3 and @folder:src @diff @staged @git:1.";
	const result = await expandContextReferences(message, options());
	expect(result.blocked).toBe(false);
	expect(result.warnings).toEqual([]);
	const [head, attached] = result.message.split("\n\n--- Attached Context ---\n\n");
	expect(head).toBe(message);
	expect(attached).toContain("📄 @file:a.ts:2-3 (");
	expect(attached).toContain("(7 tokens)\n```typescript\nline two CHANGED\nline three\n```\n\n📁");
	expect(attached).toContain("📁 @folder:src (");
	expect(attached).toContain("src/\n- deep/\n  - y.md (2 lines)\n- x.ts (2 lines)");
	expect(attached).toContain("🧾 git diff (");
	expect(attached).toContain("+line two CHANGED");
	expect(attached).toContain("🧾 git diff --staged (");
	expect(attached).toContain("+export const staged = true;");
	expect(attached).toContain("🧾 git log -1 -p (");
	expect(attached).toContain("first commit");
});

test("security: paths outside the workspace, symlinks out of it, credential files, .env and the data dir are refused with warnings and never inlined", async () => {
	const home = join(repo, "fakehome");
	mkdirSync(join(home, ".ssh"), { recursive: true });
	writeFileSync(join(home, ".ssh", "id_rsa"), "PRIVATE-KEY\n");
	writeFileSync(join(repo, ".env"), "TOKEN=ENV-SECRET\n");
	writeFileSync(join(repo, ".env.example"), "TOKEN=placeholder\n");
	mkdirSync(join(repo, "data"), { recursive: true });
	writeFileSync(join(repo, "data", "auth.json"), "{\"key\":\"AUTH-SECRET\"}\n");
	symlinkSync(outside, join(repo, "escape.txt"));
	const message = `@file:../outside.txt @file:${outside} @file:escape.txt @file:fakehome/.ssh/id_rsa @file:.env @file:data/auth.json @folder:../ @file:.env.example`;
	const result = await expandContextReferences(message, options({ home, blockedDirs: [join(repo, "data")] }));
	for (const secret of ["OUTSIDE-SECRET", "PRIVATE-KEY", "ENV-SECRET", "AUTH-SECRET"]) expect(result.message).not.toContain(secret);
	expect(result.warnings).toEqual([
		"@file:../outside.txt: path is outside the allowed workspace",
		`@file:${outside}: path is outside the allowed workspace`,
		"@file:escape.txt: path is outside the allowed workspace",
		"@file:fakehome/.ssh/id_rsa: path is a sensitive credential file and cannot be attached",
		"@file:.env: path is a sensitive credential file and cannot be attached",
		"@file:data/auth.json: path is a sensitive credential file and cannot be attached",
		"@folder:../: path is outside the allowed workspace",
	]);
	expect(result.message).toContain("--- Context Warnings ---\n- @file:../outside.txt: path is outside the allowed workspace");
	expect(result.message).toContain("TOKEN=placeholder");
	expect((await expandContextReferences("@file:missing.ts @folder:a.ts", options())).warnings).toEqual(["@file:missing.ts: file not found", "@folder:a.ts: path is not a folder"]);
});

test("limits: binary and oversized files become on-disk pointers, 25% warns, 50% refuses and sends the original, at most 16 references", async () => {
	writeFileSync(join(repo, "blob.dat"), Buffer.from([1, 0, 2, 3]));
	writeFileSync(join(repo, "big.txt"), "x".repeat(2000));
	writeFileSync(join(repo, "p1.txt"), "p".repeat(300));
	writeFileSync(join(repo, "p2.txt"), "q".repeat(300));
	writeFileSync(join(repo, "p3.txt"), "r".repeat(380));
	const pointers = await expandContextReferences("@file:blob.dat @file:big.txt", options({ contextWindow: 800 }));
	expect(pointers.message).toContain(`📎 @file:blob.dat (binary file, 4 B) — binary file, not inlined as text. It is available on disk at \`${join(repo, "blob.dat")}\``);
	expect(pointers.message).toContain("📎 @file:big.txt (text file, approximately 500 tokens, 2.0 KB) — too large to inline safely.");
	expect(pointers.message).not.toContain("xxxx");

	const soft = await expandContextReferences("@file:p3.txt", options({ contextWindow: 400 }));
	expect(soft.blocked).toBe(false);
	expect(soft.warnings[0]).toMatch(/^@ context injection warning: \d+ tokens exceeds the 25% soft limit \(100\)\.$/);
	expect(soft.message).toContain("r".repeat(380));

	const hard = await expandContextReferences("compare @file:p1.txt @file:p2.txt", options({ contextWindow: 200 }));
	expect(hard.blocked).toBe(true);
	expect(hard.message).toBe("compare @file:p1.txt @file:p2.txt");
	expect(hard.warnings.at(-1)).toMatch(/^@ context injection refused: \d+ tokens exceeds the 50% hard limit \(100\)\.$/);

	const many = await expandContextReferences(Array.from({ length: 17 }, () => "@staged").join(" "), options());
	expect(many.warnings).toEqual(["@staged: not expanded (maximum 16 @-references per message)"]);
});

test("workspace entries: git's tracked and untracked-not-ignored files relative to cwd, folders derived, sizes attached", async () => {
	writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
	writeFileSync(join(repo, "ignored.log"), "noise\n");
	const entries = await listWorkspaceEntries(repo);
	const paths = entries.map((entry) => `${entry.path}${entry.dir ? "/" : ""}`);
	expect(paths).toContain("src/");
	expect(paths).toContain("src/deep/");
	expect(paths).toContain("src/x.ts");
	expect(paths).toContain("b.ts");
	expect(paths).not.toContain("ignored.log");
	expect(entries.find((entry) => entry.path === "src/x.ts")?.size).toBe(20);
});

const ENTRIES: readonly WorkspaceEntry[] = [
	{ path: "src", dir: true }, { path: "src/tui", dir: true },
	{ path: "src/tui/slash.ts", dir: false, size: 2048 }, { path: "src/tui/app.ts", dir: false, size: 100 }, { path: "my notes.md", dir: false, size: 5 },
];
const source = (): SlashSource & { files(): Promise<readonly WorkspaceEntry[]> } => ({ commands: () => [], arguments: async () => [], files: async () => ENTRIES });
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("menu: `@` lists the kinds then workspace paths with sizes; `@file:` narrows to files, `@folder:` to folders; accept replaces the token and never submits", async () => {
	const menu = new SlashMenu(source());
	menu.refresh("", -1, "look at @", 9);
	expect(menu.matches.map((row) => row.display)).toEqual(["@diff", "@staged", "@file:", "@folder:", "@git:"]);
	await flush();
	expect(menu.matches.map((row) => row.display)).toEqual(["@diff", "@staged", "@file:", "@folder:", "@git:", "src/", "src/tui/", "src/tui/slash.ts", "src/tui/app.ts", "my notes.md"]);
	expect(menu.matches.find((row) => row.display === "src/tui/slash.ts")?.description).toBe("2.0 KB");

	menu.refresh("", -1, "look at @file:sla", 17);
	expect(menu.matches.map((row) => row.display)).toEqual(["src/tui/slash.ts"]);
	expect(menu.accept(true)).toEqual({ text: "@file:src/tui/slash.ts ", submit: false, replace: 9 });
	menu.refresh("", -1, "@folder:", 8);
	expect(menu.matches.map((row) => row.insert)).toEqual(["@folder:src ", "@folder:src/tui "]);
	menu.refresh("", -1, "@notes", 6);
	expect(menu.matches.map((row) => row.insert)).toEqual(["@file:`my notes.md` "]);
	menu.refresh("", -1, "mail@x", 6);
	expect(menu.open).toBe(false);
	menu.refresh("", -1, "@git:", 5);
	expect(menu.open).toBe(false);
});

class StubTerminal implements Terminal {
	constructor(readonly columns: number, readonly rows: number) {}
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

test("prompt box: on the second line of a draft `@sl` + Tab swaps only the token for `@file:…`, Enter on a reference row does not submit, Esc closes it", async () => {
	const prompt = new PromptBox(new TuiAltScreen(new StubTerminal(120, 40), false));
	prompt.focused = true;
	prompt.menu = new SlashMenu(source());
	const submitted: string[] = [];
	prompt.onSubmit = (text) => submitted.push(text);
	prompt.setText("first line\nsee ");
	for (const char of "@sl") prompt.handleInput(char);
	await flush();
	prompt.refreshMenu();
	expect(prompt.menuOpen).toBe(true);
	expect(prompt.menu.matches[0]?.display).toBe("src/tui/slash.ts");
	prompt.handleInput("\t");
	expect(prompt.getText()).toBe("first line\nsee @file:src/tui/slash.ts ");
	expect(prompt.menuOpen).toBe(false);
	for (const char of "and @app") prompt.handleInput(char);
	await flush();
	prompt.refreshMenu();
	prompt.handleInput("\r");
	expect(submitted).toEqual([]);
	expect(prompt.getText()).toBe("first line\nsee @file:src/tui/slash.ts and @file:src/tui/app.ts ");
	prompt.handleInput("@");
	expect(prompt.menuOpen).toBe(true);
	prompt.handleInput("\x1b");
	expect(prompt.menuOpen).toBe(false);
	expect(prompt.getText()).toBe("first line\nsee @file:src/tui/slash.ts and @file:src/tui/app.ts @");
});
