/**
 * Dinosaur themes on the page (ADR 0100). A theme is one species of src/brand/species.ts: it swaps the mascot (every
 * mounted one, the runner and the head marks) and the accent family (`:root[data-dino]` in tokens.css). Status
 * colors, text and surfaces never change.
 *
 *   initialDino()           the saved choice (localStorage 'dn-dino'), applied to <html data-dino> right away; call it
 *                           before anything mounts so no T-rex flashes in before a saved pterosaur
 *   mountDinoSwitch(fn)     wires every [data-dino-switch] radiogroup; a choice applies, persists and calls fn(id)
 *
 * Markup (src/pages/home.html): a `[data-dino-switch]` element with role radiogroup, hidden until this module runs,
 * holding one `button[role=radio][data-dino-option=<id>]` per species. Arrow keys move the choice (radio semantics,
 * roving tabindex); Space/Enter and click choose. `img[data-dino-mark]` heads follow the theme.
 */
import { DEFAULT_SPECIES, isSpeciesId, type SpeciesId } from "../../brand/species.ts";
import { $all } from "./env.ts";

export const DINO_STORE = "dn-dino";
/** Window event fired after every theme change (detail: the species id), for modules that build their own mascots. */
export const DINO_EVENT = "dinobot:dino";

/** The theme currently on <html data-dino> (the T-rex before initialDino or on a page without one). */
export function documentDino(): SpeciesId {
	const value = document.documentElement.dataset.dino;
	return isSpeciesId(value) ? value : DEFAULT_SPECIES;
}

/** The head mark image of a species (scripts/build-assets.mjs); the T-rex keeps the original file. */
export const markSrc = (id: SpeciesId): string => (id === DEFAULT_SPECIES ? "/brand/mark.svg" : `/brand/species/${id}/mark.svg`);

function load(): SpeciesId {
	try {
		const value = window.localStorage.getItem(DINO_STORE);
		return isSpeciesId(value) ? value : DEFAULT_SPECIES;
	} catch {
		return DEFAULT_SPECIES;
	}
}

function save(id: SpeciesId): void {
	try {
		window.localStorage.setItem(DINO_STORE, id);
	} catch {
		/* storage blocked: the theme lasts for this page view only */
	}
}

let current: SpeciesId = DEFAULT_SPECIES;

export const currentDino = (): SpeciesId => current;

/** Sets <html data-dino>, the head marks and every switch's checked state. Idempotent. */
export function applyDino(id: SpeciesId): void {
	current = id;
	const root = document.documentElement;
	if (root.dataset.dino !== id) root.dataset.dino = id;
	for (const img of $all<HTMLImageElement>("img[data-dino-mark]")) {
		const src = markSrc(id);
		if (img.getAttribute("src") !== src) img.setAttribute("src", src);
	}
	for (const option of $all<HTMLButtonElement>("[data-dino-option]")) {
		const on = option.dataset.dinoOption === id;
		option.setAttribute("aria-checked", on ? "true" : "false");
		option.tabIndex = on ? 0 : -1;
	}
}

/** Reads the saved theme and applies it. Call first, before the mascots and the runner mount. */
export function initialDino(): SpeciesId {
	const id = load();
	applyDino(id);
	return id;
}

/** Wires the theme switchers. `onChange` runs once per actual change (mascots, runner). */
export function mountDinoSwitch(onChange: (id: SpeciesId) => void): void {
	const choose = (id: SpeciesId, focus?: HTMLElement) => {
		if (id !== current) {
			applyDino(id);
			save(id);
			onChange(id);
			window.dispatchEvent(new CustomEvent(DINO_EVENT, { detail: id }));
		}
		focus?.focus();
	};
	for (const group of $all("[data-dino-switch]")) {
		const options = $all<HTMLButtonElement>("[data-dino-option]", group);
		group.addEventListener("click", (event) => {
			const option = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-dino-option]");
			const id = option?.dataset.dinoOption;
			if (option && isSpeciesId(id)) choose(id);
		});
		group.addEventListener("keydown", (event) => {
			const index = options.findIndex((o) => o === document.activeElement);
			if (index < 0) return;
			const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
			const target = step
				? options[(index + step + options.length) % options.length]
				: event.key === "Home"
					? options[0]
					: event.key === "End"
						? options[options.length - 1]
						: undefined;
			const id = target?.dataset.dinoOption;
			if (!target || !isSpeciesId(id)) return;
			event.preventDefault();
			choose(id, target);
		});
		group.hidden = false;
	}
	applyDino(current);
}
