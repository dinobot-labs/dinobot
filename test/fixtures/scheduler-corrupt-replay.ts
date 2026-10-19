import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const path = process.argv[2]!;
let reports = 0;
const open = async () => Harness.open(await openNodeSqliteStorage(path), {
	models: createModels(), registry: createRegistry(), onReport() { reports++; },
}, context);
let harness = await open();
const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
await conversation.submit({ type: "input", content: "offline fixture" }, context);
await harness.close(context);
const db = new Database(path);
const row = db.query("SELECT id FROM documents WHERE owner_id = ? AND json_extract(record, '$.kind') = 'pi.live'").get(conversation.id) as { id: number };
const meta = db.query("SELECT next_seq FROM durable_metadata").get() as { next_seq: number };
db.query("INSERT INTO document_revisions VALUES (?, ?, 'delta', 1, ?)").run(row.id, meta.next_seq, JSON.stringify([["s", ["generation", "message", "missing"], "invalid"]]));
db.query("UPDATE durable_metadata SET next_seq = next_seq + 1").run();
db.close();
harness = await open();
harness.resume();
await new Promise(resolve => setTimeout(resolve, 150));
const first = reports;
await new Promise(resolve => setTimeout(resolve, 150));
const inspected = await harness.inspect(context);
// Unrelated healthy work must still settle while the damaged task is quarantined.
const healthy = await harness.createConversation({ownership:{kind:"ownerless"}}, context);
const healthyResult = await (await healthy.submit({type:"input",content:"healthy offline"},context)).wait(context);
const afterHealthy = reports;
await new Promise(resolve => setTimeout(resolve, 100));
const stableAfterHealthy = reports === afterHealthy;
await harness.close(context);
const repaired = new Database(path);
repaired.query("DELETE FROM document_revisions WHERE document_id = ? AND seq = ?").run(row.id, meta.next_seq);
repaired.close();
harness = await open();
harness.resume();
const recoveredConversation = await harness.conversation(conversation.id, context);
if (!recoveredConversation) throw new Error("Recovered conversation missing");
await recoveredConversation.waitForIdle(context);
console.log(JSON.stringify({reopenedRecovery:true,heartbeat:true,first,reports:afterHealthy,stableAfterHealthy,healthy:healthyResult.status,inspected}));
await harness.close(context);
