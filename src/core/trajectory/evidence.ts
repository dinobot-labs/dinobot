import type { Step, StepProvenance } from "./types.ts";

export const ARGUMENT_LIMITS = { characters: 65536, nodes: 4096, depth: 32 } as const;
export const EVIDENCE_LIMITS = { nodes: 8000, links: 4000 } as const;

/** Full JSON identity, not display text. Reject missing, non-JSON and oversized
 * values rather than assigning them a shared sentinel identity. No input mutation. */
export function canonicalArguments(args: unknown): string | undefined {
 let nodes = 0, characters = 0;
 const active = new Set<object>();
 const emit = (s: string) => { characters += s.length; if (characters > ARGUMENT_LIMITS.characters) throw 0; return s; };
 const encode = (value: unknown, depth: number): string => {
  if (++nodes > ARGUMENT_LIMITS.nodes || depth > ARGUMENT_LIMITS.depth) throw 0;
  if (value === null) return emit("null");
  if (typeof value === "string") { if (value.length > ARGUMENT_LIMITS.characters) throw 0; return emit(JSON.stringify(value)); }
  if (typeof value === "boolean") return emit(String(value));
  if (typeof value === "number" && Number.isFinite(value)) return emit(Object.is(value, -0) ? "-0" : String(value));
  if (typeof value !== "object" || !value || active.has(value)) throw 0;
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw 0;
  if (Reflect.ownKeys(value).length > ARGUMENT_LIMITS.nodes || Object.getOwnPropertySymbols(value).length) throw 0;
  active.add(value);
  let result: string;
  if (array) {
   if (value.length > ARGUMENT_LIMITS.nodes || Object.keys(value).length !== value.length) throw 0;
   result = emit("[") + Array.from({length:value.length}, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !("value" in d)) throw 0;
    return (i ? emit(",") : "") + encode(d.value, depth + 1);
   }).join("") + emit("]");
  } else {
   const keys = Object.keys(value).sort();
   if (Reflect.ownKeys(value).length !== keys.length) throw 0;
   result = emit("{") + keys.map((key, i) => {
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in d) || key.length > ARGUMENT_LIMITS.characters) throw 0;
    return (i ? emit(",") : "") + emit(JSON.stringify(key)) + emit(":") + encode(d.value, depth + 1);
   }).join("") + emit("}");
  }
  active.delete(value);
  return result;
 };
 try {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  return encode(args, 0);
 } catch { return undefined; }
}

/** Strict result-before-invocation proof. No inference from content order inside a cell. */
export function resultBefore(a: Step, b: Step): boolean {
 if (!a.order && !b.order) return a.n < b.n;
 return a.order?.result !== undefined && b.order !== undefined && a.order.result < b.order.invoked;
}

/** Whether missing/overlapping bounds leave sequencing unresolved. A fully
 * completed earlier check is not an overlapping check of a later mutation. */
export function orderUnresolved(a: Step, b: Step): boolean {
 if (!a.order && !b.order) return false;
 if (resultBefore(a, b) || resultBefore(b, a)) return false;
 return true;
}

export type EvidenceNode = { id: string; kind: "user" | "assistant" | "call" | "result"; provenance: StepProvenance; step?: number };
export type EvidenceLink = { kind: "call-result" | "root-child"; from: string; to: string };
/** Only the adapter supplies validated links; this builder enforces bounded,
 * closed references and keeps source bodies out of the report. */
export function evidenceGraph(nodes: EvidenceNode[], links: EvidenceLink[]) {
 const kept = [...new Map(nodes.slice(0, EVIDENCE_LIMITS.nodes).map(n => [n.id, n])).values()];
 const ids = new Set(kept.map(n => n.id));
 const valid = links.slice(0, EVIDENCE_LIMITS.links).filter(l => ids.has(l.from) && ids.has(l.to));
 return { nodes: kept, links: valid, truncated: nodes.length > EVIDENCE_LIMITS.nodes || links.length > EVIDENCE_LIMITS.links,
  summary: { nodes: kept.length, callResultLinks: valid.filter(l => l.kind === "call-result").length, rootChildLinks: valid.filter(l => l.kind === "root-child").length,
   modelAssistant: kept.filter(n => n.kind === "assistant" && n.provenance.origin === "model").length,
   hostAssistant: kept.filter(n => n.kind === "assistant" && n.provenance.origin === "host").length },
  originalProviderContext: "UNKNOWN" as const, consumption: "UNKNOWN" as const, originMeaning: "retained entry kind; host does not identify the original token producer" as const, limits: EVIDENCE_LIMITS };
}
