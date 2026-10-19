import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context, withCancel } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, StorageRejected, type Storage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { regressed, successRate, SkillStore, SkillsDoc, type SkillPackage } from "../src/core/skills/store.ts";

const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.close(context);
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const original: SkillPackage = {
	name: "example", description: "Original description", body: "Original body\n", source: "bundled:example",
	files: { "guide/a.txt": "original file\n", "removed.txt": "restore me" },
	originalSkillMd: "---\nname: example\ndescription: Original description\ncustom: retained\n---\nOriginal body\n",
};
async function setup(storage: Storage = new MemoryStorage()) {
	const faux = fauxProvider({ provider: "faux", models: [{ id: "one" }] });
	const models = createModels(); models.setProvider(faux.provider);
	const harness = await Harness.open(storage, { models, registry: createRegistry(), env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }) }, context);
	harnesses.push(harness);
	return { harness, store: new SkillStore(harness) };
}
function edit(generation: number, requestId: string, body = "Edited body") {
	return { name: "example", description: "Edited description", body, files: { "guide/a.txt": "edited file", "new.txt": "new" }, expectedGeneration: generation, requestId };
}
async function publish(store: SkillStore, proposalId: string, requestId: string) {
	return store.publish({ proposalId, requestId }, "agent", context);
}

test("staging automatically approves the immutable package without activation and reject revokes it", async () => {
	const { store } = await setup();
	await store.initialize([original], context);
	const before = await store.load("example", undefined, context);
	const input = edit(1, "edit-1");
	const { proposalId } = await store.propose(input, "agent", context);
	input.files["guide/a.txt"] = "mutated caller object";
	expect(await store.load("example", undefined, context)).toEqual(before);
	const diff = await store.diff(proposalId, context);
	expect(diff.before).toEqual(original);
	expect(diff.after.files["guide/a.txt"]).toBe("edited file");
	expect(diff.after.source).toBe(original.source);
	expect(diff.after.originalSkillMd).toBe(original.originalSkillMd);
	expect(diff.status).toBe("approved");
	expect(diff.approval).toEqual({ actor: "system:auto", proposalId, version: diff.version, expectedGeneration: 1 });
	await store.reject(proposalId, "user", context);
	expect((await store.diff(proposalId, context)).approval).toBeNull();
	await expect(store.publish({ proposalId, requestId: "publish-1" }, "agent", context)).rejects.toThrow("approval");
	expect(await store.pending(context)).toEqual([]);
	expect(await store.load("example", undefined, context)).toEqual(before);
});

test("CAS fences stale edits, automatically approved concurrent writers and ABA", async () => {
	const { store, harness } = await setup();
	const other = new SkillStore(harness);
	await store.initialize([original], context);
	const initial = await store.load("example", undefined, context);
	const a = await store.propose(edit(1, "a"), "agent-a", context);
	const b = await other.propose(edit(1, "b", "Writer B"), "agent-b", context);
	const c = await other.propose(edit(1, "c", "Writer C"), "agent-c", context);
	const results = await Promise.allSettled([
		store.publish({ proposalId: a.proposalId, requestId: "pa" }, "agent-a", context),
		other.publish({ proposalId: b.proposalId, requestId: "pb" }, "agent-b", context),
	]);
	expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
	expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
	await expect(store.propose(edit(1, "stale"), "agent", context)).rejects.toThrow("generation conflict");
	await expect(store.publish({ proposalId: c.proposalId, requestId: "pc" }, "agent-c", context)).rejects.toThrow("generation conflict");
	const restore = await store.restore({ name: "example", version: initial.version, expectedGeneration: 2, requestId: "restore" }, "agent", context);
	await publish(store, restore.proposalId, "restore-publish");
	const restored = await store.load("example", undefined, context);
	expect(restored.version).toBe(initial.version);
	expect(restored.generation).toBe(3);
	await expect(store.publish({ proposalId: c.proposalId, requestId: "pc" }, "agent-c", context)).rejects.toThrow("generation conflict");
	expect((await store.history("example", context)).map((item) => item.generation)).toEqual([1, 2, 3]);
});

