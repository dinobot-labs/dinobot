import { expect, test } from "bun:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { AskRecord } from "../src/core/ask.ts";
import { askNodeKeys, askNodeRefs, createRun } from "../src/core/dag.ts";
import { askNodeRecord } from "../src/extensions/dag.ts";
const main = 1 as ConversationId;
const plan = { nodes: [{ id: "q", kind: "ask" as const }, { id: "effect", kind: "act" as const, irreversible: true, writes: ["fixture"] }, { id: "v", kind: "verify" as const, reads: ["fixture"], covers: ["R"] }], edges: [["q", "effect"], ["effect", "v"]] as [string,string][], goal: { requirements: ["R"] } };
test("T05 legacy orchestrator approval without explicit node binding is unresolved, never guessed from timestamp", () => {
 const run = createRun("run", plan, 1); const refs = askNodeRefs(run, "q");
 const legacy: AskRecord = { id: "legacy", from: { conversationId: main }, to: "human", kind: "authority", refs, keys: askNodeKeys(run, refs), question: "approve fixture", default: "deny", createdAt: 1000, deadlineAt: 2000, state: "answered", answer: "approve", resolvedBy: "human:fixture", run: run.id };
 const asks = { asks: [legacy] }; const record = askNodeRecord(asks, run, "q", main, 1001);
 expect(record.id).not.toBe(legacy.id); expect(asks.asks[1]!.state).toBe("open"); expect(asks.asks[0]).toEqual(legacy);
});
