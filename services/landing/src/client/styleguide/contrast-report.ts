/**
 * Contrast report for every text/background and UI-boundary pair of the Signal Paper tokens.
 *   bun src/client/styleguide/contrast-report.ts [--json]
 * Reads src/client/styles/tokens.css, resolves var() chains, evaluates CONTRAST_PAIRS (contrast.ts) and prints a
 * table. Exit code 0 when every pair meets its minimum (text 4.5:1, large text and UI 3:1), 1 otherwise.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluatePairs, formatRatio, resolveTokensCss } from "./contrast.ts";

const tokensFile = join(import.meta.dir, "..", "styles", "tokens.css");
const tokens = resolveTokensCss(readFileSync(tokensFile, "utf8"));
const results = evaluatePairs((name) => tokens.get(name));
const failing = results.filter((r) => !r.pass);

if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ tokens: tokens.size, pairs: results.length, failing: failing.length, results }, null, "\t"));
} else {
	const rows = results.map((r) => [r.fg, r.fgValue, r.bg, r.bgValue, r.ratio === null ? "n/a" : formatRatio(r.ratio), `${r.min}`, r.kind, r.pass ? "pass" : "FAIL", r.use]);
	const head = ["fg", "fg hex", "bg", "bg hex", "ratio", "min", "kind", "result", "use"];
	const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => (row[i] ?? "").length)));
	const line = (cells: string[]) => cells.map((c, i) => (i === 4 || i === 5 ? c.padStart(widths[i] ?? 0) : c.padEnd(widths[i] ?? 0))).join("  ").trimEnd();
	console.log(line(head));
	console.log(widths.map((w) => "-".repeat(w)).join("  "));
	for (const row of rows) console.log(line(row));
	const lowest = results.filter((r) => r.ratio !== null).sort((a, b) => (a.ratio ?? 0) / a.min - (b.ratio ?? 0) / b.min)[0];
	console.log(
		`\n${results.length} pairs from ${tokens.size} tokens: ${results.length - failing.length} pass, ${failing.length} fail.` +
			(lowest ? ` Tightest margin: ${lowest.fg} on ${lowest.bg} ${formatRatio(lowest.ratio ?? 0)}:1 (min ${lowest.min}).` : ""),
	);
}
process.exit(failing.length ? 1 : 0);
