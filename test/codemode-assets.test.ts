import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codemodeAssets } from "../src/codemode-assets.ts";

test("source codemode uses the TypeScript worker next to the source asset module", () => {
	expect(fileURLToPath(codemodeAssets.workerUrl)).toBe(resolve("src/codemode-worker.ts"));
});

test("compiled codemode resolves Bun JavaScript worker entry and completes real host RPC", () => {
	const root = mkdtempSync(join(tmpdir(), "dinobot-worker-assets-"));
	try {
		const entry = join(root, "main.ts");
		const binary = join(root, "probe");
		const worker = resolve("src/codemode-worker.ts");
		const runCellPath = resolve("src/core/codemode/worker.ts");
		writeFileSync(entry, "import {runCell} from " + JSON.stringify(runCellPath) + ";\nconst calls=[]; const result=await runCell({code:\"text(await tools.echo({value:2})); return 5;\",names:[\"echo\"],timeoutMs:3000,call:async(id,name,args)=>{calls.push({id,name,args});return 7;}}); console.log(JSON.stringify({result,calls})); if(result.error)process.exit(1);\n");
		const built = Bun.spawnSync([process.execPath, "build", "--compile", "--root", resolve("src"), entry, worker, "--outfile", binary], { stdout: "pipe", stderr: "pipe", timeout: 15000 });
		expect(built.exitCode, built.stderr.toString()).toBe(0);
		const invoked = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe", timeout: 5000 });
		if (invoked.exitCode !== 0) throw new Error("Standalone codemode failed: " + invoked.stdout.toString() + invoked.stderr.toString());
		expect(invoked.exitCode).toBe(0);
		const data = JSON.parse(invoked.stdout.toString());
		expect(data).toEqual({result:{output:["7"],value:5},calls:[{id:1,name:"echo",args:{value:2}}]});
	} finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);
