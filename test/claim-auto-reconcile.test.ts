import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openBot, type Bot } from "../src/core/bot.ts";
import { NativeProvenanceDoc, unfenceSettledTx } from "../src/core/claim-cleanup.ts";
import { AUTO_RECONCILE_ACTOR, ClaimReconcileAuditDoc } from "../src/core/claim-reconcile.ts";
import { acquire, type Claim, ClaimsDoc, type ClaimsState, claimOnce, FENCE_RECHECK_MS, overlaps, release, unfence } from "../src/core/claims.ts";

/**
 * ADR 0079: a claim is a lease (holder, TTL/work_release) plus an effect fence (quarantine). Safety: no overlapping
 * grant to another holder while either part holds, and no fence ends without evidence. Liveness: a fence proven by the
 * OS ends without an operator, at the next contention or release, and a waiter is woken to see it.
 */
const NATIVE = "UNKNOWN native process provenance";
const bun = process.execPath.replaceAll("\\", "/");
const outliving = (ms: number) => `"${bun}" -e "await Bun.sleep(${ms});await Bun.write('drained','1')" >/dev/null 2>&1 &`;
const req = (holder: string, key = "repo:x", ttlMs = 1000) => ({ key, holder, intent: "edit", ttlMs });

test("release of a fenced claim ends only its lease; unfence then drops it, never earlier", () => {
	const state: ClaimsState = { nextToken: 1, claims: [] };
	const granted = acquire(state, req("a"), 0);
	if (granted.status !== "granted") throw Error("fixture");
	state.claims[0]!.quarantined = NATIVE;
	expect(release(state, "a", "repo:x", 10)).toEqual([]); // nothing removed while fenced
	expect(state.claims[0]).toMatchObject({ token: 1, expiresAt: 10, quarantined: NATIVE });
	expect(acquire(state, req("b"), 20).status).toBe("conflict"); // fence still excludes others past the lease end
	expect(unfence(state, { key: "repo:x", holder: "a", token: 99 }, 20)).toBeUndefined(); // exact token only
	expect(unfence(state, granted.claim, 20)).toMatchObject({ outcome: "released", claim: { token: 1 } });
	expect(state.claims).toEqual([]);
	expect(acquire(state, req("b"), 20).status).toBe("granted");
	expect(unfence(state, granted.claim, 20)).toBeUndefined(); // idempotent: a vanished token is not touched
});

test("unfence keeps a still-valid lease with its holder, so mutual exclusion is not lost", () => {
	const state: ClaimsState = { nextToken: 1, claims: [] };
	const granted = acquire(state, req("a"), 0);
	if (granted.status !== "granted") throw Error("fixture");
	state.claims[0]!.quarantined = NATIVE;
	expect(unfence(state, granted.claim, 10)).toMatchObject({ outcome: "unfenced" });
	expect(state.claims[0]!.quarantined).toBeUndefined();
	expect(acquire(state, req("b"), 10).status).toBe("conflict");
	expect(acquire(state, req("b"), 1000).status).toBe("granted"); // ordinary TTL resumes
});

test("a waiter behind a fenced blocker re-checks at a bounded interval, never in the past", () => {
	const state: ClaimsState = { nextToken: 1, claims: [] };
	acquire(state, req("a", "repo:x", 40), 0);
	state.claims[0]!.quarantined = NATIVE;
	expect(claimOnce({}, state, { ...req("b"), waitMs: 45_000 }, 100)).toMatchObject({ status: "waiting", retryAt: 100 + FENCE_RECHECK_MS });
	expect(claimOnce({}, state, { ...req("b"), waitMs: 1_000 }, 100)).toMatchObject({ status: "waiting", retryAt: 1_100 }); // deadline first
});

