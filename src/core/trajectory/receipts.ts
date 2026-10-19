import type { Step } from "./types.ts";

export const object = (x: unknown): Record<string, any> => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, any> : {};
const nonempty = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0;
const list = (x: unknown): x is string[] => Array.isArray(x) && x.length > 0 && x.every(nonempty);
const empty = (x: unknown) => Array.isArray(x) && x.length === 0;

/** Only the existing ask/answer details and managed verification JSON result are receipts. */
export function extractReceipt(tool: string, details: unknown, output: string): Step['receipt'] {
 if(tool === 'ask' || tool === 'answer') return {ask:object(details).ask};
 if(tool === 'verify_run' || tool === 'work_finish') {
  try { return {workflow:JSON.parse(output)}; } catch { return {}; }
 }
 return undefined;
}

/** Exact positive responses avoid interpreting arbitrary approval prose or negative clauses. */
export function resolvedAuthority(s: Step, command?: string): boolean {
 if(s.kind !== 'call' || !['ask','answer'].includes(s.tool ?? '') || s.ok !== true) return false;
 const a=object(s.receipt?.ask);
 if(a.kind !== 'authority' || a.state !== 'answered' || !nonempty(a.id) || !nonempty(a.resolvedBy) || !Number.isFinite(a.resolvedAt) || !Number.isFinite(a.createdAt) || a.resolvedAt < a.createdAt || !Number.isFinite(a.deadlineAt) || a.resolvedAt > a.deadlineAt) return false;
 if(a.to === 'human' && (!a.resolvedBy.startsWith('human:') || !Number.isSafeInteger(a.sourceEntry) || a.sourceEntry <= 0)) return false;
 if(a.to !== 'human' && (a.to !== 'main' || !/^(agent:|human:)/.test(a.resolvedBy))) return false;
 if(s.tool === 'answer' && object(s.args).ask_id !== a.id) return false;
 if(!/^(yes|approve(?:d)?|allow(?:ed)?|grant(?:ed)?|go ahead|승인|허용|네)[.!]?$/i.test(String(a.answer ?? '').trim())) return false;
 // Opaque DAG node refs cannot establish a command's target without a reviewed node binding.
 return list(a.refs) && (command === undefined || a.refs.some((ref: string) => ref.trim() === command.trim()));
}

/** Local receipt coherence only: no claim that the plan covers every edited path. */
export function managedCheckPassed(s: Step): boolean {
 if(s.ok !== true || !['verify_run','work_finish'].includes(s.tool ?? '')) return false;
 const w=object(s.receipt?.workflow), args=object(s.args), cert=object(w.certificate);
 if(!nonempty(args.workId) || w.workId !== args.workId || !Array.isArray(w.evidence) || !['implementing','verified'].includes(w.status) || !empty(w.blockers)) return false;
 const passed = (raw: unknown) => {
  const e=object(raw), o=object(e.observation), methods=object(w.methods)[e.checkId];
  const method=Array.isArray(methods) ? object(methods.at(-1)) : {};
  return nonempty(e.id) && e.workId === w.workId && e.status === 'passed' && nonempty(e.before) && e.before === e.after && nonempty(e.contractHash)
   && ['version','methodEpoch','mutationEpoch'].every(k=>Number.isSafeInteger(w[k]) && e[k] === w[k])
   && nonempty(method.hash) && e.methodHash === method.hash
   && o.passed === true && o.quiescent === true && o.exitCode === 0 && o.truncated === false && o.error === null;
 };
 const latest = (checkId: string) => w.evidence.findLast((raw: unknown)=>object(raw).checkId === checkId);
 if(s.tool === 'verify_run') return nonempty(args.checkId) && passed(latest(args.checkId));
 if(args.outcome !== undefined && args.outcome !== 'verified') return false;
 if(w.status !== 'verified' || !empty(w.unmetCheckIds) || cert.workId !== w.workId || !nonempty(cert.id) || !nonempty(cert.fingerprint) || !nonempty(cert.contractHash) || !list(cert.evidenceIds) || !list(cert.sourceIds) || JSON.stringify(cert.sourceIds) !== JSON.stringify(w.sourceIds)) return false;
 if(!['version','methodEpoch','mutationEpoch'].every(k=>cert[k] === w[k])) return false;
 return cert.evidenceIds.every((id: string)=>w.evidence.some((raw: unknown)=>{
  const e=object(raw);
  return e.id === id && raw === latest(e.checkId) && passed(e) && e.after === cert.fingerprint && e.contractHash === cert.contractHash;
 }));
}

/** Anchored tool-boundary messages, never arbitrary program stdout/stderr. */
export function schemaErrorTool(s: Step): string | null {
 if(s.kind !== 'call' || s.ok !== false) return null;
 if(s.tool === 'bash' && typeof object(s.args).command === 'string') return null;
 const first=(s.output ?? '').split(String.fromCharCode(10))[0] ?? '';
 const validation=/^(?:Error: )?Validation failed for tool ["']([\w.-]+)["'](?:[:.]|$)/.exec(first);
 if(validation && (validation[1] === s.tool || s.tool === 'codemode')) return validation[1]!;
 const unknown=/^(?:Error: )?Unknown tool:? ["']?([\w.-]+)["']?[.]?$/.exec(first);
 if(unknown && (unknown[1] === s.tool || s.tool === 'codemode')) return unknown[1]!;
 if(s.tool === 'codemode') return /^(?:TypeError: )?tools\.([\w$]+) is not a function$/.exec(first)?.[1] ?? null;
 return null;
}
