import { readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const testName = /[._](?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

// Bun default naming, never the timing profile, defines coverage.
export async function discoverTests(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) {
        // The landing job owns all tests in its isolated DOM/Worker package.
        if (!entry.name.startsWith(".") && entry.name !== "node_modules" && name !== "services/landing") {
          await visit(join(directory, entry.name), name + "/");
        }
      } else if (entry.isFile() && testName.test(entry.name) && entry.name !== "tui-perf.test.ts") {
        files.push(name);
      }
    }
  }
  await visit(root, "");
  return files.sort(compare);
}

export function partitionTests(files: string[], timings: Record<string, number>, count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 2) throw new Error("shard count must be 1 or 2");
  if (!files.length || new Set(files).size !== files.length) throw new Error("empty or duplicate test discovery");
  const values = Object.values(timings);
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error("invalid timing profile");
  const sorted = values.filter(value => value > 0).sort((a, b) => a - b);
  const fallback = sorted[Math.floor(sorted.length / 2)] ?? 1000;
  const weight = (file: string) => Math.max(timings[file] ?? fallback, 1);
  const buckets = Array.from({ length: count }, () => ({ files: [] as string[], estimatedMs: 0 }));
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || compare(a, b))) {
    const bucket = buckets.reduce((a, b) => b.estimatedMs < a.estimatedMs ? b : a);
    bucket.files.push(file);
    bucket.estimatedMs += weight(file);
  }
  for (const bucket of buckets) bucket.files.sort(compare);
  if (buckets.some(bucket => bucket.files.length === 0)) throw new Error("empty shard");
  return buckets;
}

export function exactTestArguments(files: string[]) {
  if (!files.length || files.some(file => file.startsWith("/") || file.includes("\\") || file.split("/").some(part => part === ".." || part === "." || !part))) {
    throw new Error("invalid or empty file selection");
  }
  // A bare path is a substring filter in Bun. ./ makes it an exact file.
  return files.map(file => "./" + file);
}

async function main() {
  const [selection, ...extra] = process.argv.slice(2);
  if (!selection || !/^[12]\/[12]$/.test(selection) || extra.some(arg => arg !== "--list") || extra.length > 1) {
    throw new Error("usage: bun script/ci/functional-shard.ts <1/1|1/2|2/2> [--list]");
  }
  const [index, count] = selection.split("/").map(Number) as [number, number];
  if (index > count) throw new Error("unknown shard");
  const root = process.cwd();
  const profile = await Bun.file(new URL("./functional-timings.json", import.meta.url)).json();
  const files = await discoverTests(root);
  const buckets = partitionTests(files, profile.files, count);
  const bucket = buckets[index - 1]!;
  const report = { selection, discovered: files.length, ...bucket };
  if (extra[0] === "--list") { console.log(JSON.stringify(report, null, 2)); return; }
  const output = resolve(root, "reports", "functional-" + index + "-of-" + count);
  await mkdir(output, { recursive: true });
  await writeFile(join(output, "selection.json"), JSON.stringify(report, null, 2) + "\n");
  const args = exactTestArguments(bucket.files);
  const child = Bun.spawn([process.execPath, "test", "--reporter=junit", "--reporter-outfile=" + join(output, "junit.xml"), ...args], {
    cwd: root, env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const forwardTerm = () => child.kill("SIGTERM");
  const forwardInt = () => child.kill("SIGINT");
  process.on("SIGTERM", forwardTerm);
  process.on("SIGINT", forwardInt);
  const code = await child.exited;
  process.off("SIGTERM", forwardTerm);
  process.off("SIGINT", forwardInt);
  if (child.signalCode) {
    process.kill(process.pid, child.signalCode);
    process.exit(1);
  }
  process.exitCode = code;
}

if (import.meta.main) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
