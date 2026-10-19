import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openBot, type Bot } from "../src/core/bot.ts";
import { NativeProvenanceDoc } from "../src/core/claim-cleanup.ts";
import { ABANDONMENT_ACCEPTANCE, abandonQuarantine, planQuarantineAbandonment, ClaimReconcileAuditDoc, quarantineReport, reconcileQuarantine, type TokenRef } from "../src/core/claim-reconcile.ts";
import { ClaimsDoc, acquire, release, type Claim } from "../src/core/claims.ts";
import { WorkDoc, WorkspaceCoordDoc } from "../src/core/verification.ts";
import { OwnerClaimsDoc } from "../src/core/claim-cleanup.ts";
import { RunDoc } from "../src/core/dag.ts";
import { startClientApi } from "../src/api/server.ts";

/**
 * Operator reconciliation (issue #47, ADR 0075) against real processes: a bash call whose descendant outlives it stays
 * quarantined; the OS proves when that tree is gone (empty POSIX process group, drained Windows job). Only then, and
 * only for the exact token closure, does reconcile release — with an audit record and without rewriting the journal.
 */
const bun = process.execPath.replaceAll("\\", "/");
// Longer than the bounded post-close drain wait (1 s on Windows), so the call really stays UNKNOWN.
const outliving = (ms: number) => `"${bun}" -e "await Bun.sleep(${ms});await Bun.write('drained','1')" >/dev/null 2>&1 &`;
const ref = (claim: Claim): TokenRef => ({ key: claim.key, holder: claim.holder, token: claim.token });

async function scenario(mode: "direct" | "codemode-only", steps: [string, Record<string, string>][], body: (bot: Bot, dir: string, rootId: ConversationId) => Promise<void>) {
 const dir = await mkdtemp(join(tmpdir(), "reconcile-"));
 const models = createModels(); const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] }); models.setProvider(faux.provider);
 const call = (name: string, args: Record<string, string>) => fauxAssistantMessage(mode === "direct" ? fauxToolCall(name, args) : fauxToolCall("codemode", { code: "text(await tools." + name + "(" + JSON.stringify(args) + "));" }), { stopReason: "toolUse" });
 faux.setResponses([...steps.map(([name, args]) => call(name, args)), fauxAssistantMessage("done")]);
 const storage = await openNodeSqliteStorage(join(dir, "host.sqlite"));
 try {
  const bot = await openBot({ storage, models, defaultModel: { provider: "faux", modelId: "m" }, workspaceRoot: dir, toolMode: mode, plugins: [] }, context);
  try {
   const root = await bot.conversation("test", mode + "reconcile", context);
   expect((await (await root.submit({ type: "input", content: "run" }, context)).wait(context)).status).toBe("done");
   await body(bot, dir, root.id);
  } finally { await bot.close(context); }
 } finally { await storage.close(context); Bun.gc(true); await Bun.sleep(200); await rm(dir, { recursive: true, force: true }); }
}
async function drained(dir: string) { for (let i = 0; i < 800 && !existsSync(join(dir, "drained")); i++) await Bun.sleep(10); expect(existsSync(join(dir, "drained"))).toBe(true); await Bun.sleep(100); }

