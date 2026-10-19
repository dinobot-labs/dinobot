import { afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManifestConflictError, readManifestSnapshot, replaceManifest, sha256Hex } from "../src/setup/manifest-file.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const tempDir = async () => { const dir = await mkdtemp(join(tmpdir(), "dinobot-manifest-file-")); dirs.push(dir); return dir; };
const create = async (path: string, text: string, mode: number) => { await writeFile(path, text, { mode }); await chmod(path, mode); };

test("sha256Hex hashes UTF-8 bytes as lowercase hex", () => {
	expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	expect(sha256Hex("é")).toBe(new Bun.CryptoHasher("sha256").update(new TextEncoder().encode("é")).digest("hex"));
});

test("readManifestSnapshot returns the text and its hash", async () => {
	const dir = await tempDir();
	const path = join(dir, "dinobot.yaml");
	await create(path, "\ufeffbot: 1 # ✓\n", 0o600);
	const snapshot = await readManifestSnapshot(path);
	expect(snapshot.text).toBe("\ufeffbot: 1 # ✓\n");
	expect(snapshot.sha256).toBe(sha256Hex(snapshot.text));
	await writeFile(path, new Uint8Array([0x61, 0xff, 0x0a]));
	await expect(readManifestSnapshot(path)).rejects.toThrow();
});

test("success writes .bak with the old bytes, the new content, and preserves the mode", async () => {
	const dir = await tempDir();
	const path = join(dir, "dinobot.yaml");
	await create(path, "old: 1\n", 0o640);
	const before = await readManifestSnapshot(path);
	const after = await replaceManifest(path, "new: 2\n", before.sha256);
	expect(after).toEqual({ text: "new: 2\n", sha256: sha256Hex("new: 2\n") });
	expect(await readFile(path, "utf8")).toBe("new: 2\n");
	expect(await readFile(`${path}.bak`, "utf8")).toBe("old: 1\n");
	expect((await stat(path)).mode & 0o777).toBe(0o640);
	expect((await stat(`${path}.bak`)).mode & 0o777).toBe(0o640);
	expect((await readdir(dir)).sort()).toEqual(["dinobot.yaml", "dinobot.yaml.bak"]);
	// A second replacement chains on the returned snapshot and refreshes the backup.
	await replaceManifest(path, "third: 3\n", after.sha256);
	expect(await readFile(`${path}.bak`, "utf8")).toBe("new: 2\n");
	expect(await readFile(path, "utf8")).toBe("third: 3\n");
});

test("a stale hash is a conflict: nothing changes and no .bak is written", async () => {
	const dir = await tempDir();
	const path = join(dir, "dinobot.yaml");
	await create(path, "old: 1\n", 0o600);
	const snapshot = await readManifestSnapshot(path);
	await writeFile(path, "edited: by someone else\n");
	await expect(replaceManifest(path, "new: 2\n", snapshot.sha256)).rejects.toBeInstanceOf(ManifestConflictError);
	expect(await readFile(path, "utf8")).toBe("edited: by someone else\n");
	expect(await readdir(dir)).toEqual(["dinobot.yaml"]);
});

test("a conflict with an existing .bak leaves the .bak untouched", async () => {
	const dir = await tempDir();
	const path = join(dir, "dinobot.yaml");
	await create(path, "old: 1\n", 0o600);
	await create(`${path}.bak`, "older: 0\n", 0o600);
	await expect(replaceManifest(path, "new: 2\n", sha256Hex("something else"))).rejects.toBeInstanceOf(ManifestConflictError);
	expect(await readFile(path, "utf8")).toBe("old: 1\n");
	expect(await readFile(`${path}.bak`, "utf8")).toBe("older: 0\n");
	expect((await readdir(dir)).sort()).toEqual(["dinobot.yaml", "dinobot.yaml.bak"]);
});

test("backup:false leaves an existing .bak untouched and creates none", async () => {
	const dir = await tempDir();
	const path = join(dir, "dinobot.yaml");
	await create(path, "old: 1\n", 0o600);
	await replaceManifest(path, "new: 2\n", sha256Hex("old: 1\n"), { backup: false });
	expect(await readFile(path, "utf8")).toBe("new: 2\n");
	expect(await readdir(dir)).toEqual(["dinobot.yaml"]);
	await create(`${path}.bak`, "keep\n", 0o600);
	await replaceManifest(path, "newer: 3\n", sha256Hex("new: 2\n"), { backup: false });
	expect(await readFile(`${path}.bak`, "utf8")).toBe("keep\n");
	expect((await readdir(dir)).sort()).toEqual(["dinobot.yaml", "dinobot.yaml.bak"]);
});

test("a symlinked manifest: the target is replaced and the link is kept", async () => {
	const dir = await tempDir();
	const real = join(dir, "real");
	await mkdir(real);
	const target = join(real, "dinobot.yaml");
	const link = join(dir, "dinobot.yaml");
	await create(target, "old: 1\n", 0o640);
	await symlink(target, link);
	await replaceManifest(link, "new: 2\n", sha256Hex("old: 1\n"));
	expect((await lstat(link)).isSymbolicLink()).toBe(true);
	expect(await readlink(link)).toBe(target);
	expect(await readFile(target, "utf8")).toBe("new: 2\n");
	expect((await stat(target)).mode & 0o777).toBe(0o640);
	expect(await readFile(`${link}.bak`, "utf8")).toBe("old: 1\n");
	expect(await readdir(real)).toEqual(["dinobot.yaml"]);
	expect((await readdir(dir)).sort()).toEqual(["dinobot.yaml", "dinobot.yaml.bak", "real"]);
});

test("a write racing in after the first check is detected before the rename", async () => {
	const dir = await tempDir();
	const path = join(dir, "dinobot.yaml");
	await create(path, "old: 1\n", 0o600);
	const realOpen = fsp.open;
	// Another writer edits the manifest right after the new content's temp file is created.
	const spy = spyOn(fsp, "open").mockImplementation((async (file: Parameters<typeof fsp.open>[0], flags?: string, mode?: number) => {
		const handle = await realOpen(file, flags, mode);
		if (flags === "wx" && !String(file).includes(".bak")) writeFileSync(path, "racer: 1\n");
		return handle;
	}) as typeof fsp.open);
	try {
		await expect(replaceManifest(path, "new: 2\n", sha256Hex("old: 1\n"))).rejects.toBeInstanceOf(ManifestConflictError);
	} finally {
		spy.mockRestore();
	}
	expect(await readFile(path, "utf8")).toBe("racer: 1\n");
	// The backup was taken at the first (passing) check; the temp file is gone.
	expect(await readFile(`${path}.bak`, "utf8")).toBe("old: 1\n");
	expect((await readdir(dir)).sort()).toEqual(["dinobot.yaml", "dinobot.yaml.bak"]);
});

test("a missing file fails without leaving anything behind", async () => {
	const dir = await tempDir();
	await expect(replaceManifest(join(dir, "nope.yaml"), "x: 1\n", sha256Hex(""))).rejects.toThrow();
	expect(await readdir(dir)).toEqual([]);
});
