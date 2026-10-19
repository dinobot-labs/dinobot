import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { defineTask, type ConversationId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { openBot, type Bot } from "../src/core/bot.ts";
import { ClaimsDoc, type Claim } from "../src/core/claims.ts";
import { cleanupOwnerClaimsTx, NativeProvenanceDoc, OwnerClaimsDoc } from "../src/core/claim-cleanup.ts";
import { ClaimReconcileAuditDoc, reconcileQuarantine } from "../src/core/claim-reconcile.ts";
import { createRun, replan, start, succeed, RunDoc, type RunState } from "../src/core/dag.ts";
import { WorkDoc, WorkspaceCoordDoc } from "../src/core/verification.ts";
import type { Plan } from "../src/core/plan.ts";

// Each case owns a real, disposable SQLite harness. No live DB or native processes.
type Mutate = (fn: (tx: Tx, run: RunState) => Promise<void>) => Promise<void>;
type Fixture = { bot: Bot; id: ConversationId; token: Claim; mutate: Mutate; reset: () => Promise<void>; reconcile: () => ReturnType<typeof reconcileQuarantine> };
async function fixture(body: (f: Fixture) => Promise<void>) {
 const dir = await mkdtemp(join(tmpdir(), "claim-replan-"));
 const storage = await openNodeSqliteStorage(join(dir, "host.sqlite"));
 const models = createModels(); const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] }); models.setProvider(faux.provider);
 faux.setResponses([fauxAssistantMessage("done")]);
 const bot = await openBot({ storage, models, defaultModel: { provider: "faux", modelId: "m" }, workspaceRoot: dir, toolMode: "direct", plugins: [] }, context);
 try {
  const root = await bot.conversation("test", "replan", context);
  await (await root.submit({ type: "input", content: "run" }, context)).wait(context);
  const plan: Plan = { nodes: [{ id: "n", kind: "act", writes: ["repo:x"] }, { id: "v", kind: "verify", reads: ["repo:x"], covers: ["R"] }], edges: [["n", "v"]], goal: { requirements: ["R"] } };
  const token: Claim = { key: "repo:x", holder: "test:replan", token: 484, intent: "original", acquiredAt: 0, expiresAt: 1, quarantined: "UNKNOWN native process/effect provenance" };
  await bot.harness.commit(async tx => {
   const runner = (await tx.scanTasks({ conversationId: root.id }, 128)).items.find(t => t.state.status === "terminal")!;
   const run = createRun("r", plan, 0); start(run, "n", "sa-original", 1, String(runner.id));
   (await tx.doc(RunDoc, root.id)).runs.push(run);
   (await tx.doc(WorkDoc, root.id)).dagParent = { conversationId: String(root.id), runId: "r", nodeId: "n", runnerId: String(runner.id), attempt: 1 };
   (await tx.doc(OwnerClaimsDoc, root.id)).claims.push({ claim: { ...token }, runId: "r", nodeId: "n", runnerId: String(runner.id), attempt: 1 });
   (await tx.doc(ClaimsDoc)).claims.push(token);
   // Native reconciliation already happened while the owner node was running (incident order).
   (await tx.doc(NativeProvenanceDoc, root.id)).calls.push({ taskId: String(runner.id), kind: "process", tokens: [{ ...token }], phase: "reconciled", reconciled: { at: 2, actor: "dinobot:auto-reconcile", note: "job zero", evidence: [] } });
  }, context);
  const mutate: Mutate = (fn) => bot.harness.commit(async tx => fn(tx, (await tx.doc(RunDoc, root.id)).runs[0]!), context);
  const reconcile = () => reconcileQuarantine(bot.harness, { tokens: [token], actor: "test", note: "retry owner cleanup" }, context);
  const reset = () => mutate(async (_tx, run) => {
   succeed(run, "n", "done", 3);
   const changed = structuredClone(plan); changed.nodes[0]!.description = "replanned";
   expect(replan(run, changed, 4).ok).toBe(true);
   expect(run.nodes.n).toMatchObject({ status: "pending", attempt: 0, binding: { attempt: 1 } });
  });
  await body({ bot, id: root.id, token, mutate, reset, reconcile });
 } finally { await bot.close(context); await storage.close(context); Bun.gc(true); await rm(dir, { recursive: true, force: true }); }
}

test("reconcile retained while running then real replan resets attempt: exact old token is released", () => fixture(async ({ bot, id, reconcile, reset }) => {
 const nativeBefore = await bot.harness.snapshot(NativeProvenanceDoc, id, context);
 expect(await reconcile()).toMatchObject({ status: "reconciled", released: [], retained: [{ token: 484 }] });
 await reset();
 expect(await reconcile()).toMatchObject({ status: "reconciled", released: [{ token: 484 }], retained: [] });
 expect(await bot.harness.snapshot(NativeProvenanceDoc, id, context)).toEqual(nativeBefore);
}));

test("terminal DAG cleanup uses retained execution attempt after real replan", () => fixture(async ({ bot, id, reset, mutate }) => {
 await reset();
 await mutate((tx, run) => cleanupOwnerClaimsTx(tx, id, "r", "n", run.nodes.n!));
 expect((await bot.harness.snapshot(ClaimsDoc, context))!.claims).toEqual([]);
}));