for (const mode of ["direct", "codemode-only"] as const) test("outliving descendant: refused while alive, unfenced once the OS proves quiescence; the lease stays with its holder " + mode, () => scenario(mode, [["work_claim", { key: "owned:reconcile", intent: "exact" }], ["bash", { command: outliving(1500) }]], async (bot, dir, rootId) => {
 const claims = (await bot.harness.snapshot(ClaimsDoc, context))!.claims;
 const original = claims.find(c => c.key === "owned:reconcile")!;
 expect(original.quarantined).toBe("UNKNOWN native process provenance");
 const journal = (await bot.harness.snapshot(NativeProvenanceDoc, rootId, context))!;
 const call = journal.calls.find(c => c.kind === "process")!;
 expect(call.phase).toBe("unknown");
 expect(call.processes!.find(e => e.phase === "settled")!.canonical).toBe(false);

 const alive = await quarantineReport(bot.harness, context);
 const entry = alive.quarantined.find(q => q.claim.token === original.token)!;
 expect(entry.reconcilable).toBe(false);
 expect(entry.blockers.join("\n")).toContain(": alive,");
 expect(entry.next).toContain("still running");
 const early = await reconcileQuarantine(bot.harness, { tokens: [ref(original)], actor: "test-operator", note: "too early" }, context);
 expect(early).toMatchObject({ status: "refused", error: "not_proven_quiescent" });
 // The risk-acceptance path must also refuse this REAL live retained Job/process group.
 const abandonment = await planQuarantineAbandonment(bot.harness, [ref(original)], context);
 expect(abandonment.blockers.join("\n")).toContain("is still alive");
 expect(await abandonQuarantine(bot.harness, { tokens: [ref(original)], actor: "test-operator", note: "cannot waive known live descendant", snapshot: abandonment.snapshot, acceptance: ABANDONMENT_ACCEPTANCE }, context)).toMatchObject({ status: "refused", error: "not_abandonable" });
 expect((await bot.harness.snapshot(ClaimsDoc, context))!.claims.find(c => c.token === original.token)?.quarantined).toBeTruthy();

 await drained(dir);
 const ready = (await quarantineReport(bot.harness, context)).quarantined.find(q => q.claim.token === original.token)!;
 expect(ready).toMatchObject({ reconcilable: true, blockers: [], required: [ref(original)] });
 expect(await reconcileQuarantine(bot.harness, { tokens: [{ ...ref(original), token: original.token + 100 }], actor: "test-operator", note: "forged" }, context)).toMatchObject({ status: "refused", error: "token_mismatch" });
 expect(await reconcileQuarantine(bot.harness, { tokens: [ref(original)], actor: " ", note: "x" }, context)).toMatchObject({ status: "refused", error: "actor_and_note_required" });

 const done = await reconcileQuarantine(bot.harness, { tokens: [ref(original)], actor: "test-operator", note: "descendant exited" }, context);
 expect(done.status).toBe("reconciled");
 if (done.status !== "reconciled") return;
 // ADR 0079: reconcile ends the fence, not the holder's still-valid lease.
 expect(done.released).toEqual([]);
 expect(done.unfenced.map(c => c.token)).toEqual([original.token]);
 expect(done.calls[0]!.processes[0]!.evidence.state).toBe("quiescent");
 expect(done.retained).toEqual([]);
 const after = (await bot.harness.snapshot(NativeProvenanceDoc, rootId, context))!.calls.find(c => c.kind === "process")!;
 expect(after.phase).toBe("reconciled");
 expect(after.processes).toEqual(call.processes!); // recorded events are not rewritten into a fake settlement
 expect(after.reconciled).toMatchObject({ actor: "test-operator", note: "descendant exited" });
 expect(after.reconciled!.evidence[0]!.evidence).toMatch(process.platform === "win32" ? /job .* holds zero processes/ : /process group \d+ is empty/);
 expect((await bot.harness.snapshot(WorkspaceCoordDoc, context))!.leases.some(l => l.id === "native:" + call.taskId + ":process")).toBe(false);
 expect((await bot.harness.snapshot(ClaimReconcileAuditDoc, context))!.entries).toHaveLength(1);
 expect(await reconcileQuarantine(bot.harness, { tokens: [ref(original)], actor: "test-operator", note: "again" }, context)).toMatchObject({ status: "refused", error: "token_mismatch" });
 const held = (await bot.harness.snapshot(ClaimsDoc, context))!.claims.find(c => c.token === original.token)!;
 expect(held.quarantined).toBeUndefined();
 expect(held.holder).toBe(original.holder);
 await bot.harness.commit(async tx => {
  const state = await tx.doc(ClaimsDoc);
  expect(acquire(state, { key: "owned:reconcile", holder: "fixture:other", intent: "while held", ttlMs: 60000 }, Date.now()).status).toBe("conflict");
  expect(release(state, original.holder, original.key, Date.now()).map(c => c.token)).toEqual([original.token]);
  expect(acquire(state, { key: "owned:reconcile", holder: "fixture:other", intent: "after", ttlMs: 60000 }, Date.now()).status).toBe("granted");
 }, context);
}), 30000);

