import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, LiveDoc, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
const harness = await Harness.open(await openNodeSqliteStorage(process.argv[2]!),{models:createModels(),registry:createRegistry()},context);
const id = Number(process.argv[3]) as ConversationId;
await harness.snapshot(LiveDoc,id,context);
console.log("ready");
for await (const _ of Bun.stdin.stream()) {
 try {await harness.commit(async tx=>{(await tx.doc(LiveDoc,id)).generation={attempt:99};},context); console.log("accepted");}
 catch(error) {console.log(error instanceof Error ? error.message : "unknown");}
 break;
}
await harness.close(context);