for (const guard of ["missing-binding", "binding-attempt", "binding-runner", "parent-attempt", "parent-runner", "missing-parent", "unknown-effects", "managed-effect", "native-unknown", "managed-lease", "replacement", "running-task", "running-descendant", "missing-runner"])
 test("replan cleanup retains claim: " + guard, () => fixture(async ({ reset, mutate, reconcile, id }) => {
  await reset();
  let descendantOwner: TaskId | undefined;
  await mutate(async (tx, run) => {
   const node = run.nodes.n!;
   if (guard === "missing-binding") delete node.binding;
   if (guard === "binding-attempt") node.binding!.attempt++;
   if (guard === "binding-runner") node.binding!.runnerId = "999";
   if (guard === "parent-attempt") (await tx.doc(WorkDoc, id)).dagParent!.attempt++;
   if (guard === "parent-runner") (await tx.doc(WorkDoc, id)).dagParent!.runnerId = "999";
   if (guard === "missing-parent") delete (await tx.doc(WorkDoc, id)).dagParent;
   if (guard === "unknown-effects") node.unknownEffects = true;
   if (guard === "managed-effect") node.effect = { id: "effect", tool: "fixture", inputHash: "hash", runId: "r", nodeId: "n", key: node.key!, attempt: 1, goal: { epoch: 1, hash: "goal" }, authority: [], phase: "unknown" };
   if (guard === "native-unknown") (await tx.doc(NativeProvenanceDoc, id)).calls.push({ taskId: "999", kind: "external:computer_use", tokens: [], phase: "unknown" });
   if (guard === "managed-lease") (await tx.doc(WorkspaceCoordDoc)).leases.push({ id: "managed", conversationId: String(id), root: "repo:x", environment: "fixture", workId: "w", taskId: "999", reason: "unresolved", phase: "blocked-unknown" });
   if (guard === "replacement") start(run, "n", "sa-new", 5, "999");
   if (guard === "missing-runner") {
    node.runnerId = node.binding!.runnerId = "999";
    (await tx.doc(WorkDoc, id)).dagParent!.runnerId = "999";
    (await tx.doc(OwnerClaimsDoc, id)).claims[0]!.runnerId = "999";
   }
   if (guard === "running-task" || guard === "running-descendant") {
    const pending = defineTask({ name: "fixture.replan.pending", version: 1, initial: () => ({ phase: "wait" as const }), phases: { wait: async () => {} }, abort: async () => {} });
    let conversationId = id;
    if (guard === "running-descendant") {
     descendantOwner = await tx.createTask(pending, {}, { conversationId: id, ownership: { kind: "conversation" } });
     conversationId = (await tx.createConversation({ ownership: { kind: "task", taskId: descendantOwner } })).id;
    }
    await tx.createTask(pending, {}, { conversationId, ownership: { kind: "conversation" } });
   }
  });
  if (descendantOwner) await mutate(async tx => {
   const task = (await tx.task(descendantOwner!))!;
   const { memos: _memos, ...record } = task;
   // Test-only durable task transition: isolate a live descendant behind a terminal parent.
   (tx as Tx & { setTask(record: typeof task): void }).setTask({ ...record, state: { status: "terminal", outcome: { status: "completed", result: {} } } });
  });
  expect(await reconcile()).toMatchObject({ status: "reconciled", released: [], retained: [{ token: 484 }] });
 }));

test("old acquisition cleanup never releases same-holder successor token", () => fixture(async ({ bot, id, reset, mutate, token }) => {
 await reset();
 await mutate(async (tx, run) => {
  (await tx.doc(ClaimsDoc)).claims = [{ ...token, token: 485 }];
  await cleanupOwnerClaimsTx(tx, id, "r", "n", run.nodes.n!);
 });
 expect((await bot.harness.snapshot(ClaimsDoc, context))!.claims.map(c => c.token)).toEqual([485]);
}));


test("reconcile releases and audits only requested exact tokens from a three-token owner", () => fixture(async ({ bot, id, reset, mutate, token, reconcile }) => {
 await reset();
 await mutate(async tx => {
  const owners = await tx.doc(OwnerClaimsDoc, id);
  for (const n of [485, 486]) {
   const claim = { ...token, key: "repo:x/" + n, token: n };
   (await tx.doc(ClaimsDoc)).claims.push(claim);
   owners.claims.push({ ...owners.claims[0]!, claim });
  }
 });
 const first = await reconcile();
 expect(first).toMatchObject({ status: "reconciled", released: [{ token: 484 }] });
 expect((await bot.harness.snapshot(ClaimsDoc, context))!.claims.map(c => c.token)).toEqual([485, 486]);
 const remaining = (await bot.harness.snapshot(ClaimsDoc, context))!.claims;
 const second = await reconcileQuarantine(bot.harness, { tokens: [...remaining], actor: "test", note: "remaining exact scope" }, context);
 expect(second).toMatchObject({ status: "reconciled", released: [{ token: 485 }, { token: 486 }], retained: [] });
 expect((await bot.harness.snapshot(ClaimsDoc, context))!.claims).toEqual([]);
 expect((await bot.harness.snapshot(ClaimReconcileAuditDoc, context))!.entries.map(e => e.released.map(c => c.token))).toEqual([[484], [485, 486]]);
}));