test("a later claim re-quarantined by the unknown call is part of the exact closure", () => scenario("direct", [["work_claim", { key: "owned:first", intent: "before" }], ["bash", { command: outliving(2000) }], ["work_claim", { key: "owned:later", intent: "after" }]], async (bot, dir) => {
 const claims = (await bot.harness.snapshot(ClaimsDoc, context))!.claims;
 const first = claims.find(c => c.key === "owned:first")!; const later = claims.find(c => c.key === "owned:later")!;
 expect(later.quarantined).toBe("UNKNOWN prior native provenance");
 await drained(dir);
 const partial = await reconcileQuarantine(bot.harness, { tokens: [ref(first)], actor: "op", note: "partial" }, context);
 expect(partial).toMatchObject({ status: "refused", error: "token_set_mismatch", required: [ref(first), ref(later)] });
 expect((await bot.harness.snapshot(ClaimsDoc, context))!.claims).toHaveLength(2);
 expect(await reconcileQuarantine(bot.harness, { tokens: [ref(later), ref(first)], actor: "op", note: "both" }, context)).toMatchObject({ status: "reconciled" });
 const left = (await bot.harness.snapshot(ClaimsDoc, context))!.claims;
 expect(left.map(c => c.token).sort()).toEqual([first.token, later.token].sort());
 expect(left.every(c => c.quarantined === undefined)).toBe(true);
}), 30000);

test("no observer can bypass a running task, a missing identity or a non-native quarantine", () => scenario("direct", [["work_claim", { key: "owned:running", intent: "long" }], ["bash", { command: "sleep 0.1" }]], async (bot, _dir, rootId) => {
 const alwaysQuiescent = async () => ({ state: "quiescent" as const, evidence: "test says so" });
 // A fabricated UNKNOWN call (task never existed, only an admission) and a managed-effect quarantine.
 const fabricated = await bot.harness.commit(async tx => {
  const claims = await tx.doc(ClaimsDoc);
  const native = acquire(claims, { key: "owned:fabricated", holder: "fixture:x", intent: "x", ttlMs: 60000 }, Date.now());
  const managed = acquire(claims, { key: "owned:managed", holder: "fixture:y", intent: "y", ttlMs: 60000 }, Date.now());
  if (native.status !== "granted" || managed.status !== "granted") throw Error("fixture");
  claims.claims.find(c => c.token === native.claim.token)!.quarantined = "UNKNOWN native process provenance";
  claims.claims.find(c => c.token === managed.claim.token)!.quarantined = "UNKNOWN managed effect intent";
  (await tx.doc(NativeProvenanceDoc, rootId)).calls.push({ taskId: "999999", kind: "process", tokens: [{ ...native.claim }], phase: "unknown", processes: [{ phase: "admitted", nonce: "n1", pid: null, startTime: null, controlled: false }] });
  return { native: native.claim, managed: managed.claim };
 }, context);
 const nativeRefusal = await reconcileQuarantine(bot.harness, { tokens: [ref(fabricated.native)], actor: "op", note: "x" }, context, alwaysQuiescent);
 expect(nativeRefusal).toMatchObject({ status: "refused", error: "not_proven_quiescent" });
 if (nativeRefusal.status === "refused") expect(nativeRefusal.blockers.join("\n")).toContain("task 999999 was not found");
 const withDefaultObserver = await reconcileQuarantine(bot.harness, { tokens: [ref(fabricated.native)], actor: "op", note: "x" }, context);
 expect(withDefaultObserver.status).toBe("refused");
 if (withDefaultObserver.status === "refused") expect(withDefaultObserver.blockers.join("\n")).toContain("no recorded process identity");
 const managedRefusal = await reconcileQuarantine(bot.harness, { tokens: [ref(fabricated.managed)], actor: "op", note: "x" }, context, alwaysQuiescent);
 expect(managedRefusal).toMatchObject({ status: "refused", error: "not_proven_quiescent" });
 if (managedRefusal.status === "refused") expect(managedRefusal.blockers.join("\n")).toContain("not native process provenance");
 expect((await quarantineReport(bot.harness, context, alwaysQuiescent)).quarantined.find(q => q.claim.token === fabricated.managed.token)!.next).toContain("Not a native-process quarantine");
 expect((await bot.harness.snapshot(ClaimsDoc, context))!.claims.filter(c => c.quarantined)).toHaveLength(2);
}), 30000);