async function withBot(body: (bot: Bot, dir: string, run: (thread: string, steps: [string, Record<string, string | number>][]) => Promise<string>) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), "auto-reconcile-"));
	const models = createModels(); const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] }); models.setProvider(faux.provider);
	const storage = await openNodeSqliteStorage(join(dir, "host.sqlite"));
	try {
		const bot = await openBot({ storage, models, defaultModel: { provider: "faux", modelId: "m" }, workspaceRoot: dir, toolMode: "direct", plugins: [] }, context);
		try {
			// Runs one turn of tool calls in `thread` and returns the text of every tool result, in order.
			const run = async (thread: string, steps: [string, Record<string, string | number>][]) => {
				faux.setResponses([...steps.map(([name, args]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" })), fauxAssistantMessage("done")]);
				const conversation = await bot.conversation("test", thread, context);
				expect((await (await conversation.submit({ type: "input", content: "go" }, context)).wait(context)).status).toBe("done");
				const results: unknown[] = [];
				let cursor: Parameters<typeof conversation.entries>[2];
				do {
					const page = await conversation.entries({}, 100, cursor, context);
					results.push(...page.items.filter(item => (item as { kind?: string }).kind === "pi.tool-result"));
					cursor = page.next;
				} while (cursor);
				return JSON.stringify(results.slice(0, steps.length)); // entries are newest first: this turn's results only
			};
			await body(bot, dir, run);
		} finally { await bot.close(context); }
	} finally { await storage.close(context); Bun.gc(true); await Bun.sleep(200); await rm(dir, { recursive: true, force: true }); }
}
// Hold the real shell descendant beyond the native drain window, then explicitly release it.
// Markers coordinate the fixture only: reconciliation still needs real OS quiescence evidence.
async function withHeldProcess(dir: string, body: (command: string, ready: () => Promise<void>, release: () => Promise<void>) => Promise<void>) {
	const readyPath = join(dir, "ready");
	const releasePath = join(dir, "release");
	await writeFile(join(dir, "held-process.ts"), [
		"import { existsSync, writeFileSync, renameSync } from 'node:fs';",
		"writeFileSync('ready.tmp', String(process.pid)); renameSync('ready.tmp', 'ready');",
		"const deadline = Date.now() + 15000;",
		"while (!existsSync('release') && Date.now() < deadline) await Bun.sleep(10);",
		"await Bun.write('drained', '1');",
	].join("\n"));
	const waitFor = async (predicate: () => boolean) => {
		const deadline = Date.now() + 20000;
		while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
		expect(predicate()).toBe(true);
	};
	const ready = async () => {
		await waitFor(() => existsSync(readyPath));
		expect(existsSync(join(dir, "drained"))).toBe(false);
		const pid = Number(await readFile(readyPath, "utf8"));
		expect(pid).toBeGreaterThan(0);
		expect(() => process.kill(pid, 0)).not.toThrow();
	};
	let released = false;
	const release = async () => {
		if (released) return;
		await writeFile(releasePath, "1");
		if (!existsSync(readyPath)) return; // body may fail before launch
		const pid = Number(await readFile(readyPath, "utf8"));
		expect(pid).toBeGreaterThan(0);
		await waitFor(() => existsSync(join(dir, "drained")));
		await waitFor(() => {
			try { process.kill(pid, 0); return false; }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
		});
		released = true;
	};
	// The shell cannot finish before readiness (or child exit), including on assertion failure.
	const command = `"${bun}" held-process.ts >/dev/null 2>&1 & child=$!; while [ ! -f ready ] && kill -0 "$child" 2>/dev/null; do sleep 0.01; done`;
	try { await body(command, ready, release); }
	finally { await release(); } // never remove the workspace while its owned descendant is live
}
const claims = async (bot: Bot) => (await bot.harness.snapshot(ClaimsDoc, context))!.claims;

test("released-but-fenced claim: refused while the orphan lives, granted to a waiter once the OS proves it exited", () => withBot(async (bot, dir, run) => {
	const first = await run("holder", [["work_claim", { key: "owned:auto", intent: "edit" }], ["bash", { command: outliving(2500) }], ["work_release", { key: "owned:auto" }]]);
	expect(first).toContain("Lease ended but still fenced");
	const fenced = (await claims(bot)).find(c => c.key === "owned:auto")!;
	expect(fenced.quarantined).toBe(NATIVE);
	expect(fenced.expiresAt).toBeLessThanOrEqual(Date.now()); // release ended the lease, the fence keeps it live

	// Safety: the orphan is alive, so contention reconciles nothing and the fence still excludes.
	const refused = await run("contender-now", [["work_claim", { key: "owned:auto", intent: "mine" }]]);
	expect(refused).toContain("Conflict");
	expect(refused).toContain("Automatic quarantine check");
	expect(refused).toContain("alive");
	expect((await claims(bot)).find(c => c.key === "owned:auto")).toMatchObject({ token: fenced.token, quarantined: NATIVE });
	expect((await bot.harness.snapshot(ClaimReconcileAuditDoc, context))?.entries ?? []).toHaveLength(0);

	// Liveness: a bounded wait is granted after the orphan exits, without an operator and without a claim change event.
	const started = Date.now();
	const granted = await run("contender-wait", [["work_claim", { key: "owned:auto", intent: "mine", wait_ms: 20_000 }]]);
	expect(existsSync(join(dir, "drained"))).toBe(true);
	expect(granted).toContain("Claimed owned:auto");
	expect(Date.now() - started).toBeLessThan(20_000);
	const now = (await claims(bot)).filter(c => c.key === "owned:auto");
	expect(now).toHaveLength(1);
	expect(now[0]!.holder).not.toBe(fenced.holder);
	expect(now[0]!.token).toBeGreaterThan(fenced.token);
	const audit = (await bot.harness.snapshot(ClaimReconcileAuditDoc, context))!.entries;
	expect(audit).toHaveLength(1);
	expect(audit[0]).toMatchObject({ actor: AUTO_RECONCILE_ACTOR, released: [{ token: fenced.token }] });
	expect(audit[0]!.note).toContain("contention");
	const holderId = (await bot.conversation("test", "holder", context)).id;
	expect((await bot.harness.snapshot(NativeProvenanceDoc, holderId, context))!.calls.find(c => c.kind === "process")!.phase).toBe("reconciled");
}), 60_000);

test("contention unfences a proven-quiescent claim but never takes a still-valid lease from its holder", () => withBot(async (bot, dir, run) => withHeldProcess(dir, async (command, ready, release) => {
	await run("holder", [["work_claim", { key: "owned:lease", intent: "long edit" }], ["bash", { command }]]);
	await ready();
	const original = (await claims(bot)).find(c => c.key === "owned:lease")!;
	expect(original.quarantined).toBe(NATIVE);
	await release();
	const refused = await run("contender", [["work_claim", { key: "owned:lease", intent: "mine" }]]);
	expect(refused).toContain("Conflict");
	expect(refused).toMatch(/\d+m left/); // now an ordinary lease, shown with its TTL
	const after = (await claims(bot)).find(c => c.key === "owned:lease")!;
	expect(after).toMatchObject({ token: original.token, holder: original.holder });
	expect(after.quarantined).toBeUndefined();
	expect((await bot.harness.snapshot(ClaimReconcileAuditDoc, context))!.entries[0]).toMatchObject({ actor: AUTO_RECONCILE_ACTOR, released: [], unfenced: [{ token: original.token }] });
	// The holder's own release now frees it at once.
	expect(await run("holder", [["work_release", { key: "owned:lease" }]])).toContain("Released owned:lease");
	expect(await run("contender", [["work_claim", { key: "owned:lease", intent: "mine" }]])).toContain("Claimed owned:lease");
})), 60_000);

test("work_release reconciles its own proven-quiescent fence immediately", () => withBot(async (bot, dir, run) => withHeldProcess(dir, async (command, ready, release) => {
	await run("holder", [["work_claim", { key: "owned:self", intent: "edit" }], ["bash", { command }]]);
	await ready();
	expect((await claims(bot)).find(c => c.key === "owned:self")!.quarantined).toBe(NATIVE);
	await release();
	const text = await run("holder", [["work_release", { key: "owned:self" }]]);
	expect(text).toContain("Released owned:self");
	expect(await claims(bot)).toEqual([]);
	expect((await bot.harness.snapshot(ClaimReconcileAuditDoc, context))!.entries[0]).toMatchObject({ actor: AUTO_RECONCILE_ACTOR });
})), 60_000);

test("parallel native calls of one holder: the fence ends exactly when the last of them settles", () => withBot(async (bot) => {
	// Real transactions over the real journal; the two calls model concurrently admitted bash calls. The second call's
	// admission snapshot already shows the first call's fence, which used to strand the claim forever.
	const holderConversation = await bot.conversation("test", "parallel", context);
	const token = await bot.harness.commit(async tx => {
		const state = await tx.doc(ClaimsDoc);
		const granted = acquire(state, { key: "owned:par", holder: "test:parallel", intent: "x", ttlMs: 60_000 }, Date.now());
		if (granted.status !== "granted") throw Error("fixture");
		const plain: Claim = { ...granted.claim };
		state.claims[0]!.quarantined = NATIVE;
		const journal = await tx.doc(NativeProvenanceDoc, holderConversation.id);
		journal.calls.push({ taskId: "t1", kind: "process", tokens: [plain], acquiredTokens: [plain], phase: "unknown" });
		journal.calls.push({ taskId: "t2", kind: "process", tokens: [{ ...plain, quarantined: NATIVE }], acquiredTokens: [{ ...plain, quarantined: NATIVE }], phase: "unknown" });
		return plain;
	}, context);
	const settle = (taskId: string) => bot.harness.commit(async tx => {
		const call = (await tx.doc(NativeProvenanceDoc, holderConversation.id)).calls.find(c => c.taskId === taskId)!;
		call.phase = "settled";
		await unfenceSettledTx(tx, [...call.tokens, ...(call.acquiredTokens ?? [])], Date.now(), { conversationId: holderConversation.id, taskId, kind: "process" });
	}, context);
	await settle("t1");
	expect((await claims(bot))[0]!.quarantined).toBe(NATIVE); // t2 is still unknown
	await settle("t2");
	const after = (await claims(bot))[0]!;
	expect(after.token).toBe(token.token);
	expect(after.quarantined).toBeUndefined(); // both settled: fence gone, lease kept
	// A non-native cause recorded in any snapshot is never cleared by native settlement.
	await bot.harness.commit(async tx => {
		(await tx.doc(ClaimsDoc)).claims[0]!.quarantined = NATIVE;
		(await tx.doc(NativeProvenanceDoc, holderConversation.id)).calls.push({ taskId: "t3", kind: "process", tokens: [{ ...token, quarantined: "UNKNOWN managed effect intent" }], phase: "settled" });
		await unfenceSettledTx(tx, [token], Date.now());
	}, context);
	expect((await claims(bot))[0]!.quarantined).toBe(NATIVE);
}), 30_000);

// Bounded exhaustive search over serialized histories with fences (supplements the argument in ADR 0079).
test("fence/lease transitions preserve exclusion, never drop a fence early and never end a valid lease by unfencing", () => {
	type Point = { state: ClaimsState; now: number };
	const isLive = (c: Claim, now: number) => c.quarantined !== undefined || now < c.expiresAt;
	let frontier: Point[] = [{ state: { claims: [], nextToken: 1 }, now: 0 }];
	const seen = new Set<string>();
	let checked = 0;
	for (let depth = 0; depth <= 9; depth++) {
		const next: Point[] = [];
		for (const point of frontier) {
			const identity = JSON.stringify(point);
			if (seen.has(identity)) continue;
			seen.add(identity); checked++;
			const live = point.state.claims.filter(c => isLive(c, point.now));
			for (const a of live) for (const b of live) if (a.holder !== b.holder && overlaps(a.key, b.key)) throw new Error("exclusion counterexample: " + identity);
			if (depth === 9) continue;
			const fencedBefore = point.state.claims.filter(c => c.quarantined !== undefined);
			const step = (mutate: (s: ClaimsState) => void, now = point.now, unfenced?: Claim) => {
				const state = structuredClone(point.state); mutate(state);
				for (const f of fencedBefore) if (f !== unfenced && !state.claims.some(c => c.token === f.token && c.quarantined !== undefined)) throw new Error("fence dropped without unfence: " + identity);
				next.push({ state, now });
			};
			for (const holder of ["a", "b"]) {
				for (const key of ["repo:x", "repo:x/src"]) step(s => { acquire(s, { key, holder, intent: "m", ttlMs: 2 }, point.now); });
				step(s => { release(s, holder, undefined, point.now); });
				// A native call admission fences every live claim the holder has (first cause wins).
				step(s => { for (const c of s.claims) if (c.holder === holder && isLive(c, point.now) && !c.quarantined) c.quarantined = NATIVE; });
			}
			for (const f of fencedBefore) step(s => {
				const leased = point.now < f.expiresAt;
				const outcome = unfence(s, f, point.now);
				if (outcome?.outcome === "released" && leased) throw new Error("unfence ended a valid lease: " + identity);
				if (outcome?.outcome === "unfenced" && !leased) throw new Error("unfence kept an ended lease: " + identity);
			}, point.now, f);
			step(() => {}, point.now + 1);
		}
		frontier = next;
	}
	expect(checked).toBeGreaterThan(5000); // distinct reachable states;
});
