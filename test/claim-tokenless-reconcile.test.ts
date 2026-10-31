import { test, expect } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage, defineTask, type Harness, type ConversationId } from "@earendil-works/pi-durable";
import { openBot } from "../src/core/bot.ts";
import { NativeProvenanceDoc } from "../src/core/claim-cleanup.ts";
import { ClaimsDoc } from "../src/core/claims.ts";
import { WorkspaceCoordDoc } from "../src/core/verification.ts";
import * as recovery from "../src/core/claim-reconcile.ts";

async function fixture(body: (h: Harness, id: ConversationId, taskId: string) => Promise<void>) {
 const models = createModels(); const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] }); models.setProvider(faux.provider);
 faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "echo tokenless" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
 const bot = await openBot({ storage: new MemoryStorage(), models, defaultModel: { provider: "faux", modelId: "m" }, toolMode: "direct", plugins: [] }, context);
 try {
  const root = await bot.conversation("test", "tokenless", context);
  expect((await (await root.submit({ type: "input", content: "run" }, context)).wait(context)).status).toBe("done");
  const taskId = await bot.harness.commit(async tx => {
   const call = (await tx.doc(NativeProvenanceDoc, root.id)).calls.find(c => c.kind === "process")!;
   call.phase = "unknown";
   (await tx.doc(WorkspaceCoordDoc)).leases.push({ id: "native:" + call.taskId + ":process", root: "UNKNOWN", environment: "UNKNOWN", conversationId: String(root.id), workId: "", taskId: call.taskId, reason: "native process provenance", phase: "blocked-unknown" });
   return call.taskId;
  }, context);
  await body(bot.harness, root.id, taskId);
 } finally { await bot.close(context); }
}

test("tokenless UNKNOWN terminal process has an exact-call audited recovery path", () => fixture(async (h, id, taskId) => {
 expect(await recovery.reconcileQuarantine(h, { tokens: [], actor: "operator", note: "exact call" }, context)).toMatchObject({ status: "refused", error: "tokens_required" });
 expect(typeof recovery.planTokenlessReconciliation).toBe("function");
 const calls = [{ conversationId: Number(id), taskId }];
 const plan = await recovery.planTokenlessReconciliation(h, calls, context);
 expect(plan.blockers).toEqual([]);
 const claims = await h.snapshot(ClaimsDoc, context);
 const result = await recovery.reconcileTokenlessCalls(h, { calls, snapshot: plan.snapshot, actor: "operator", note: "native evidence" }, context);
 expect(result.status).toBe("reconciled");
 expect(await h.snapshot(ClaimsDoc, context)).toEqual(claims);
 expect((await h.snapshot(WorkspaceCoordDoc, context))!.leases).toEqual([]);
 expect((await h.snapshot(NativeProvenanceDoc, id, context))!.calls[0]!.phase).toBe("reconciled");
 expect((await h.snapshot(recovery.ClaimReconcileAuditDoc, context))!.entries).toHaveLength(1);
}));

test("tokenless exact request rejects empty/duplicate calls, stale snapshot and missing audit actor", () => fixture(async (h, id, taskId) => {
 const calls = [{ conversationId: Number(id), taskId }];
 const plan = await recovery.planTokenlessReconciliation(h, calls, context);
 const request = { calls, snapshot: plan.snapshot, actor: "op", note: "exact" };
 expect(await recovery.reconcileTokenlessCalls(h, { ...request, snapshot: "0".repeat(64) }, context)).toMatchObject({ status: "refused", error: "snapshot_mismatch" });
 expect(await recovery.reconcileTokenlessCalls(h, { ...request, actor: " " }, context)).toMatchObject({ status: "refused", error: "actor_and_note_required" });
 for (const invalid of [[], [...calls, ...calls]]) {
  const p = await recovery.planTokenlessReconciliation(h, invalid, context);
  expect(p.blockers).toContain("exact_unique_calls_required");
  expect(await recovery.reconcileTokenlessCalls(h, { ...request, calls: invalid, snapshot: p.snapshot }, context)).toMatchObject({ status: "refused", error: "not_proven_quiescent" });
 }
 expect((await h.snapshot(NativeProvenanceDoc, id, context))!.calls[0]!.phase).toBe("unknown");
}));