test("HTTP: quarantine report and evidence-gated reconcile", () => scenario("direct", [["work_claim", { key: "owned:http", intent: "api" }], ["bash", { command: outliving(2000) }]], async (bot, dir) => {
 const api = startClientApi(bot, 0, context, { list: () => [], find: () => undefined, answer: () => false } as never);
 try {
  const original = (await bot.harness.snapshot(ClaimsDoc, context))!.claims[0]!;
  expect((await fetch(new URL("/v1/claims/quarantine/reconcile", api.url), { method: "POST", body: JSON.stringify({ tokens: [] }) })).status).toBe(400);
  await drained(dir);
  const report = await (await fetch(new URL("/v1/claims/quarantine", api.url))).json() as { quarantined: { claim: Claim; reconcilable: boolean }[] };
  expect(report.quarantined).toMatchObject([{ claim: { token: original.token }, reconcilable: true }]);
  const missingNote = await fetch(new URL("/v1/claims/quarantine/reconcile", api.url), { method: "POST", body: JSON.stringify({ tokens: [ref(original)], actor: "op" }) });
  expect(missingNote.status).toBe(400);
  const ok = await fetch(new URL("/v1/claims/quarantine/reconcile", api.url), { method: "POST", body: JSON.stringify({ tokens: [ref(original)], actor: "op", note: "drained" }) });
  expect(ok.status).toBe(200);
  const again = await fetch(new URL("/v1/claims/quarantine/reconcile", api.url), { method: "POST", body: JSON.stringify({ tokens: [ref(original)], actor: "op", note: "drained" }) });
  expect(again.status).toBe(409);
 } finally { await api.stop(); }
}), 30000);