test("request receipts are store-wide, actor/op/input bound and never reactivate old versions", async () => {
	const { store } = await setup();
	await store.initialize([original], context);
	const input = edit(1, "request");
	const a = await store.propose(input, "agent", context);
	expect(await store.propose({ ...input, files: { "new.txt": "new", "guide/a.txt": "edited file" } }, "agent", context)).toEqual(a);
	await expect(store.propose({ ...input, body: "different" }, "agent", context)).rejects.toThrow("Request ID reused");
	await expect(store.propose(input, "different-actor", context)).rejects.toThrow("Request ID reused");
	await expect(store.publish({ proposalId: a.proposalId, requestId: "request" }, "agent", context)).rejects.toThrow("Request ID reused");
	const receipt = await publish(store, a.proposalId, "publication");
	const b = await store.propose(edit(2, "next", "Latest body"), "agent", context);
	await publish(store, b.proposalId, "next-publication");
	expect(await store.publish({ proposalId: a.proposalId, requestId: "publication" }, "agent", context)).toEqual(receipt);
	expect(await store.propose(input, "agent", context)).toEqual(a);
	expect((await store.load("example", undefined, context)).body).toBe("Latest body");
	await expect(store.publish({ proposalId: a.proposalId, requestId: "new-publication" }, "agent", context)).rejects.toThrow("approval");
	await expect(store.reject(a.proposalId, "user", context)).rejects.toThrow("terminal");
	for (const [requestId, actor] of [["", "agent"], ["valid", " "], [" ", "agent"]]) {
		await expect(store.propose(edit(3, requestId!), actor!, context)).rejects.toThrow("non-empty");
	}
});

test("pinned files and full-package restore preserve metadata, deleted files and original bytes", async () => {
	const { store } = await setup();
	await store.initialize([original, { ...original, name: "second", source: "bundled:second" }], context);
	const initial = await store.load("example", undefined, context);
	const a = await store.propose(edit(1, "edit"), "agent", context);
	const edited = await publish(store, a.proposalId, "publish");
	expect(await store.readFile("example", initial.version, "guide/a.txt", context)).toBe("original file\n");
	expect(await store.readFile("example", edited.version, "guide/a.txt", context)).toBe("edited file");
	await expect(store.readFile("second", initial.version, "guide/a.txt", context)).rejects.toThrow("Unknown skill version");
	await expect(store.readFile("example", edited.version, "removed.txt", context)).rejects.toThrow("Unknown companion");
	const restore = await store.restore({ name: "example", version: initial.version, expectedGeneration: 2, requestId: "restore" }, "agent", context);
	expect(await store.restore({ name: "example", version: initial.version, expectedGeneration: 2, requestId: "restore" }, "agent", context)).toEqual(restore);
	await publish(store, restore.proposalId, "restored");
	expect(await store.load("example", undefined, context)).toEqual({ ...original, version: initial.version, generation: 3 });
	expect((await store.list(context)).find((item) => item.name === "example")?.modified).toBe(false);
});

test("upstream classification advances tracked origin, preserves customization and dedupes restarts", async () => {
	const { harness, store } = await setup();
	await store.initialize([original], context);
	const v2 = { ...original, body: "Upstream two" };
	await store.initialize([v2], context);
	expect((await store.load("example", undefined, context)).generation).toBe(2);
	const editProposal = await store.propose(edit(2, "custom"), "agent", context);
	await publish(store, editProposal.proposalId, "custom-publish");
	const local = await store.load("example", undefined, context);
	await store.initialize([v2], context); // U == B preserves L.
	expect(await store.pending(context)).toHaveLength(0);
	const v3 = { ...original, body: "Upstream three" };
	await store.initialize([v3], context);
	expect(await store.load("example", undefined, context)).toEqual(local);
	const pending = await store.pending(context);
	expect(pending).toHaveLength(1);
	expect(pending[0]?.operation).toBe("upstream");
	expect(pending[0]?.status).toBe("approved");
	expect(pending[0]?.approval?.actor).toBe("system:auto");
	const restarted = new SkillStore(harness);
	await restarted.initialize([v3], context);
	expect(await restarted.pending(context)).toEqual(pending);
	await restarted.reject(pending[0]!.proposalId, "user", context);
	await restarted.initialize([v3], context);
	expect(await restarted.pending(context)).toHaveLength(0);
	const v4 = { ...original, body: "Upstream four" };
	await restarted.initialize([v4], context);
	const upgrade = (await restarted.pending(context))[0]!;
	await publish(restarted, upgrade.proposalId, "upgrade");
	await restarted.initialize([{ ...original, body: "Upstream five" }], context);
	expect((await restarted.load("example", undefined, context)).body).toBe("Upstream five");
	expect((await restarted.list(context))[0]?.modified).toBe(false);
	await restarted.initialize([], context);
	expect(await restarted.list(context)).toHaveLength(1);
});

