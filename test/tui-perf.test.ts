import { beforeAll, expect, test } from "bun:test";
import { BUDGETS, FIRST_RENDER_BUDGET_MS, formatReport, type Report, runAll } from "../script/bench/tui-render.ts";

let report: Report;

beforeAll(() => {
	report = runAll();
}, 60_000);

test("first full render of a 500-entry transcript stays within budget", () => {
	expect(report.firstRender, `first render ${report.firstRender.toFixed(2)}ms > ${FIRST_RENDER_BUDGET_MS}ms\n${formatReport(report)}`).toBeLessThanOrEqual(FIRST_RENDER_BUDGET_MS);
});

for (const name of Object.keys(BUDGETS)) {
	test(`${name}: per-frame mean and p95 stay within budget`, () => {
		const stats = report.scenarios.find((s) => s.name === name);
		const budget = BUDGETS[name];
		if (!stats || !budget) throw new Error(`scenario ${name} missing from report`);
		const numbers = `${name}: frames=${stats.frames} mean=${stats.mean.toFixed(3)}ms p95=${stats.p95.toFixed(3)}ms max=${stats.max.toFixed(3)}ms (budget mean<=${budget.mean} p95<=${budget.p95})\n${formatReport(report)}`;
		expect(stats.frames, numbers).toBeGreaterThanOrEqual(20);
		expect(stats.mean, numbers).toBeLessThanOrEqual(budget.mean);
		expect(stats.p95, numbers).toBeLessThanOrEqual(budget.p95);
	});
}
