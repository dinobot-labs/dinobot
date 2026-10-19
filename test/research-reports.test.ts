import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashResearchBytes } from "../src/core/research-experiments.ts";
import { projectResearchReport, readResearchReport, type ResearchReport } from "../src/core/research-reports.ts";

// Observed symlinks are rejected; parent directories are trusted not to race replacements.
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
	const path = await mkdtemp(join(tmpdir(), "research-reports-"));
	roots.push(path);
	return path;
}
function report(root: string, overrides: Partial<ResearchReport> = {}): ResearchReport {
	return {
		root,
		missionId: "latency-123",
		directory: ".dinobot/research/latency-123",
		revision: 1,
		report: "# Report\nBounded fixture claim.\n",
		evidence: "# Evidence\nFixture observations only.\n",
		maxBytes: 4096,
		...overrides,
	};
}
async function bytes(input: ResearchReport, filename: string) {
	return readFile(join(input.root, input.directory, filename), "utf8");
}

test("same mission identity projects independently into two actual roots and rejects stale revisions", async () => {
	const a = report(await root(), { report: "project A report\n", evidence: "project A evidence\n" });
	const b = report(await root(), { report: "project B report\n", evidence: "project B evidence\n" });
	for (const input of [a, b]) {
		expect(await projectResearchReport(input)).toEqual({
			directory: input.directory,
			revision: 1,
			bytes: Buffer.byteLength(input.report + input.evidence),
		});
		expect(await bytes(input, "report.md")).toBe(input.report);
		expect(await readResearchReport(input.root, input.directory, "evidence.md")).toBe(input.evidence);
	}
	const next = { ...a, revision: 2, report: "project A revised\n" };
	await projectResearchReport(next);
	await expect(projectResearchReport(a)).rejects.toThrow("Stale research report revision");
	expect(await bytes(a, "report.md")).toBe(next.report);
	expect(await bytes(b, "report.md")).toBe(b.report);
	expect(JSON.parse(await bytes(a, "ownership.json")).revision).toBe(2);
	expect(JSON.parse(await bytes(b, "ownership.json")).revision).toBe(1);
});

test("foreign ownership and user modifications are preserved rather than overwritten", async () => {
	const input = report(await root());
	await projectResearchReport(input);
	const markerPath = join(input.root, input.directory, "ownership.json");
	const marker = await bytes(input, "ownership.json");
	const foreign = JSON.stringify({ ...JSON.parse(marker), missionId: "someone-else" });
	await writeFile(markerPath, foreign);
	await expect(projectResearchReport({ ...input, revision: 2 })).rejects.toThrow("foreign or invalid ownership");
	expect(await bytes(input, "ownership.json")).toBe(foreign);
	expect(await bytes(input, "report.md")).toBe(input.report);
	await writeFile(markerPath, marker);
	await writeFile(join(input.root, input.directory, "evidence.md"), "user edited evidence\n");
	await expect(projectResearchReport({ ...input, revision: 2, report: "new report\n" })).rejects.toThrow(
		"modified outside its projection owner",
	);
	expect(await bytes(input, "evidence.md")).toBe("user edited evidence\n");
	expect(await bytes(input, "report.md")).toBe(input.report);
	expect(await bytes(input, "ownership.json")).toBe(marker);
});

test("existing unowned directories cannot be adopted or overwrite their user files", async () => {
	const input = report(await root());
	await mkdir(join(input.root, input.directory), { recursive: true });
	await writeFile(join(input.root, input.directory, "report.md"), "unowned report\n");
	await expect(projectResearchReport(input)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await bytes(input, "report.md")).toBe("unowned report\n");
	expect(await readdir(join(input.root, input.directory))).toEqual(["report.md"]);
});