test("L == U aligns origin without activation and external sources cannot adopt agent skills", async () => {
	const { store } = await setup();
	await store.initialize([original], context);
	const input = edit(1, "custom");
	const a = await store.propose(input, "agent", context);
	await publish(store, a.proposalId, "publish");
	await store.initialize([{ ...original, description: input.description, body: input.body, files: input.files }], context);
	expect((await store.list(context))[0]).toMatchObject({ generation: 2, modified: false });
	expect(await store.pending(context)).toHaveLength(0);
	const created = await store.propose({ ...edit(0, "create"), name: "created" }, "agent", context);
	await publish(store, created.proposalId, "created-publish");
	expect((await store.load("created", undefined, context)).source).toBe("agent");
	await expect(store.initialize([{ ...original, name: "created", source: "external:/skills/created" }], context)).rejects.toThrow("agent-created");
	await expect(store.initialize([{ ...original, source: "external:other" }], context)).rejects.toThrow("identity collision");
});

test("new bundled skill collision preserves the agent package across SQLite restart and explicit publication", async () => {
	const dir = await mkdtemp(join(tmpdir(), "skill-bundle-collision-")); dirs.push(dir);
	const path = join(dir, "skills.sqlite");
	const { store, harness } = await setup(await openNodeSqliteStorage(path));
	const created = await store.propose(edit(0, "create-local"), "agent", context);
	await publish(store, created.proposalId, "publish-local");
	const local = await store.load("example", undefined, context);
	const history = await store.history("example", context);
	await store.initialize([original, { ...original, name: "other", source: "bundled:other" }], context);
	expect(await store.load("example", undefined, context)).toEqual(local);
	expect(await store.history("example", context)).toEqual(history);
	expect(await store.list(context)).toHaveLength(2);
	const pending = await store.pending(context);
	expect(pending).toHaveLength(1);
	expect(await store.diff(pending[0]!.proposalId, context)).toMatchObject({ before: { source: "agent" }, after: original, operation: "upstream" });
	await harness.close(context); harnesses.splice(harnesses.indexOf(harness), 1);
	const { store: restarted } = await setup(await openNodeSqliteStorage(path));
	await restarted.initialize([original], context);
	expect(await restarted.pending(context)).toEqual(pending);
	expect(await restarted.load("example", undefined, context)).toEqual(local);
	await restarted.reject(pending[0]!.proposalId, "user", context);
	await restarted.initialize([original], context);
	expect(await restarted.pending(context)).toHaveLength(0);
	await restarted.initialize([{ ...original, body: "next bundled version" }], context);
	const next = (await restarted.pending(context))[0]!;
	await publish(restarted, next.proposalId, "accept-bundle");
	expect((await restarted.load("example", undefined, context)).source).toBe(original.source);
	expect(await restarted.load("example", local.version, context)).toEqual(local);
});

test("malformed packages, path escapes and byte limits reject without transaction changes", async () => {
	const { store, harness } = await setup();
	await store.initialize([original], context);
	const before = await harness.snapshot(SkillsDoc, context);
	for (const path of ["../x", "/absolute", "a//b", "a/./b", "a/../b", "a\\b", "a\0b", "SKILL.md", "nested/skill.md", "C:/file", "con.txt", "trailing.", "__proto__", "constructor", "prototype", "nested/__proto__"]) {
		await expect(store.propose({ ...edit(1, `path-${path}`), files: { [path]: "bad" } }, "agent", context)).rejects.toThrow();
	}
	for (const pkg of [
		{ ...original, name: "Bad_Name" }, { ...original, name: "a".repeat(65) }, { ...original, description: " " },
		{ ...original, description: "d".repeat(1025) }, { ...original, body: "" },
		{ ...original, body: "é".repeat(128 * 1024 + 1) },
		{ ...original, files: { "file": "x".repeat(256 * 1024 + 1) } },
		{ ...original, files: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`file-${i}`, "x"])) },
		{ ...original, files: Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`file-${i}`, "x".repeat(256 * 1024)])) },
		{ ...original, files: { "a.txt": "one", "A.txt": "two" } },
		{ ...original, originalSkillMd: "x".repeat(256 * 1024 + 1) },
	]) await expect(store.initialize([pkg], context)).rejects.toThrow();
	expect(await harness.snapshot(SkillsDoc, context)).toEqual(before);
	// An error after an earlier package was activated must roll the entire commit back.
	await expect(store.initialize([{ ...original, body: "would change" }, { ...original, name: "example" }], context)).rejects.toThrow("Duplicate");
	await expect(store.initialize([{ ...original, name: "new-skill" }, { ...original, source: "collision" }], context)).rejects.toThrow("collision");
	expect(await harness.snapshot(SkillsDoc, context)).toEqual(before);
});

