/**
 * Entry for every generated page (home, privacy, 404). Styles in layer order, then the page behaviours.
 * The mascot, runner and showcase modules are owned by other nodes; only their public mount functions are used.
 */
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/sections.css";

import { initialDino, mountDinoSwitch } from "./app/dino.ts";
import { mountChat, mountPillSwap } from "./app/hero.ts";
import { $all, locale } from "./app/env.ts";
import { mountDownload } from "./app/download.ts";
import { mountGlyphs } from "./app/glyphs.ts";
import { mountAssemble, mountMarquee, mountRevealFallback, mountWords } from "./app/motion.ts";
import { mountFormLinks, mountLocaleToggle, mountNavRule, mountScrollSpy } from "./app/nav.ts";
import { mountWaitlist } from "./app/waitlist.ts";
import { type MascotHandle, type MascotState, mountMascot } from "./mascot/index.ts";
import { type RunnerHandle, mountRunner } from "./runner/index.ts";
import { mountShowcase } from "./showcase/index.ts";

/** Runs one mount step; a failing module must never take the rest of the page (or the form) down with it. */
function safely(name: string, fn: () => void): void {
	try {
		fn();
	} catch (error) {
		console.error(`[dinobot] ${name} failed to mount`, error);
	}
}

const lang = locale();
const mascots = new Map<string, MascotHandle>();
let runner: RunnerHandle | undefined;
// The dinosaur theme (ADR 0100) is read before anything mounts, so a saved theme never flashes the default T-rex.
let dino = initialDino();

safely("waitlist", mountWaitlist);
safely("download", mountDownload);
safely("nav", () => {
	mountNavRule();
	mountFormLinks();
	mountLocaleToggle();
	mountScrollSpy();
});
safely("glyphs", () => mountGlyphs());
safely("mascots", () => {
	for (const host of $all("[data-mascot-host]")) {
		for (const fallback of $all("[data-mascot-fallback]", host)) fallback.remove();
		const handle = mountMascot(host, {
			state: (host.dataset.mascotState as MascotState | undefined) ?? "idle",
			trackPointer: host.hasAttribute("data-mascot-track"),
			label: host.dataset.mascotLabel,
			species: dino,
		});
		mascots.set(host.dataset.mascotHost ?? "", handle);
	}
});
safely("hero", () => {
	mountPillSwap();
	const chat = document.querySelector<HTMLElement>("[data-chat]");
	if (chat) mountChat(chat, mascots.get("hero"));
});
safely("motion", () => {
	mountWords();
	mountRevealFallback();
	mountAssemble();
	mountMarquee();
});
safely("showcase", () => {
	if (!document.querySelector("[data-scene]")) return;
	const showcase = mountShowcase(document, { locale: lang });
	// QA only (qa/scenes.mjs): ?qa-freeze exposes freeze(scene, ms) to review every moment of every loop.
	if (location.search.includes("qa-freeze")) (window as unknown as { __showcase?: typeof showcase }).__showcase = showcase;
});
safely("runner", () => {
	const host = document.querySelector<HTMLElement>("[data-runner]");
	if (host) runner = mountRunner(host, { locale: lang, species: dino });
});
safely("dino", () =>
	mountDinoSwitch((id) => {
		dino = id;
		for (const handle of mascots.values()) handle.setSpecies(id);
		runner?.setSpecies(id);
	}),
);

document.body.dataset.ready = "1";
