import { existsSync } from "node:fs";

/**
 * Keep next to main.ts: Bun's compiled worker entry resolves from this directory.
 * Source runs load the TypeScript entry; `bun build --compile` stores extra entrypoints as `.js` in its
 * virtual file system (`/$bunfs/root/codemode-worker.js`), so a missing `.ts` sibling selects the `.js` one.
 * The npm release build replaces this module with a fixed `.js` URL (script/release.ts).
 */
const source = new URL("./codemode-worker.ts", import.meta.url);
export const codemodeAssets = { workerUrl: existsSync(source) ? source : new URL("./codemode-worker.js", import.meta.url) };
