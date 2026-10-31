import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { parseArgs } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { abandonQuarantine, ClaimAbandonAuditDoc, ClaimReconcileAuditDoc, planQuarantineAbandonment, planTokenlessReconciliation, reconcileTokenlessCalls, type TokenlessReconcileRequest, type AbandonRequest, type TokenRef } from "../core/claim-reconcile.ts";

const USAGE = `dinobot quarantine-recovery --database <existing.sqlite> --request <request.json> [--apply]
Offline Windows/macOS maintenance only: exclusive database lock, no scheduling, channels, plugins or credentials.
Without --apply: inspect the exact token closure and return its snapshot and blockers.
With --apply: require actor, note, snapshot and the literal acceptance from the plan.
For tokenless process calls use --reconcile-tokenless with calls: [{conversationId, taskId}].
This requires native quiescence evidence and a plan snapshot; it never releases claims.
Abandonment is audited risk acceptance, NOT canonical quiescence. No automatic unlock.
Back up the stopped database and sidecars first. Keep the original backup untouched.
`;

export function parseAbandonRequest(value: unknown): AbandonRequest {
 if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid_request");
 const v = value as Record<string, unknown>;
 if (!Array.isArray(v.tokens) || !v.tokens.length || v.tokens.length > 1000) throw Error("invalid_tokens");
 const tokens: TokenRef[] = v.tokens.map((t: unknown) => {
  if (!t || typeof t !== "object" || Array.isArray(t)) throw Error("invalid_token");
  const r = t as Record<string, unknown>;
  if (typeof r.key !== "string" || !r.key || typeof r.holder !== "string" || !r.holder || !Number.isSafeInteger(r.token) || Number(r.token) <= 0) throw Error("invalid_token");
  return { key: r.key, holder: r.holder, token: r.token as number };
 });
 for (const key of ["actor", "note", "snapshot", "acceptance"]) if (v[key] !== undefined && typeof v[key] !== "string") throw Error("invalid_" + key);
 return { tokens, actor: (v.actor as string) ?? "", note: (v.note as string) ?? "", snapshot: (v.snapshot as string) ?? "", acceptance: (v.acceptance as string) ?? "" };
}

export function parseTokenlessRequest(value: unknown): TokenlessReconcileRequest {
 if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid_request");
 const v = value as Record<string, unknown>;
 if (v.tokens !== undefined || v.acceptance !== undefined || !Array.isArray(v.calls) || !v.calls.length || v.calls.length > 1000) throw Error("invalid_calls");
 const calls = v.calls.map(c => {
  if (!c || typeof c !== "object" || !Number.isSafeInteger(c.conversationId) || c.conversationId <= 0 || typeof c.taskId !== "string" || !/^[1-9][0-9]*$/.test(c.taskId) || !Number.isSafeInteger(Number(c.taskId))) throw Error("invalid_call");
  return { conversationId: c.conversationId as number, taskId: c.taskId as string };
 });
 for (const key of ["actor", "note", "snapshot"]) if (v[key] !== undefined && typeof v[key] !== "string") throw Error("invalid_" + key);
 return { calls, actor: (v.actor as string) ?? "", note: (v.note as string) ?? "", snapshot: (v.snapshot as string) ?? "" };
}

/** ps must include launchd and complete, unique PID/PGID/command rows. Absence is only a negative control. */
export function macosProcessBlockers(stdout: string, pids: number[]): string[] {
 if (!stdout.endsWith("\n")) throw Error("incomplete_process_inventory");
 const rows = stdout.trim().split(/\r?\n/).map(line => {
  const match = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
  if (!match) throw Error("invalid_process_inventory");
  const pid = Number(match[1]); const pgid = Number(match[2]); const command = match[3]!;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(pgid) || pgid < 0) throw Error("invalid_process_inventory");
  return { pid, pgid, command };
 });
 if (!rows.some(r => r.pid === 1 && /(?:^|\/)launchd$/.test(r.command)) || new Set(rows.map(r => r.pid)).size !== rows.length) throw Error("incomplete_process_inventory");
 return rows.filter(r => pids.includes(r.pid) || pids.includes(r.pgid) || /cua[ -]?driver/i.test(r.command)).map(r => "live process " + r.pid + " (PGID " + r.pgid + ", " + r.command + "); maintenance refuses conservatively");
}