test("history is immutable to callers and digest corruption fails closed", async () => {
	const { harness, store } = await setup();
	await store.initialize([original], context);
	const initial = await store.load("example", undefined, context);
	initial.files["guide/a.txt"] = "caller mutation";
	const history = await store.history("example", context);
	history[0]!.actor = "caller mutation";
	expect((await store.history("example", context))[0]!.actor).toBe("source");
	expect(await store.readFile("example", initial.version, "guide/a.txt", context)).toBe("original file\n");
	const a = await store.propose(edit(1, "edit"), "agent", context);
	await harness.commit(async (tx) => { (await tx.doc(SkillsDoc)).proposals[0]!.candidate.body = "tampered"; }, context);
	const corrupt = await harness.snapshot(SkillsDoc, context);
	await expect(store.publish({ proposalId: a.proposalId, requestId: "publish" }, "agent", context)).rejects.toThrow("hash/bytes mismatch");
	expect(await harness.snapshot(SkillsDoc, context)).toEqual(corrupt);
	await harness.commit(async (tx) => { (await tx.doc(SkillsDoc)).skills[0]!.versions[0]!.package.body = "tampered"; }, context);
	await expect(store.load("example", initial.version, context)).rejects.toThrow("hash/bytes mismatch");
});

test("SQLite restart retains complete packages, approvals, upstream dedupe and publication receipts", async () => {
	const dir = await mkdtemp(join(tmpdir(), "dinobot-skills-")); dirs.push(dir);
	const path = join(dir, "state.sqlite");
	const first = await setup(await openNodeSqliteStorage(path));
	await first.store.initialize([original], context);
	const initial = await first.store.load("example", undefined, context);
	const a = await first.store.propose(edit(1, "edit"), "agent", context);
	await first.harness.close(context); harnesses.splice(harnesses.indexOf(first.harness), 1);
	const second = await setup(await openNodeSqliteStorage(path));
	const published = await second.store.publish({ proposalId: a.proposalId, requestId: "publish" }, "agent", context);
	const upstream = { ...original, body: "new binary body", files: { "replacement.txt": "new binary file" } };
	await second.store.initialize([upstream], context);
	const pending = await second.store.pending(context);
	await second.harness.close(context); harnesses.splice(harnesses.indexOf(second.harness), 1);
	const third = await setup(await openNodeSqliteStorage(path));
	await third.store.initialize([upstream], context);
	expect(await third.store.pending(context)).toEqual(pending);
	expect(await third.store.readFile("example", initial.version, "guide/a.txt", context)).toBe("original file\n");
	expect((await third.store.load("example", initial.version, context)).originalSkillMd).toBe(original.originalSkillMd);
	expect(await third.store.publish({ proposalId: a.proposalId, requestId: "publish" }, "agent", context)).toEqual(published);
	expect((await third.store.load("example", undefined, context)).version).toBe(published.version);
});

test("serialized store limit refuses growth without pruning or partial receipts", async () => {
	const { store, harness } = await setup();
	await store.initialize([original], context);
	let refused = false;
	for (let i = 0; i < 40; i++) {
		const before = await harness.snapshot(SkillsDoc, context);
		try {
			await store.propose(edit(1, `large-${i}`, "x".repeat(256 * 1024)), "agent", context);
		} catch (error) {
			expect(String(error)).toContain("16 MiB");
			expect(await harness.snapshot(SkillsDoc, context)).toEqual(before);
			refused = true;
			break;
		}
	}
	expect(refused).toBe(true);
	expect(await store.history("example", context)).toHaveLength(1);
	expect((await store.load("example", undefined, context)).body).toBe(original.body);
});

test("storage rejection before commit rolls back activation, version, history, proposal and receipt together", async () => {
	class FailingStorage extends MemoryStorage {
		fail = false;
		override async commit(...args: Parameters<MemoryStorage["commit"]>) {
			if (this.fail) throw new StorageRejected("Injected storage failure before durable effects");
			return super.commit(...args);
		}
	}
	const storage = new FailingStorage();
	const { store, harness } = await setup(storage);
	await store.initialize([original], context);
	const a = await store.propose(edit(1, "edit"), "agent", context);
	const before = await harness.snapshot(SkillsDoc, context);
	storage.fail = true;
	await expect(store.publish({ proposalId: a.proposalId, requestId: "publication" }, "agent", context)).rejects.toThrow("Injected storage failure");
	expect(await harness.snapshot(SkillsDoc, context)).toEqual(before);
	storage.fail = false;
	const result = await store.publish({ proposalId: a.proposalId, requestId: "publication" }, "agent", context);
	expect(result.generation).toBe(2);
	expect(await store.history("example", context)).toHaveLength(2);
});

