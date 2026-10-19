// Compiled into a standalone binary by windows-native-containment.test.ts: process.execPath is then this binary,
// so the contained launcher must reach the embedded Bun through BUN_BE_BUN, exactly as a compiled dinobot host does.
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
const events: unknown[] = [];
let output = "";
const result = await new NodeExecutionEnv({ cwd: process.cwd() }).exec("echo compiled-contained; exit 3", { onOutput: text => { output += text; }, onProcess: event => { events.push({ ...event }); } }, context);
console.log(JSON.stringify({ execPath: process.execPath, result: result.ok ? result.value : String(result.error), output, events }));
