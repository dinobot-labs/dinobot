/**
 * Dev-only driver for the runner playground (lab/runner/index.html, served by `vite` at /lab/runner/). Not imported by
 * the site and not a build input; it lives here because Vite's inline html-proxy modules fail on this Windows path.
 * Exposes window.__runner = { handle, stats } for QA scripts.
 */
import { type Locale, type RunnerHandle, mountRunner, runnerStats } from "./index.ts";

const params = new URLSearchParams(location.search);
if (params.get("reset") === "1") {
	localStorage.removeItem("dinobot.runner.hi");
	localStorage.removeItem("dinobot.runner.minimized");
}
if (params.get("minimized") === "1") localStorage.setItem("dinobot.runner.minimized", "1");
const locale: Locale = params.get("locale") === "ko" ? "ko" : "en";
document.documentElement.lang = locale;
const host = document.querySelector<HTMLElement>("[data-runner]");
if (!host) throw new Error("lab: no [data-runner] host");
let handle: RunnerHandle = mountRunner(host, { locale });
(window as unknown as { __runner: unknown }).__runner = {
	get handle() {
		return handle;
	},
	stats: runnerStats,
};

const on = (name: string, fn: () => void) => document.querySelector(`[data-lab='${name}']`)?.addEventListener("click", fn);
on("celebrate", () => handle.celebrate());
on("joined", () => window.dispatchEvent(new CustomEvent("dinobot:joined", { detail: { position: 42 } })));
on("remount", () => {
	handle.destroy();
	handle = mountRunner(host, { locale });
});

const out = document.querySelector("[data-lab='stats']");
setInterval(() => {
	if (!out) return;
	const n = Math.min(runnerStats.frames, runnerStats.ring.length);
	const recent = Array.from(runnerStats.ring.subarray(0, n)).sort((a, b) => a - b);
	const p = (q: number) => (n ? (recent[Math.min(n - 1, Math.floor(q * n))] ?? 0).toFixed(3) : "-");
	out.textContent =
		`frames ${runnerStats.frames}  mean ${(runnerStats.total / Math.max(1, runnerStats.frames)).toFixed(3)} ms  ` +
		`p50 ${p(0.5)}  p99 ${p(0.99)}  max ${runnerStats.max.toFixed(3)} ms (JS per frame)\n` +
		`data-mode=${host.dataset.mode} data-dino=${host.dataset.dino} data-jumps=${host.dataset.jumps}`;
}, 500);