test("partial projection replay accepts exact next bytes and publishes a consistent marker", async () => {
	const input = report(await root());
	await projectResearchReport(input);
	const oldMarker = await bytes(input, "ownership.json");
	const next = {
		...input,
		revision: 2,
		report: "next report\n",
		evidence: "next evidence\n",
		experiments: "experiment receipt\n",
		patch: "candidate patch\n",
	};
	// Model a crash after durable intent and one file replacement, before final publication.
	await writeFile(
		join(input.root, input.directory, "ownership.json"),
		JSON.stringify({
			...JSON.parse(oldMarker),
			pending: {
				revision: 2,
				hashes: {
					"report.md": hashResearchBytes(next.report),
					"evidence.md": hashResearchBytes(next.evidence),
					"experiments.md": hashResearchBytes(next.experiments),
					"candidate.patch": hashResearchBytes(next.patch),
				},
			},
		}),
	);
	await writeFile(join(input.root, input.directory, "report.md"), next.report);
	await projectResearchReport(next);
	const marker = await bytes(input, "ownership.json");
	expect(JSON.parse(marker).revision).toBe(2);
	for (
		const [filename, content] of [["report.md", next.report], ["evidence.md", next.evidence], ["experiments.md", next.experiments], [
			"candidate.patch",
			next.patch,
		]] as const
	) {
		expect(await bytes(input, filename!)).toBe(content);
	}
	await projectResearchReport(next);
	expect(await bytes(input, "ownership.json")).toBe(marker);
	expect((await readdir(join(input.root, input.directory))).sort()).toEqual([
		"candidate.patch",
		"evidence.md",
		"experiments.md",
		"ownership.json",
		"report.md",
	]);
});

test.each([2, 3])("pending projection repairs changed failure metadata at revision %i", async (revision) => {
	const input = report(await root());
	await projectResearchReport(input);
	const marker = JSON.parse(await bytes(input, "ownership.json"));
	const partial = JSON.stringify({ evaluations: ["accepted"], report: { state: "pending" } });
	await writeFile(
		join(input.root, input.directory, "ownership.json"),
		JSON.stringify({
			...marker,
			pending: { revision: 2, hashes: { "report.md": hashResearchBytes(partial) } },
		}),
	);
	await writeFile(join(input.root, input.directory, "report.md"), partial);
	const repaired = {
		...input,
		revision,
		report: JSON.stringify({ evaluations: ["accepted"], report: { state: "failed", error: "ENOSPC" } }),
	};
	await projectResearchReport(repaired);
	expect(await bytes(input, "report.md")).toBe(repaired.report);
	expect(JSON.parse(await bytes(input, "ownership.json"))).toMatchObject({
		revision,
		hashes: { "report.md": hashResearchBytes(repaired.report) },
	});
	expect(JSON.parse(await bytes(input, "ownership.json")).pending).toBeUndefined();
});

test("proposed bytes cannot authorize a foreign edit even when retry requests those same bytes", async () => {
	const input = report(await root());
	await projectResearchReport(input);
	await writeFile(join(input.root, input.directory, "report.md"), "foreign bytes");
	await expect(projectResearchReport({ ...input, revision: 2, report: "foreign bytes" })).rejects.toThrow("modified outside");
	expect(await bytes(input, "report.md")).toBe("foreign bytes");
});

test.each([null, { revision: 2, hashes: { "report.md": "not-a-hash" } }, { revision: 2, hashes: { "foreign.txt": "a".repeat(64) } }])(
	"invalid pending ownership fails closed: %j",
	async (pending) => {
		const input = report(await root());
		await projectResearchReport(input);
		const owner = JSON.parse(await bytes(input, "ownership.json"));
		await writeFile(join(input.root, input.directory, "ownership.json"), JSON.stringify({ ...owner, pending }));
		await expect(projectResearchReport({ ...input, revision: 2 })).rejects.toThrow("invalid ownership");
		expect(await bytes(input, "report.md")).toBe(input.report);
	},
);

