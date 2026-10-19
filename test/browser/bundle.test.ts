import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

test("packaged Bun host bundles private-file helpers and serves passive UI without Chrome", async () => {
 const root = await mkdtemp(join(import.meta.dir, ".bundle-"));
 try {
  const output = join(root, "browser-host.js");
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "../../src/plugins/browser/host.ts")], target: "bun", external: ["patchright"], outdir: root, naming: "browser-host.js" });
  expect(built.success).toBe(true);
  const path = join(root, "desktop.json");
  const proc = Bun.spawn([process.execPath, output], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, DINOBOT_BROWSER_CONFIG: JSON.stringify({ mode: "dedicated", browser: "chrome", profile: join(root, "unused"), userDataDir: root, humanize: false }), DINOBOT_BROWSER_DESKTOP: JSON.stringify({ path, port: 65534, token: "d".repeat(64) }) } });
  proc.stdin.write(JSON.stringify({ id: 1, cmd: "ui_state", args: {} }) + "\n"); proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(stderr).toBe(""); expect(code).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ id: 1, ok: true, result: { ui: { ok: true, state: { connected: false, mode: "dedicated" } } } });
  expect(existsSync(path)).toBe(false); expect(existsSync(join(root, "unused"))).toBe(false);
 } finally { await rm(root, { recursive: true, force: true }); }
});