/** Conservative live-process negative control, never positive evidence from PID absence. */
export async function recoveryProcessBlockers(pids: number[]): Promise<string[]> {
 if (process.platform === "darwin") {
  const { stdout } = await promisify(execFile)("/bin/ps", ["-ww", "-axo", "pid=,pgid=,comm="], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  return macosProcessBlockers(stdout, pids);
 }
 if (process.platform !== "win32") throw Error("unsupported_maintenance_platform");
 const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object ProcessId,Name) | ConvertTo-Json -Compress"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
 const rows: unknown = JSON.parse(stdout);
 if (!Array.isArray(rows) || !rows.length) throw Error("process_inventory_unavailable");
 const result: string[] = [];
 for (const row of rows) {
  if (!row || typeof row.Name !== "string" || !Number.isInteger(row.ProcessId)) throw Error("invalid_process_inventory");
  if (/^cua-driver(?:.*)?\.exe$/i.test(row.Name) || pids.includes(row.ProcessId)) result.push(`live process ${row.ProcessId} (${row.Name}); identity may be reused, but maintenance refuses conservatively`);
 }
 return result;
}

export async function runQuarantineRecovery(argv: string[]): Promise<number> {
 let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>> | undefined;
 let harness: Harness | undefined;
 try {
  const { values } = parseArgs({ args: argv, options: { database: { type: "string" }, request: { type: "string" }, apply: { type: "boolean" }, "reconcile-tokenless": { type: "boolean" }, help: { type: "boolean" } } });
  if (values.help) { console.log(USAGE); return 0; }
  if (process.platform !== "win32" && process.platform !== "darwin") throw Error("unsupported_maintenance_platform");
  if (!values.database || !values.request || !existsSync(values.database)) throw Error("existing_database_and_request_required");
  const input: unknown = JSON.parse(await readFile(values.request, "utf8"));
  const tokenless = values["reconcile-tokenless"] ? parseTokenlessRequest(input) : undefined;
  const request = tokenless ? undefined : parseAbandonRequest(input);
  database = await openNodeSqliteDatabase(await realpath(values.database), { busyTimeoutMs: 100 });
  // The same connection keeps the exclusive lock until close, across all Harness transactions.
  // Failure means another reader/writer is alive: never retry, stop it, or repair behind its back.
  await database.exec("PRAGMA locking_mode = EXCLUSIVE");
  await database.exec("BEGIN EXCLUSIVE; COMMIT;");
  harness = await Harness.open(await SqliteStorage.open(database), { registry: createRegistry(), models: createModels() }, context);
  // Deliberately never resume, openBot, load plugins, abort or wait for tasks.
  if (tokenless) {
   const plan = await planTokenlessReconciliation(harness, tokenless.calls, context);
   const blockers = await recoveryProcessBlockers(plan.calls.flatMap(c => c.processes.flatMap(p => p.pid === null ? [] : [p.pid])));
   if (!values.apply) { console.log(JSON.stringify({ ...plan, blockers: [...plan.blockers, ...blockers] })); return 0; }
   if (blockers.length) { console.log(JSON.stringify({ status: "refused", error: "live_processes", blockers })); return 1; }
   const result = await reconcileTokenlessCalls(harness, tokenless, context);
   if (result.status === "reconciled") {
    const audit = (await harness.snapshot(ClaimReconcileAuditDoc, context))?.entries.at(-1);
    if (audit?.actor !== tokenless.actor.trim() || audit.snapshot !== tokenless.snapshot || audit.note !== tokenless.note.trim() || JSON.stringify(audit.calls.map(c => ({ conversationId: c.conversationId, taskId: c.taskId }))) !== JSON.stringify(tokenless.calls)) throw Error("recovery_readback_failed");
   }
   console.log(JSON.stringify(result)); return result.status === "reconciled" ? 0 : 1;
  }
  if (!request) throw Error("invalid_request");
  const plan = await planQuarantineAbandonment(harness, request.tokens, context);
  const processBlockers = await recoveryProcessBlockers(plan.calls.flatMap(c => c.processes.flatMap(p => p.pid === null ? [] : [p.pid])));
  if (!values.apply) { console.log(JSON.stringify({ ...plan, blockers: [...plan.blockers, ...processBlockers], canonicalQuiescence: false })); return 0; }
  if (processBlockers.length) { console.log(JSON.stringify({ status: "refused", error: "live_processes", blockers: processBlockers })); return 1; }
  const result = await abandonQuarantine(harness, request, context);
  // Verify the exact target and audit through an authoritative read before reporting success.
  if (result.status === "abandoned") {
   const after = await planQuarantineAbandonment(harness, request.tokens, context);
   const audit = (await harness.snapshot(ClaimAbandonAuditDoc, context))?.entries.at(-1);
   if (after.required.length || audit?.snapshot !== request.snapshot || audit.acceptance !== request.acceptance || audit.actor !== request.actor.trim() || audit.released.length !== request.tokens.length) throw Error("recovery_readback_failed");
  }
  console.log(JSON.stringify(result));
  return result.status === "abandoned" ? 0 : 1;
 } catch (error) {
  console.error(JSON.stringify({ status: "refused", error: error instanceof Error ? error.message : "maintenance_failed" }));
  return 1;
 } finally {
  if (harness) await harness.close(context);
  else await database?.close();
 }
}
