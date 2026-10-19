import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { ClaimsDoc } from "../../src/core/claims.ts";
import { NativeProvenanceDoc } from "../../src/core/claim-cleanup.ts";
import { ClaimAbandonAuditDoc, reconcileQuarantine } from "../../src/core/claim-reconcile.ts";
import { createHash } from "node:crypto";
const harness = await Harness.open(await openNodeSqliteStorage(process.argv[2]!), { registry: createRegistry(), models: createModels() }, context);
try {
 const token = { key: "host:windows/deepwork-installed-e2e", holder: "conversation:89177", token: 384 };
 const claim = (await harness.snapshot(ClaimsDoc, context))!.claims.find(c => c.key === token.key && c.holder === token.holder && c.token === token.token);
 const calls = (await harness.snapshot(NativeProvenanceDoc, 89177 as ConversationId, context))!.calls.filter(c => [...c.tokens, ...(c.acquiredTokens ?? [])].some(t => t.key === token.key && t.holder === token.holder && t.token === token.token));
 const audit = (await harness.snapshot(ClaimAbandonAuditDoc, context))?.entries ?? [];
 const eventsHash = createHash("sha256").update(JSON.stringify(calls.map(c => [c.taskId, c.kind, c.processes ?? []]))).digest("hex");
 const phases = Object.fromEntries([...new Set(calls.map(c => c.phase))].map(p => [p, calls.filter(c => c.phase === p).length]));
 let reproduction;
 if (claim) reproduction = await reconcileQuarantine(harness, { tokens: [token], actor: "copy-test", note: "reproduce refusal on isolated copy" }, context);
 console.log(JSON.stringify({ claim, count: calls.length, phases, eventsHash, audit: audit.map(a => ({ actor: a.actor, snapshot: a.snapshot, released: a.released.map(c => c.token), calls: a.calls.length, waived: a.waived.length, originalPhases: [...new Set(a.calls.map(c => c.call.phase))], originalEventsHash: createHash("sha256").update(JSON.stringify(a.calls.map(c => [c.call.taskId, c.call.kind, c.call.processes ?? []]))).digest("hex") })), reproduction: reproduction && { status: reproduction.status, error: reproduction.status === "refused" ? reproduction.error : undefined } }));
} finally { await harness.close(context); }
