// Explicit maintenance tool; never run implicitly by tests or CI.
export function parseTimings(log: string): Record<string, number> {
  const files: Record<string, number> = {};
  let current: string | undefined;
  for (const line of log.split("\n")) {
    const header = line.match(/(?:##\[group\])?((?:[\w.-]+\/)*[^\s:]+[._](?:test|spec)\.[cm]?[jt]sx?):\s*$/);
    if (header) {
      current = header[1]!;
      if (current in files) throw new Error("duplicate file header: " + current);
      files[current] = 0;
    } else if (current && /\((?:pass|fail)\)/.test(line)) {
      const duration = line.match(/\[([\d.]+)ms\]\s*$/);
      if (duration) files[current]! += Number(duration[1]);
    }
  }
  if (!Object.keys(files).length) throw new Error("no Bun file timings found");
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, ms]) => [file, Math.round(ms * 100) / 100]));
}

if (import.meta.main) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("usage: bun script/ci/import-functional-timings.ts <gh-job.log> <output.json>");
  const log = await Bun.file(input).text();
  if (!/(?:^|\s)0 fail(?:\s|$)/m.test(log) || !/Ran 4075 tests across 337 files/.test(log)) throw new Error("expected successful seed run: 4075 tests, 337 files");
  const files = parseTimings(log);
  if (Object.keys(files).length !== 337) throw new Error("incomplete seed: expected 337 headers");
  await Bun.write(output, JSON.stringify({
    source: "https://github.com/dinobot-labs/dinobot/actions/runs/41201191726/job/124537167422",
    sourceSha: "e4046f8984bd7f2364c3fea097b48824ea298f2a",
    method: "Sum Bun per-test [ms] durations per file (not whole-file wall time); successful 4075 tests / 337 files / 977.71s run",
    files,
  }, null, 2) + "\n");
}