test("digit-leading names and path boundaries preserve the portable package contract", async () => {
	const { store, harness } = await setup();
	const path = "a".repeat(512);
	await store.initialize([{ ...original, name: "3d-review", files: { [path]: "boundary" } }], context);
	const loaded = await store.load("3d-review", undefined, context);
	expect(await store.readFile("3d-review", loaded.version, path, context)).toBe("boundary");
	const before = await harness.snapshot(SkillsDoc, context);
	for (const files of [
		{ ["a".repeat(513)]: "too long" },
		{ a: "file", "a/b": "nested" },
		{ "A/b": "nested", a: "file" },
		{ constructor: "reserved" },
		JSON.parse('{"__proto__":"reserved"}') as Record<string, string>,
		{ "nested/prototype": "reserved" },
	]) {
		await expect(store.initialize([{ ...original, files }], context)).rejects.toThrow();
		expect(await harness.snapshot(SkillsDoc, context)).toEqual(before);
	}
});

test("pre-cancelled contexts cannot mutate proposals, approvals, receipts or active packages", async () => {
	const { store, harness } = await setup();
	await store.initialize([original], context);
	const approved = await store.propose(edit(1, "approved", "approved body"), "agent", context);
	const current = await store.load("example", undefined, context);
	const before = await harness.snapshot(SkillsDoc, context);
	const cancelled = withCancel(context);
	cancelled.cancel(new Error("cancel skill mutation"));
	const mutations = [
		() => store.initialize([{ ...original, body: "new upstream" }], cancelled.context),
		() => store.propose(edit(1, "cancelled"), "agent", cancelled.context),
		() => store.restore({ name: "example", version: current.version, expectedGeneration: 1, requestId: "cancelled-restore" }, "agent", cancelled.context),
		() => store.reject(approved.proposalId, "user", cancelled.context),
		() => store.publish({ proposalId: approved.proposalId, requestId: "cancelled-publish" }, "agent", cancelled.context),
	];
	for (const mutate of mutations) {
		await expect(mutate()).rejects.toThrow();
		expect(await harness.snapshot(SkillsDoc, context)).toEqual(before);
	}
});

test("all 6 legal two-editor schedules fence duplicate publication from one base", async () => {
	// All interleavings preserving auto-approved stage -> publish within each editor.
	const schedules: number[][] = [];
	function enumerate(prefix: number[], a: number, b: number): void {
		if (a === 2 && b === 2) { schedules.push(prefix); return; }
		if (a < 2) enumerate([...prefix, 0], a + 1, b);
		if (b < 2) enumerate([...prefix, 1], a, b + 1);
	}
	enumerate([], 0, 0);
	expect(schedules).toHaveLength(6);
	for (const schedule of schedules) {
		const { store, harness } = await setup();
		const stores = [store, new SkillStore(harness)];
		await store.initialize([original], context);
		const steps = [0, 0];
		const ids: (string | undefined)[] = [undefined, undefined];
		let publications = 0;
		for (const editor of schedule) {
			const step = steps[editor]!;
			steps[editor] = step + 1;
			const target = stores[editor]!;
			const before = await harness.snapshot(SkillsDoc, context);
			try {
				if (step === 0) {
					ids[editor] = (await target.propose(edit(1, `edit-${editor}`, `editor ${editor}`), `agent-${editor}`, context)).proposalId;
				} else {
					const result = await target.publish({ proposalId: ids[editor] ?? "failed-stage", requestId: `publish-${editor}` }, `agent-${editor}`, context);
					expect(result.generation).toBe(2);
					publications++;
				}
			} catch (error) {
				expect(String(error)).toMatch(/generation conflict|Unknown skill proposal|approval required/);
				expect(await harness.snapshot(SkillsDoc, context)).toEqual(before);
			}
			expect((await store.load("example", undefined, context)).generation).toBe(1 + publications);
			expect(await store.history("example", context)).toHaveLength(1 + publications);
		}
		expect(publications).toBe(1);
		expect((await harness.snapshot(SkillsDoc, context))?.proposals.filter((item) => item.status === "published")).toHaveLength(1);
		await harness.close(context);
		harnesses.splice(harnesses.indexOf(harness), 1);
	}
});