for (const fault of ["missing-lease", "duplicate-lease", "foreign-lease", "foreign-task", "token", "acquired-token", "missing-start", "duplicate-start", "external", "duplicate-call", "invalid-identity", "pending-descendant"] as const) test("tokenless refuses " + fault + " without mutation", () => fixture(async (h, id, taskId) => {
 await h.commit(async tx => {
  const doc = await tx.doc(NativeProvenanceDoc, id); const call = doc.calls[0]!;
  const coord = await tx.doc(WorkspaceCoordDoc);
  if (fault === "missing-lease") coord.leases = [];
  if (fault === "duplicate-lease") coord.leases.push({ ...coord.leases[0]! });
  if (fault === "foreign-lease") coord.leases[0]!.conversationId = "999999";
  if (fault === "foreign-task") call.taskId = "999999";
  const token = { key: "other", holder: "other", token: 1, intent: "other", acquiredAt: 1, expiresAt: 2 };
  if (fault === "token") call.tokens.push(token);
  if (fault === "acquired-token") call.acquiredTokens = [token];
  if (fault === "missing-start") call.processes = call.processes!.filter(e => e.phase !== "started");
  if (fault === "duplicate-start") call.processes!.push({ ...call.processes!.find(e => e.phase === "started")! });
  if (fault === "external") call.kind = "external:computer_use";
  if (fault === "duplicate-call") doc.calls.push({ ...call });
  if (fault === "invalid-identity") call.processes!.find(e => e.phase === "started")!.pid = -1;
  if (fault === "pending-descendant") {
   const pending = defineTask({ name: "fixture.tokenless.pending", version: 1, initial: () => ({ phase: "wait" as const }), phases: { wait: async () => {} }, abort: async () => {} });
   const parent = await tx.createTask(pending, {}, { conversationId: id, ownership: { kind: "conversation" } });
   const child = await tx.createConversation({ ownership: { kind: "task", taskId: parent } });
   await tx.createTask(pending, {}, { conversationId: child.id, ownership: { kind: "conversation" } });
  }
 }, context);
 const calls = [{ conversationId: Number(id), taskId }];
 const before = await h.snapshot(NativeProvenanceDoc, id, context);
 const leases = await h.snapshot(WorkspaceCoordDoc, context);
 const plan = await recovery.planTokenlessReconciliation(h, calls, context);
 expect(plan.blockers.length).toBeGreaterThan(0);
 expect(await recovery.reconcileTokenlessCalls(h, { calls, snapshot: plan.snapshot, actor: "op", note: "negative" }, context)).toMatchObject({ status: "refused", error: "not_proven_quiescent" });
 expect(await h.snapshot(NativeProvenanceDoc, id, context)).toEqual(before);
 expect(await h.snapshot(WorkspaceCoordDoc, context)).toEqual(leases);
}));

for (const state of ["alive", "unknown", "throws"] as const) test("tokenless requires OS evidence: " + state, () => fixture(async (h, id, taskId) => {
 await h.commit(async tx => { const call = (await tx.doc(NativeProvenanceDoc, id)).calls[0]!; call.processes = call.processes!.filter(e => e.phase !== "settled"); }, context);
 const observe = async () => { if (state === "throws") throw Error("observation failed"); return { state, evidence: "synthetic negative control" }; };
 const calls = [{ conversationId: Number(id), taskId }];
 const plan = await recovery.planTokenlessReconciliation(h, calls, context, observe);
 expect(plan.blockers.length).toBeGreaterThan(0);
 expect(await recovery.reconcileTokenlessCalls(h, { calls, snapshot: plan.snapshot, actor: "op", note: "negative" }, context, observe)).toMatchObject({ status: "refused", error: "not_proven_quiescent" });
}));

test("tokenless CAS refuses a lease change during observation and preserves unrelated state", () => fixture(async (h, id, taskId) => {
 await h.commit(async tx => {
  const call = (await tx.doc(NativeProvenanceDoc, id)).calls[0]!; call.processes = call.processes!.filter(e => e.phase !== "settled");
  (await tx.doc(ClaimsDoc)).claims.push({ key: "unrelated", holder: "other", token: 987, intent: "other", acquiredAt: 1, expiresAt: 2, quarantined: "UNKNOWN native external:image_gen_generate provenance" });
  (await tx.doc(WorkspaceCoordDoc)).leases.push({ id: "unrelated", root: "/other", environment: "other", conversationId: "999", workId: "other", taskId: "999", reason: "other", phase: "blocked-unknown" });
 }, context);
 const calls = [{ conversationId: Number(id), taskId }];
 const quiescent = async () => ({ state: "quiescent" as const, evidence: "synthetic empty group" });
 const plan = await recovery.planTokenlessReconciliation(h, calls, context, quiescent);
 const claims = await h.snapshot(ClaimsDoc, context);
 const race = async () => {
  await h.commit(async tx => { (await tx.doc(WorkspaceCoordDoc)).leases[0]!.root = "changed"; }, context);
  return quiescent();
 };
 expect(await recovery.reconcileTokenlessCalls(h, { calls, snapshot: plan.snapshot, actor: "op", note: "CAS" }, context, race)).toMatchObject({ status: "refused", error: "changed_during_reconcile" });
 expect((await h.snapshot(NativeProvenanceDoc, id, context))!.calls[0]!.phase).toBe("unknown");
 expect(await h.snapshot(ClaimsDoc, context)).toEqual(claims);
 const fresh = await recovery.planTokenlessReconciliation(h, calls, context, quiescent);
 expect(await recovery.reconcileTokenlessCalls(h, { calls, snapshot: fresh.snapshot, actor: "op", note: "preserve unrelated" }, context, quiescent)).toMatchObject({ status: "reconciled" });
 expect(await h.snapshot(ClaimsDoc, context)).toEqual(claims);
 expect((await h.snapshot(WorkspaceCoordDoc, context))!.leases.map(l => l.id)).toEqual(["unrelated"]);
 expect((await h.snapshot(recovery.ClaimReconcileAuditDoc, context))!.entries[0]!.snapshot).toBe(fresh.snapshot);
}));
