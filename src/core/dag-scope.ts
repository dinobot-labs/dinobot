import type { RunState } from "./dag.ts";
import type { WorkState } from "./verification.ts";

/** Host-observed live input groups and immutable common answer entries, display only. */
export function dagDisplayInputs(inputs: readonly string[], work?: WorkState): string[] {
 const joined = new Set(inputs);
 for (const group of work?.displayInputGroups ?? []) if (group.some(id => joined.has(id))) for (const id of group) joined.add(id);
 return [...joined];
}

/** Display scope only. This must never grant goal admission, certification or acceptance. */
export function dagAnswerScope(run: RunState, inputs: readonly string[], work?: WorkState): "current" | "history" | "unknown" {
 if (!inputs.length) return "unknown";
 inputs = dagDisplayInputs(inputs, work);
 if (run.displaySourceIds?.some(id => inputs.includes(id))) return "current";
 if (run.sourceIds?.length) return run.sourceIds.some(id => inputs.includes(id)) ? "current" : "history";
 // Legacy runs did not capture submission IDs. Use only host-persisted human input
 // identity/time, never goal text, model declarations, keywords or the current activeId.
 const current = inputs.map(id => {
  const time = work?.inputTimes?.[id];
  return time && work?.humanInputs?.some(i => i.sourceId === id && i.entryId === time.entryId) ? time : undefined;
 });
 // Only persisted user-entry times strictly after both terminal timestamps exclude
 // history. Equal ticks, missing evidence, and inputs admitted while it ran are unknown.
 if (current.every(i => i && Number.isFinite(i.at) && i.at > Math.max(run.createdAt, run.updatedAt))) return "history";
 return "unknown";
}

export function selectAnswerDag(doc: { runs: readonly RunState[]; activeId?: string } | undefined, inputs: readonly string[]): RunState | undefined {
 const active = doc?.runs.find(r => r.id === doc.activeId);
 if (active?.owner) return active; // Never route around the research controller.
 // Host-bound compilation failures never become active. Prefer the newest run
 // captured from this exact input; retain activeId for missing/legacy lineage.
 return doc?.runs.findLast(r => !r.owner && [...(r.sourceIds ?? []), ...(r.displaySourceIds ?? [])].some(id => inputs.includes(id))) ?? active;
}

export function terminalDag(run: RunState): boolean {
 return run.status === "cancelled" || run.status === "verified";
}