test.each(["parent", "leaf", "marker"] as const)(
	"rejects observed %s symlinks for projection without altering external bytes",
	async (kind) => {
		const input = report(await root());
		const outside = await root();
		const target = join(outside, "valuable.txt");
		await writeFile(target, "external original\n");
		if (kind === "parent") {
			await symlink(outside, join(input.root, ".dinobot"));
		} else {
			await projectResearchReport(input);
			const filename = kind === "leaf" ? "report.md" : "ownership.json";
			await rm(join(input.root, input.directory, filename));
			await symlink(target, join(input.root, input.directory, filename));
		}
		await expect(projectResearchReport({ ...input, revision: 2 })).rejects.toThrow("symlink");
		expect(await readFile(target, "utf8")).toBe("external original\n");
	},
);

test("byte budgets count UTF-8 across artifacts before creating folders or replacing prior projections", async () => {
	const input = report(await root(), { report: "한", evidence: "글", maxBytes: 5 });
	await expect(projectResearchReport(input)).rejects.toThrow("artifact byte budget");
	await expect(stat(join(input.root, ".dinobot"))).rejects.toMatchObject({ code: "ENOENT" });
	await projectResearchReport({ ...input, maxBytes: 6 });
	const marker = await bytes(input, "ownership.json");
	await expect(projectResearchReport({ ...input, maxBytes: 6, revision: 2, experiments: "x" })).rejects.toThrow("artifact byte budget");
	expect(await bytes(input, "report.md")).toBe("한");
	expect(await bytes(input, "ownership.json")).toBe(marker);
	await expect(readResearchReport(input.root, input.directory, "report.md", 2)).rejects.toThrow("bounded regular file");
	expect(await readResearchReport(input.root, input.directory, "report.md", 3)).toBe("한");
});

test("projection and contained reads strip terminal controls, while patch storage retains exact bytes", async () => {
	const controlText = "\x1b[31mred\x1b[0m\x1b]0;hidden title\x07\0\x7f\nline\tend";
	const safe = "red\nline\tend";
	const input = report(await root(), { report: controlText, evidence: "evidence", patch: controlText });
	await projectResearchReport(input);
	expect(await bytes(input, "report.md")).toBe(safe);
	expect(await bytes(input, "candidate.patch")).toBe(controlText);
	expect(await readResearchReport(input.root, input.directory, "candidate.patch")).toBe(safe);
	// The read path also sanitizes externally supplied bytes, independently of projection.
	await writeFile(join(input.root, input.directory, "evidence.md"), controlText);
	expect(await readResearchReport(input.root, input.directory, "evidence.md")).toBe(safe);
});

test("contained reads reject arbitrary links, observed leaf/parent symlinks and non-files", async () => {
	const input = report(await root());
	await projectResearchReport(input);
	for (
		const [directory, filename] of [
			["../outside", "report.md"],
			[".dinobot/research/../../outside", "report.md"],
			[input.directory, "../ownership.json"],
			[input.directory, "ownership.json"],
			[input.directory, "/etc/passwd"],
		] as const
	) {
		await expect(readResearchReport(input.root, directory, filename)).rejects.toThrow("Invalid research report link");
	}
	const outside = await root();
	await writeFile(join(outside, "secret"), "outside secret");
	await rm(join(input.root, input.directory, "report.md"));
	await symlink(join(outside, "secret"), join(input.root, input.directory, "report.md"));
	await expect(readResearchReport(input.root, input.directory, "report.md")).rejects.toThrow("symlink");
	await mkdir(join(input.root, input.directory, "experiments.md"));
	await expect(readResearchReport(input.root, input.directory, "experiments.md")).rejects.toThrow("bounded regular file");
	const linkedRoot = await root();
	await symlink(join(input.root, ".dinobot"), join(linkedRoot, ".dinobot"));
	await expect(readResearchReport(linkedRoot, input.directory, "evidence.md")).rejects.toThrow("symlink");
});
