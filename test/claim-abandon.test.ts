import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { ClaimsDoc } from "../src/core/claims.ts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NativeProvenanceDoc } from "../src/core/claim-cleanup.ts";
import { WorkspaceCoordDoc } from "../src/core/verification.ts";
import { openBot } from "../src/core/bot.ts";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as recovery from "../src/core/claim-reconcile.ts";

// An external call interrupted by a crash remains UNKNOWN: an operator may abandon its uncertainty,
// but must never manufacture canonical evidence. Uses the real durable transaction store.
test("offline maintenance command is available without loading configuration", async () => {
 const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../src/main.ts", import.meta.url)), "quarantine-recovery", "--help"], { stdout: "pipe", stderr: "pipe" });
 const output = await new Response(child.stdout).text();
 expect(await child.exited).toBe(0);
 expect(output).toContain("exclusive database lock");
});
test("historical diagnosis does not promise reboot proof for external calls", async () => {
 const h = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: createModels() }, context);
 try {
  const root = await h.root(context);
  await h.commit(async tx => {
   (await tx.doc(ClaimsDoc)).claims.push({ key: "host:legacy", holder: "conversation:" + root.id, token: 384, intent: "legacy", acquiredAt: 1, expiresAt: 2, quarantined: "UNKNOWN native external:computer_use provenance" });
   (await tx.doc(NativeProvenanceDoc, root.id)).calls.push({ taskId: "999", kind: "external:computer_use", tokens: [(await tx.doc(ClaimsDoc)).claims[0]!], phase: "unknown" });
  }, context);
  const report = await recovery.quarantineReport(h, context);
  expect(report.quarantined[0]!.next).toContain("cannot reconstruct");
  expect(report.quarantined[0]!.reconcilable).toBe(false);
 } finally { await h.close(context); }
});