test("a native call never relabels an earlier non-native quarantine, so reconcile cannot release it", async () => {
 const dir = await mkdtemp(join(tmpdir(), "reconcile-relabel-"));
 const models = createModels(); const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] }); models.setProvider(faux.provider);
 faux.setResponses([fauxAssistantMessage(fauxToolCall("work_claim", { key: "owned:managed", intent: "effect" }), { stopReason: "toolUse" }), fauxAssistantMessage("claimed"), fauxAssistantMessage(fauxToolCall("bash", { command: "exit 0" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
 const storage = await openNodeSqliteStorage(join(dir, "host.sqlite"));
 try {
  const bot = await openBot({ storage, models, defaultModel: { provider: "faux", modelId: "m" }, workspaceRoot: dir, toolMode: "direct", plugins: [] }, context);
  try {
   const root = await bot.conversation("test", "relabel", context);
   expect((await (await root.submit({ type: "input", content: "claim" }, context)).wait(context)).status).toBe("done");
   // An unresolved managed effect quarantines the token first (as managed-effects.ts does).
   await bot.harness.commit(async tx => { (await tx.doc(ClaimsDoc)).claims[0]!.quarantined = "UNKNOWN managed effect intent"; }, context);
   expect((await (await root.submit({ type: "input", content: "run" }, context)).wait(context)).status).toBe("done");
   const call = (await bot.harness.snapshot(NativeProvenanceDoc, root.id, context))!.calls.find(c => c.kind === "process")!;
   if (call.phase !== "settled") console.error("native-settlement-diagnostic", JSON.stringify({ scenario: "managed-cause", call }));
   expect(call.phase).toBe("settled"); // the bash itself settled canonically
   const claim = (await bot.harness.snapshot(ClaimsDoc, context))!.claims[0]!;
   expect(claim.quarantined).toBe("UNKNOWN managed effect intent"); // not relabelled, not released
   const entry = (await quarantineReport(bot.harness, context)).quarantined[0]!;
   expect(entry).toMatchObject({ reconcilable: false, release: "direct" });
   const refused = await reconcileQuarantine(bot.harness, { tokens: [ref(claim)], actor: "op", note: "try" }, context, async () => ({ state: "quiescent", evidence: "test" }));
   expect(refused).toMatchObject({ status: "refused", error: "not_proven_quiescent" });
   expect((await bot.harness.snapshot(ClaimsDoc, context))!.claims).toHaveLength(1);
  } finally { await bot.close(context); }
 } finally { await storage.close(context); Bun.gc(true); await rm(dir, { recursive: true, force: true }); }
}, 30000);

for (const status of ["completed", "running"] as const) test(`a DAG-owned token is handed back to its node's own cleanup (node ${status})`, () => scenario("direct", [["work_claim", { key: "owned:dag", intent: "node" }], ["bash", { command: outliving(1500) }]], async (bot, dir, rootId) => {
 const call = (await bot.harness.snapshot(NativeProvenanceDoc, rootId, context))!.calls.find(c => c.kind === "process")!;
 const runnerId = call.taskId; // a real terminal task stands in for the node runner
 const token = await bot.harness.commit(async tx => {
  const claim = (await tx.doc(ClaimsDoc)).claims[0]!;
  claim.quarantined = "UNKNOWN native process/effect provenance"; // as the node's terminal cleanup records it
  (await tx.doc(WorkDoc, rootId)).dagParent = { conversationId: String(rootId), runId: "run-1", nodeId: "n1", runnerId, attempt: 1 };
  (await tx.doc(RunDoc, rootId)).runs.push({ id: "run-1", nodes: { n1: { status, attempt: 1, runnerId, facts: [], runs: 1 } } } as never);
  const { quarantined: _q, ...owned } = claim;
  (await tx.doc(OwnerClaimsDoc, rootId)).claims.push({ claim: owned, runId: "run-1", nodeId: "n1", runnerId, attempt: 1 });
  return ref(claim);
 }, context);
 expect((await quarantineReport(bot.harness, context)).quarantined[0]).toMatchObject({ release: "owner-cleanup", reconcilable: false });
 await drained(dir);
 expect((await quarantineReport(bot.harness, context)).quarantined[0]).toMatchObject({ release: "owner-cleanup", reconcilable: true });
 const done = await reconcileQuarantine(bot.harness, { tokens: [token], actor: "op", note: "tree exited" }, context);
 expect(done.status).toBe("reconciled");
 if (done.status !== "reconciled") return;
 expect((await bot.harness.snapshot(NativeProvenanceDoc, rootId, context))!.calls.find(c => c.kind === "process")!.phase).toBe("reconciled");
 const left = (await bot.harness.snapshot(ClaimsDoc, context))!.claims;
 if (status === "completed") {
  expect(done.released.map(c => c.token)).toEqual([token.token]);
  expect(left).toHaveLength(0);
  expect((await bot.harness.snapshot(OwnerClaimsDoc, rootId, context))!.cleanup).toBe("released exact owned tokens after tracked quiescence");
 } else {
  // A node still running keeps its token: only its own settlement may release it.
  expect(done.released).toEqual([]);
  expect(done.retained.map(c => c.token)).toEqual([token.token]);
  expect(left.map(c => c.token)).toEqual([token.token]);
 }
}), 30000);
