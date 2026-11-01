/**
 * /design/ "Dinosaur themes" specimens (ADR 0100): per species of src/brand/species.ts the idle mascot, every pose,
 * the head mark, the favicon, the five named body stops and the theme's accent family with live contrast ratios.
 * Everything is built from the canonical brand renderers; colors are SVG fill attributes or custom properties set
 * through CSSOM (CSP-safe).
 */
import { POSE_NAMES, SPECIES, SPECIES_IDS, type SpeciesId, markSprite, poseSprite, renderFaviconSvg } from "../../brand/mascot.ts";
import { contrastRatio, formatRatio, grade } from "./contrast.ts";
import { renderSprite } from "./dots.ts";

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...children: Child[]): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	for (const child of children) if (child) node.append(child);
	return node;
}

/** Parses one of our own pure SVG strings (renderFaviconSvg) into a node of this document. */
function svgNode(markup: string, label: string): Element {
	const svg = document.importNode(new DOMParser().parseFromString(markup, "image/svg+xml").documentElement, true);
	svg.setAttribute("role", "img");
	svg.setAttribute("aria-label", label);
	return svg;
}

function figure(cls: string, art: Element, caption: string): HTMLElement {
	const f = h("figure", cls, art, h("figcaption", "sg-cap", caption));
	return f;
}

function swatch(color: string, name: string, detail: string, fg?: string): HTMLElement {
	const chip = h("span", "sg-theme__chip", fg ? "Aa" : "");
	chip.style.setProperty("--sg-bg", color);
	if (fg) chip.style.setProperty("--sg-fg", fg);
	return h("div", "sg-theme__swatch", chip, h("span", undefined, h("b", undefined, name), detail));
}

function speciesCard(id: SpeciesId, token: (name: string) => string): HTMLElement {
	const s = SPECIES[id];
	const name = `${s.name.en} · ${s.name.ko}`;
	const head = h(
		"header",
		"sg-theme__head",
		h("p", "t-label sg-theme__theme", `${s.theme}${id === "rex" ? " · default" : ""}`),
		h("h3", "sg-h3", s.name.en, h("span", "sg-theme__ko", ` ${s.name.ko}`)),
		h("code", undefined, `data-dino="${id}"`),
	);
	const hero = figure("sg-theme__idle", renderSprite(poseSprite("idle", undefined, id), { unlit: true, label: `dinobot ${s.name.en}, idle` }), "idle");

	const poses = h("div", "sg-theme__poses");
	for (const pose of POSE_NAMES) poses.append(figure("sg-theme__pose", renderSprite(poseSprite(pose, undefined, id), { label: `${s.name.en}, ${pose}` }), pose));

	const marks = h(
		"div",
		"sg-theme__marks",
		figure("sg-theme__mark", renderSprite(markSprite(id), { fill: 0.8, label: `${s.name.en} head mark` }), "mark"),
		figure("sg-theme__favicon", svgNode(renderFaviconSvg(id), `${s.name.en} favicon`), "favicon"),
	);

	const stops = h("div", "sg-theme__stops");
	s.stops.forEach((stop, i) => {
		const bar = h("span", "sg-theme__stop", h("b", undefined, s.stopNames[i] ?? ""), stop);
		bar.style.setProperty("--sg-c", stop);
		stops.append(bar);
	});

	const paper = token("bg");
	const white = token("surface");
	const v = (k: string) => token(`dino-${id}${k}`);
	const deepPaper = contrastRatio(v("-deep"), paper) ?? 0;
	const deepTint = contrastRatio(v("-deep"), v("-tint")) ?? 0;
	const accent = h(
		"div",
		"sg-theme__accent",
		swatch(`var(--dino-${id})`, "--accent", `${v("").toUpperCase()} · fill only`),
		swatch(`var(--surface)`, "--accent-deep", `${v("-deep").toUpperCase()} · paper ${formatRatio(deepPaper)} ${grade(deepPaper)} · white ${formatRatio(contrastRatio(v("-deep"), white) ?? 0)}`, `var(--dino-${id}-deep)`),
		swatch(`var(--dino-${id}-tint)`, "--accent-tint", `${v("-tint").toUpperCase()} · deep ${formatRatio(deepTint)} ${grade(deepTint)}`, `var(--dino-${id}-deep)`),
		swatch(`var(--dino-${id}-soft)`, "--accent-soft", `${v("-soft").toUpperCase()} · also --selection · ink ${formatRatio(contrastRatio(token("text-1"), v("-soft")) ?? 0)}`, "var(--text-1)"),
	);

	const card = h(
		"article",
		"sg-theme",
		head,
		h("div", "sg-theme__top", hero, marks),
		h("p", "t-label sg-theme__label", "Body stops, tail to head"),
		stops,
		h("p", "t-label sg-theme__label", "Accent family"),
		accent,
		h("p", "t-label sg-theme__label", `Every pose · ${POSE_NAMES.length}`),
		poses,
	);
	card.setAttribute("aria-label", name);
	card.dataset.species = id;
	return card;
}

/** Fills `[data-sg="dinos"]`. `token` reads a live custom property (without the leading --). */
export function renderThemes(host: HTMLElement, token: (name: string) => string): void {
	for (const id of SPECIES_IDS) host.append(speciesCard(id, token));
}