async function legacy(body: (h: Harness, id: import("@earendil-works/pi-durable").ConversationId) => Promise<void>, storage: Parameters<typeof openBot>[0]["storage"] = new MemoryStorage()) {
 const models = createModels(); const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] }); models.setProvider(faux.provider);
 faux.setResponses([fauxAssistantMessage(fauxToolCall("work_claim", { key: "host:legacy", intent: "old" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxToolCall("computer_use", {}), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
 const bot = await openBot({ storage, models, defaultModel: { provider: "faux", modelId: "m" }, toolMode: "direct", plugins: [{ id: "fixture", tools: [{ name: "computer_use", description: "fixture boundary only", inputSchema: { type: "object" }, execute: async () => "done" }] }] }, context);
 try {
  const root = await bot.conversation("test", "legacy", context);
  expect((await (await root.submit({ type: "input", content: "run" }, context)).wait(context)).status).toBe("done");
  // A returned plugin call is settled (ADR 0094). Rewind to the state a daemon crash mid-call leaves: UNKNOWN call, fenced claim, blocked lease.
  await bot.harness.commit(async tx => {
   const call = (await tx.doc(NativeProvenanceDoc, root.id)).calls.find(c => c.kind === "external:computer_use")!;
   call.phase = "unknown";
   for (const claim of (await tx.doc(ClaimsDoc)).claims) if (call.tokens.some(t => t.token === claim.token)) claim.quarantined = "UNKNOWN native external:computer_use provenance";
   (await tx.doc(WorkspaceCoordDoc)).leases.push({ id: "native:" + call.taskId + ":external:computer_use", root: "UNKNOWN", environment: "UNKNOWN", conversationId: String(root.id), workId: "", taskId: call.taskId, reason: "native external:computer_use provenance", phase: "blocked-unknown" });
  }, context);
  await body(bot.harness, root.id);
 } finally { await bot.close(context); }
}

test("explicit audited abandonment is not evidence-based reconciliation", () => legacy(async (h, id) => {
 const claim = (await h.snapshot(ClaimsDoc, context))!.claims[0]!;
 const before = (await h.snapshot(NativeProvenanceDoc, id, context))!.calls;
 expect(await recovery.reconcileQuarantine(h, { tokens: [claim], actor: "operator", note: "terminal is not proof" }, context)).toMatchObject({ status: "refused", error: "not_proven_quiescent" });
 expect(typeof recovery.abandonQuarantine).toBe("function");
 const plan = await recovery.planQuarantineAbandonment(h, [claim], context);
 expect(plan.blockers).toEqual([]);
 const result = await recovery.abandonQuarantine(h, { tokens: [claim], actor: "operator", note: "approved abandonment of historical uncertainty", snapshot: plan.snapshot, acceptance: recovery.ABANDONMENT_ACCEPTANCE }, context);
 expect(result.status).toBe("abandoned");
 expect((await h.snapshot(ClaimsDoc, context))!.claims).toHaveLength(0);
 const after = (await h.snapshot(NativeProvenanceDoc, id, context))!.calls;
 expect(after[0]!.phase).toBe("abandoned");
 expect(after[0]!.processes).toEqual(before[0]!.processes);
 expect(after[0]!.reconciled).toBeUndefined();
 expect(after[0]!.abandoned?.snapshot).toBe(plan.snapshot);
 const audit = (await h.snapshot(recovery.ClaimAbandonAuditDoc, context))!.entries[0]!;
 expect(audit.waived).toContain("external:computer_use was interrupted before the host saw it return");
 expect(audit.acceptance).toBe(recovery.ABANDONMENT_ACCEPTANCE);
}));

test("SQLite maintenance rejects durable pending parent and owned descendant", async () => {
 const { mkdtemp, rm } = await import("node:fs/promises");
 const { tmpdir } = await import("node:os");
 const { defineTask } = await import("@earendil-works/pi-durable");
 const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
 const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "quarantine-descendant-"));
 try {
  await legacy(async (h, id) => {
   let parentId = 0, childId = 0;
   await h.commit(async tx => {
    const pending = defineTask({ name: "fixture.sqlite.pending", version: 1, initial: () => ({ phase: "wait" as const }), phases: { wait: async () => {} }, abort: async () => {} });
    const parent = await tx.createTask(pending, {}, { conversationId: id, ownership: { kind: "conversation" } });
    const child = await tx.createConversation({ ownership: { kind: "task", taskId: parent } });
    parentId = Number(parent);
    childId = Number(await tx.createTask(pending, {}, { conversationId: child.id, ownership: { kind: "conversation" } }));
   }, context);
   const claim = (await h.snapshot(ClaimsDoc, context))!.claims[0]!;
   const plan = await recovery.planQuarantineAbandonment(h, [claim], context);
   expect(plan.blockers).toContain(`related task ${parentId} is still pending`);
   expect(plan.blockers).toContain(`related task ${childId} is still pending`);
   expect(await recovery.abandonQuarantine(h, { tokens: [claim], snapshot: plan.snapshot, acceptance: recovery.ABANDONMENT_ACCEPTANCE, actor: "fixture", note: "negative control only" }, context)).toMatchObject({ status: "refused", error: "not_abandonable" });
   expect((await h.snapshot(ClaimsDoc, context))!.claims).toHaveLength(1);
  }, await openNodeSqliteStorage(join(dir, "fixture.sqlite")));
 } finally { Bun.gc(true); await Bun.sleep(100); await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

for (const phase of ["absent", "settled", "reconciled"] as const) test("SQLite abandonment refuses mixed tokens with " + phase + " provenance", async () => {
 const { mkdtemp, rm } = await import("node:fs/promises");
 const { tmpdir } = await import("node:os");
 const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
 const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "quarantine-mixed-"));
 try {
  await legacy(async (h, id) => {
   const claim = (await h.snapshot(ClaimsDoc, context))!.claims[0]!;
   const orphan = { ...claim, key: "host:orphan", token: claim.token + 1 };
   await h.commit(async tx => {
    (await tx.doc(ClaimsDoc)).claims.push(orphan);
    if (phase !== "absent") {
     const doc = await tx.doc(NativeProvenanceDoc, id);
     doc.calls.push({ ...doc.calls[0]!, taskId: "999999", tokens: [orphan], acquiredTokens: [orphan], phase });
    }
   }, context);
   const before = JSON.stringify(await h.snapshot(NativeProvenanceDoc, id, context));
   const plan = await recovery.planQuarantineAbandonment(h, [claim, orphan], context);
   expect(plan.blockers).toContain(`token ${orphan.token} has no recorded UNKNOWN call`);
   const result = await recovery.abandonQuarantine(h, { tokens: [claim, orphan], snapshot: plan.snapshot, acceptance: recovery.ABANDONMENT_ACCEPTANCE, actor: "fixture", note: "negative control only" }, context);
   expect(result).toMatchObject({ status: "refused", error: "not_abandonable" });
   expect((await h.snapshot(ClaimsDoc, context))!.claims).toEqual([claim, orphan]);
   expect(JSON.stringify(await h.snapshot(NativeProvenanceDoc, id, context))).toBe(before);
   expect((await h.snapshot(recovery.ClaimAbandonAuditDoc, context))?.entries ?? []).toHaveLength(0);
  }, await openNodeSqliteStorage(join(dir, "fixture.sqlite")));
 } finally { Bun.gc(true); await Bun.sleep(100); await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
});

for (const variant of ["missing acceptance", "wrong token", "missing token", "duplicate token", "stale snapshot", "unsupported external", "managed cause", "missing task", "related live task", "owner", "live process", "observation failure", "concurrent change", "closure"] as const) test("abandonment refuses " + variant, () => legacy(async (h, id) => {
 const claim = (await h.snapshot(ClaimsDoc, context))!.claims[0]!;
 let observer: recovery.ObserveQuiescence = async () => ({ state: "unknown", evidence: "no retained job and no recorded boot identity" });
 await h.commit(async tx => {
  const call = (await tx.doc(NativeProvenanceDoc, id)).calls[0]!;
  if (variant === "unsupported external") call.kind = "managed:other";
  if (variant === "managed cause") (await tx.doc(ClaimsDoc)).claims[0]!.quarantined = "UNKNOWN managed effect intent";
  if (variant === "missing task") call.taskId = "999999";
  if (variant === "related live task") {
   const { defineTask } = await import("@earendil-works/pi-durable");
   const pending = defineTask({ name: "fixture.pending", version: 1, initial: () => ({ phase: "wait" as const }), phases: { wait: async () => {} }, abort: async () => {} });
   await tx.createTask(pending, {}, { conversationId: id, ownership: { kind: "conversation" } });
  }
  if (variant === "owner") {
   const { OwnerClaimsDoc } = await import("../src/core/claim-cleanup.ts");
   (await tx.doc(OwnerClaimsDoc, id)).claims.push({ claim, runId: "r", nodeId: "n", runnerId: call.taskId, attempt: 1 });
  }
  if (variant === "live process" || variant === "observation failure" || variant === "concurrent change") {
   call.kind = "process";
   call.processes = [{ phase: "admitted", nonce: "old", pid: null, startTime: null, controlled: false }, { phase: "started", nonce: "old", pid: 1, startTime: null, controlled: false }];
  }
  if (variant === "closure") {
   const second = { ...claim, key: "host:second", token: claim.token + 1 };
   (await tx.doc(ClaimsDoc)).claims.push(second);
   call.acquiredTokens = [...(call.acquiredTokens ?? []), second];
  }
 }, context);
 const plan = await recovery.planQuarantineAbandonment(h, [claim], context, observer);
 if (variant === "live process") observer = async () => ({ state: "alive", evidence: "retained job has a live descendant" });
 if (variant === "observation failure") observer = async () => { throw Error("observation unavailable"); };
 if (variant === "concurrent change") observer = async () => {
  await h.commit(async tx => { (await tx.doc(ClaimsDoc)).claims[0]!.intent = "changed"; }, context);
  return { state: "unknown", evidence: "no retained job and no recorded boot identity" };
 };
 const request = { tokens: [claim], actor: "op", note: "risk approved", snapshot: plan.snapshot, acceptance: recovery.ABANDONMENT_ACCEPTANCE };
 if (variant === "missing acceptance") request.acceptance = "";
 if (variant === "wrong token") request.tokens = [{ ...claim, token: claim.token + 100 }];
 if (variant === "missing token") request.tokens = [];
 if (variant === "duplicate token") request.tokens = [claim, claim];
 if (variant === "stale snapshot") request.snapshot = "0".repeat(64);
 const result = await recovery.abandonQuarantine(h, request, context, observer);
 expect(result.status).toBe("refused");
 expect((await h.snapshot(ClaimsDoc, context))!.claims.some(c => c.token === claim.token)).toBe(true);
 expect((await h.snapshot(NativeProvenanceDoc, id, context))!.calls[0]!.phase).toBe("unknown");
 expect((await h.snapshot(recovery.ClaimAbandonAuditDoc, context))?.entries ?? []).toHaveLength(0);
}));