test("regression rule: never below the minimums, monotone in failures, and symmetric baselines never regress", () => {
	const u = (verified: number, blocked: number) => ({ loads: 0, verified, blocked });
	expect(regressed(u(0, 2), u(5, 0))).toBe(false); // n=2 < 3
	expect(regressed(u(2, 1), u(5, 0))).toBe(false); // blocked=1 < 2
	expect(regressed(u(1, 2), u(5, 0))).toBe(true);
	expect(regressed(u(1, 2), u(0, 0))).toBe(true); // unseen predecessor sits at 1/2; 2/5 < 1/2
	expect(regressed(u(3, 2), u(0, 0))).toBe(false); // 4/7 > 1/2
	for (let v = 0; v < 6; v++) for (let b = 0; b < 6; b++) expect(regressed(u(v, b), u(v, b))).toBe(false);
	for (let b = 2; b < 8; b++) if (regressed(u(2, b), u(4, 1))) expect(regressed(u(2, b + 1), u(4, 1))).toBe(true);
	expect(successRate(u(0, 0))).toBe(0.5);
});

test("outcomes score only the versions a conversation loaded, and a measured regression restores the predecessor with evidence", async () => {
	const { store } = await setup();
	await store.initialize([original], context);
	const base = await store.load("example", undefined, context);
	const proposal = await store.propose(edit(base.generation, "evolve", "Evolved body"), "agent:1", context);
	const evolved = await store.publish({ proposalId: proposal.proposalId, requestId: "evolve-pub" }, "agent:1", context);
	const c1 = 101 as never; const c2 = 102 as never; const c3 = 103 as never; const idle = 104 as never;
	// Three conversations load the evolved head; one loads the base explicitly; one conversation never loads anything.
	await store.load("example", undefined, context, c1);
	await store.load("example", undefined, context, c2);
	await store.load("example", undefined, context, c3);
	await store.load("example", base.version, context, c2);
	expect((await store.usage("example", context))[evolved.version]).toEqual({ loads: 3, verified: 0, blocked: 0 });
	expect(await store.recordOutcome(idle, "blocked", context)).toEqual([]);
	expect(await store.recordOutcome(c1, "blocked", context)).toEqual([]); // n=1
	expect((await store.recordOutcome(c1, "blocked", context))).toEqual([]); // already scored: no double counting
	expect((await store.usage("example", context))[evolved.version]).toEqual({ loads: 3, verified: 0, blocked: 1 });
	expect(await store.recordOutcome(c2, "verified", context)).toEqual([]); // evolved: 1/1 → n=2; base: verified 1
	expect((await store.load("example", undefined, context)).version).toBe(evolved.version);
	const regressions = await store.recordOutcome(c3, "blocked", context); // evolved 1 verified / 2 blocked (n=3) vs base 1/0
	expect(regressions).toHaveLength(1);
	expect(regressions[0]).toMatchObject({ name: "example", from: evolved.version, to: base.version, usage: { from: { verified: 1, blocked: 2 }, to: { verified: 1, blocked: 0 } } });
	const head = await store.load("example", undefined, context);
	expect(head.version).toBe(base.version);
	expect(head.body).toBe(original.body);
	const last = (await store.history("example", context)).at(-1)!;
	expect(last).toMatchObject({ actor: "system:regression", operation: "regression", version: base.version, evidence: { kind: "regression", version: evolved.version } });
	// The restored head is not an agent-evolved version, so further failures do not cascade into another restore.
	await store.load("example", undefined, context, c1);
	await store.load("example", undefined, context, c2);
	await store.load("example", undefined, context, c3);
	for (const c of [c1, c2, c3]) expect(await store.recordOutcome(c, "blocked", context)).toEqual([]);
	expect((await store.load("example", undefined, context)).version).toBe(base.version);
	// Agents cannot cite regression evidence themselves.
	const gated = new SkillStore((store as unknown as { harness: Harness }).harness, { evidenceChecked: () => true });
	const again = await gated.propose(edit((await gated.load("example", undefined, context)).generation, "again", "Again"), "agent:1", context);
	await expect(gated.publish({ proposalId: again.proposalId, requestId: "again-pub", evidence: { kind: "regression", version: "x", usage: { from: { loads: 0, verified: 0, blocked: 0 }, to: { loads: 0, verified: 0, blocked: 0 } } } }, "agent:1", context)).rejects.toThrow("produced by the store");
});
