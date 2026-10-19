import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hashResearchBytes, researchContainedPath } from "./research-experiments.ts";

export type ResearchReport = {
	missionId: string;
	revision: number;
	root: string;
	directory: string;
	report: string;
	evidence: string;
	experiments?: string;
	patch?: string;
	maxBytes: number;
};
type Ownership = {
	missionId: string;
	revision: number;
	hashes: Record<string, string>;
	pending?: { revision: number; hashes: Record<string, string> };
};
const MARKER = "ownership.json";
const filenames = ["report.md", "evidence.md", "experiments.md", "candidate.patch"] as const;

function validHashes(value: unknown): value is Record<string, string> {
	return !!value && typeof value === "object" && !Array.isArray(value) &&
		Object.entries(value).every(([name, hash]) =>
			(filenames as readonly string[]).includes(name) && typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)
		);
}

export function safeResearchText(text: string): string {
	return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(
		/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,
		"",
	);
}

async function atomicFile(root: string, target: string, content: string): Promise<void> {
	await researchContainedPath(root, target, true);
	const temporary = join(dirname(target), `.projection-${randomUUID()}`);
	await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
	try {
		await researchContainedPath(root, target, true);
		await rename(temporary, target);
	} finally {
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}

/** Managed human-readable projection, never the mission's source of truth.
 * Parents are trusted not to race symlink replacements; this is not a sandbox.
 */
export async function projectResearchReport(input: ResearchReport): Promise<{ directory: string; revision: number; bytes: number }> {
	if (
		!/^[a-zA-Z0-9_-]{1,128}$/.test(input.missionId) || !Number.isSafeInteger(input.revision) || input.revision < 0 ||
		!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1
	) throw new Error("Invalid research projection identity/budget");
	const expected = `.dinobot/research/${input.missionId}`;
	if (input.directory !== expected) throw new Error("Research report directory must match its mission identity");
	const dir = await researchContainedPath(input.root, input.directory, true);
	const entries: [string, string][] = [["report.md", input.report], ["evidence.md", input.evidence]];
	if (input.experiments !== undefined) entries.push(["experiments.md", input.experiments]);
	if (input.patch !== undefined) entries.push(["candidate.patch", input.patch]);
	const sanitized = entries.map(([name, content]) => [name, name.endsWith(".md") ? safeResearchText(content) : content] as const);
	const bytes = sanitized.reduce((sum, [, content]) => sum + Buffer.byteLength(content), 0);
	if (bytes > input.maxBytes) throw new Error("Research report exceeds artifact byte budget");
	await mkdir(dirname(dir), { recursive: true });
	await researchContainedPath(input.root, dir, true);
	let created = false;
	try {
		await mkdir(dir);
		created = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const marker = await researchContainedPath(input.root, join(dir, MARKER), true);
	let owner: Ownership;
	if (created) {
		owner = { missionId: input.missionId, revision: -1, hashes: {} };
		await writeFile(marker, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
	} else {
		owner = JSON.parse(await readFile(marker, "utf8")) as Ownership;
		if (
			!owner || owner.missionId !== input.missionId || !Number.isSafeInteger(owner.revision) || owner.revision < -1 ||
			!validHashes(owner.hashes) || (owner.pending !== undefined &&
				(!owner.pending || !Number.isSafeInteger(owner.pending.revision) || owner.pending.revision < owner.revision ||
					!validHashes(owner.pending.hashes)))
		) {
			throw new Error("Research directory has foreign or invalid ownership");
		}
	}
	if (Math.max(owner.revision, owner.pending?.revision ?? -1) > input.revision) throw new Error("Stale research report revision");
	const nextHashes = Object.fromEntries(sanitized.map(([name, content]) => [name, hashResearchBytes(content)]));
	const presentHashes: Record<string, string> = {};
	for (const name of filenames) {
		const path = await researchContainedPath(input.root, join(dir, name), true);
		try {
			const stat = await lstat(path);
			if (!stat.isFile() || stat.size > input.maxBytes) throw new Error("Unexpected research report file");
			const hash = hashResearchBytes(await readFile(path, "utf8"));
			// Only durable ownership, never the caller's proposed bytes, authorizes replacement.
			if (hash !== owner.hashes[name] && hash !== owner.pending?.hashes[name]) {
				throw new Error("Research report was modified outside its projection owner");
			}
			presentHashes[name] = hash;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	// Checkpoint verified present bytes before superseding an interrupted generation.
	// A crash after this marker still recognizes every old partial file on disk.
	await atomicFile(
		input.root,
		marker,
		JSON.stringify({
			missionId: input.missionId,
			revision: owner.revision,
			hashes: presentHashes,
			pending: { revision: input.revision, hashes: nextHashes },
		}),
	);
	for (const [name, content] of sanitized) await atomicFile(input.root, join(dir, name), content);
	await atomicFile(
		input.root,
		marker,
		JSON.stringify({ missionId: input.missionId, revision: input.revision, hashes: { ...presentHashes, ...nextHashes } }),
	);
	return { directory: input.directory, revision: input.revision, bytes };
}

export async function readResearchReport(root: string, directory: string, filename: string, maxBytes = 1024 * 1024): Promise<string> {
	if (!(filenames as readonly string[]).includes(filename) || !/^\.dinobot\/research\/[a-zA-Z0-9_-]{1,128}$/.test(directory)) {
		throw new Error("Invalid research report link");
	}
	const path = await researchContainedPath(root, join(directory, filename));
	const info = await lstat(path);
	if (!info.isFile() || info.size > maxBytes) throw new Error("Research report is not a bounded regular file");
	return safeResearchText(await readFile(path, "utf8"));
}
