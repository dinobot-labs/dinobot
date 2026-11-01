/**
 * Renders a strength scene model (scripts.ts) into a fixed STAGE_W x STAGE_H stage that is scaled to fit its host,
 * and wires its timeline to visibility, reduced motion and a pause/play control.
 */
import { isSpeciesId } from "../../brand/species.ts";
import { DINO_EVENT, documentDino } from "../app/dino.ts";
import { mountMascot, type MascotHandle } from "../mascot/index.ts";
import { type Entry, type Registry, Timeline, setArm, setPointer } from "./engine.ts";
import { glyph, h, loader, mark, place, s } from "./dom.ts";
import { edgeDots, rectOf, ringDots } from "./geometry.ts";
import type { Labels } from "./labels.ts";
import { STAGE_H, STAGE_W, type Item, type SceneModel, findItem } from "./scripts.ts";

export interface Unit {
	setVisible(visible: boolean): void;
	setReduced(reduced: boolean): void;
	/** QA/lab: freeze at timeline time t (ms). */
	freeze(t: number): void;
	destroy(): void;
}

function text(cls: string, value: string): HTMLElement {
	return h("span", cls, value);
}

/** Build one item; returns its element and registers entries (an item may register sub-entries). */
function build(item: Item, model: SceneModel, labels: Labels, reg: Registry, cleanups: (() => void)[]): HTMLElement | SVGElement {
	const L = (k?: keyof Labels) => (k ? labels[k] : "");
	const init = { s: item.init ?? "off" } as Entry["init"];
	let el: HTMLElement | SVGElement;
	const entry: Partial<Entry> = {};
	switch (item.type) {
		case "bubble": {
			el = h("div", "sc-bubble");
			el.dataset.look = item.look ?? "user";
			const av = item.look === "bot" ? mark("sc-av sc-av--bot") : h("span", "sc-av", item.sub ? L(item.sub) : "");
			av.setAttribute("aria-hidden", "true");
			const t = text("sc-bubble__t", L(item.label));
			el.append(av, t);
			break;
		}
		case "node": {
			el = h("div", "sc-node");
			const st = h("span", "sc-st");
			st.append(loader("loader sc-st__run"), glyph("check", "sc-glyph sc-st__ok"));
			el.append(text("sc-node__kind", L(item.kind)), text("sc-node__t", L(item.label)), st);
			break;
		}
		case "edge": {
			const a = findItem(model.items, item.from!);
			const b = findItem(model.items, item.to!);
			const svg = s("svg", { class: "sc-edge", viewBox: `0 0 ${STAGE_W} ${STAGE_H}`, "aria-hidden": "true" });
			const dots: SVGElement[] = [];
			if (a && b) {
				for (const [cx, cy] of edgeDots(rectOf(a), rectOf(b), item.dir ?? "h")) {
					const c = s("circle", { cx, cy, r: 1.6 });
					svg.append(c);
					dots.push(c);
				}
			}
			entry.dots = dots;
			el = svg;
			break;
		}
		case "tag": {
			el = h("span", "sc-tag");
			el.dataset.look = item.look ?? "plain";
			if (item.glyph) el.append(glyph(item.glyph));
			const t = text("sc-tag__t", item.text ?? L(item.label));
			el.append(t);
			if (item.sub) el.append(text("sc-tag__sub", L(item.sub)));
			break;
		}
		case "row": {
			el = h("div", "sc-row");
			for (const child of item.children ?? []) el.append(build(child, model, labels, reg, cleanups));
			break;
		}
		case "btn": {
			const b = h("button", "sc-btn", L(item.label));
			b.type = "button";
			b.tabIndex = -1;
			b.dataset.look = item.look ?? "plain";
			el = b;
			break;
		}
		case "panel": {
			el = h("div", "sc-panel");
			el.append(glyph("ask", "sc-glyph sc-panel__g"), text("sc-panel__q", L(item.label)));
			if (item.sub) el.append(text("sc-panel__sub", L(item.sub)));
			break;
		}
		case "card": {
			el = h("div", "sc-card");
			if (item.glyph) el.append(glyph(item.glyph));
			const t = text("sc-card__t", L(item.label));
			el.append(t);
			entry.textEl = t;
			init.label = item.label;
			break;
		}
		case "stack": {
			el = h("div", "sc-stack");
			const head = h("div", "sc-stack__head");
			head.append(glyph("memory"), text("sc-stack__t", L(item.label)), text("sc-stack__sub", L(item.sub)));
			el.append(head, h("span", "sc-stack__plate"), h("span", "sc-stack__plate sc-stack__plate--2"));
			break;
		}
		case "track": {
			el = h("div", "sc-track");
			const who = h("span", "sc-track__who");
			who.append(h("span", "sc-track__dot"), text("sc-track__t", L(item.label)));
			const st = h("span", "sc-st");
			st.append(loader("loader sc-st__run"), glyph("check", "sc-glyph sc-st__ok"));
			el.append(who, text("sc-track__kind", L(item.kind)), st);
			break;
		}
		case "lead": {
			el = h("div", "sc-lead");
			el.append(mark("sc-lead__mark"), text("sc-lead__name", "dinobot"), text("sc-lead__role", L(item.label)));
			break;
		}
		case "counter": {
			el = h("div", "sc-counter");
			const v = text("sc-counter__v", item.text ?? "0");
			el.append(text("sc-counter__cap", L(item.label)), v);
			entry.valueEl = v;
			entry.tickEl = v;
			init.text = item.text ?? "0";
			break;
		}
		case "note": {
			el = h("div", "sc-note", L(item.label));
			break;
		}
		case "result": {
			el = h("div", "sc-result");
			el.append(glyph("check", "sc-glyph sc-result__g"), text("sc-result__t", L(item.label)));
			break;
		}
		case "station": {
			el = h("div", "sc-station");
			const top = h("span", "sc-station__top");
			if (item.glyph) top.append(glyph(item.glyph));
			top.append(text("sc-station__t", L(item.label)));
			el.append(top, text("sc-station__sub", L(item.sub)));
			break;
		}
		case "ring": {
			const r = item.r ?? 100;
			const svg = s("svg", { class: "sc-ring", viewBox: `${-r - 3} ${-r - 3} ${2 * r + 6} ${2 * r + 6}`, "aria-hidden": "true" });
			for (const [cx, cy] of ringDots(0, 0, r, item.n ?? 40)) svg.append(s("circle", { cx, cy, r: 1.5 }));
			place(svg, (item.x ?? 0) - r - 3, (item.y ?? 0) - r - 3, 2 * r + 6, 2 * r + 6);
			el = svg;
			break;
		}
		case "arm": {
			el = h("div", "sc-arm");
			const tok = h("span", "sc-arm__tok");
			tok.style.transform = `translate(-50%, -50%) translateY(${-(item.r ?? 100)}px)`;
			el.append(tok);
			init.rot = 0;
			break;
		}
		case "mascot": {
			el = h("div", "sc-mascot");
			let handle: MascotHandle | undefined;
			try {
				handle = mountMascot(el, { state: "idle", species: documentDino() });
			} catch {}
			entry.setPose = (pose: string) => handle?.setState(pose as never);
			if (handle) {
				// The dinosaur theme (ADR 0100) changes live; the scene's mascot follows it.
				const onDino = (event: Event) => {
					const id = (event as CustomEvent<unknown>).detail;
					if (isSpeciesId(id)) handle?.setSpecies(id);
				};
				window.addEventListener(DINO_EVENT, onDino);
				cleanups.push(() => {
					window.removeEventListener(DINO_EVENT, onDino);
					handle?.destroy();
				});
			}
			break;
		}
		case "badge": {
			el = h("span", "sc-badge");
			el.append(h("span", "sc-badge__dot"));
			break;
		}
		case "pointer": {
			el = h("span", "sc-ptr");
			el.append(h("span", "sc-ptr__core"));
			init.xy = item.xy ?? [0, 0];
			break;
		}
	}
	el.classList.add("sc-i");
	if (item.signal) el.setAttribute("data-signal", item.signal);
	if (item.type !== "ring" && item.type !== "edge" && item.type !== "pointer" && item.x !== undefined) {
		if (item.type === "arm") place(el, item.x, item.y);
		else place(el, item.x, item.y, item.w, item.type === "tag" ? undefined : item.h);
	}
	if (item.type === "tag" && item.w !== undefined) (el as HTMLElement).style.width = `${item.w}px`;
	el.setAttribute("data-s", init.s);
	const full: Entry = { ...(entry as object), el, init } as Entry;
	if (item.type === "btn" || item.type === "card" || item.type === "panel") {
		const r = rectOf(item);
		full.center = [r.x + r.w / 2, r.y + r.h / 2];
	}
	if (item.type === "pointer") setPointer(full, init.xy!);
	if (item.type === "arm") setArm(full, 0);
	reg.set(item.id, full);
	return el;
}

/**
 * Mount one strength scene into its host. The stage is STAGE_W x STAGE_H (4:3) and scales to fit the host
 * (letterboxed and centered), so the page should give the host `aspect-ratio: 4 / 3`.
 */
export function mountScene(host: HTMLElement, model: SceneModel, labels: Labels, reducedInit: boolean): Unit {
	host.classList.add("sc-host");
	host.setAttribute("data-signal", model.signal);
	host.dataset.mounted = "showcase";
	const stage = h("div", "sc-stage");
	stage.dataset.stage = model.name;
	stage.setAttribute("aria-hidden", "true");
	place(stage, 0, 0, STAGE_W, STAGE_H);
	const desc = h("p", "sr-only", labels[model.alt]);
	const reg: Registry = new Map();
	const cleanups: (() => void)[] = [];
	for (const item of model.items) stage.append(build(item, model, labels, reg, cleanups));

	const ctl = h("button", "sc-ctl");
	ctl.type = "button";
	ctl.append(h("span", "sc-ctl__icon"));
	host.append(stage, desc, ctl);

	let reduced = reducedInit;
	let visible = false;
	let userPaused = false;
	let userPlay = false; // reduced motion: a Play press runs the scene once
	let playedOnce = false;

	const tl = new Timeline({
		script: model.script,
		registry: reg,
		labels,
		stage,
		loop: !reduced,
		onEnd: () => {
			userPlay = false;
			playedOnce = true;
			sync();
		},
	});

	// Gate buttons: a real tap releases the hold early ("an ask node waits for a human tap").
	for (const step of model.script.steps) {
		if (!step.hold) continue;
		const btn = reg.get(step.id)?.el;
		btn?.addEventListener("click", () => tl.release(step.id));
	}

	function fit(): void {
		const w = host.clientWidth;
		const hh = host.clientHeight || (w * STAGE_H) / STAGE_W;
		const k = Math.min(w / STAGE_W, hh / STAGE_H) || 1;
		const x = (w - STAGE_W * k) / 2;
		const y = (hh - STAGE_H * k) / 2;
		stage.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
		// The control sits in the stage's reserved bottom-right corner (every layout keeps 40 x 40 stage px free).
		ctl.style.right = `${x + 6 * k}px`;
		ctl.style.bottom = `${y + 6 * k}px`;
	}
	const ro = new ResizeObserver(fit);
	ro.observe(host);
	fit();

	function sync(): void {
		const running = reduced ? userPlay : !userPaused;
		host.dataset.state = running ? "playing" : reduced ? "static" : "paused";
		const label = running ? "scene.pause" : reduced && playedOnce ? "scene.replay" : "scene.play";
		ctl.dataset.icon = running ? "pause" : "play";
		ctl.setAttribute("aria-label", labels[label]);
		if (running && visible && !document.hidden) tl.play();
		else tl.pause();
	}

	ctl.addEventListener("click", () => {
		if (reduced) {
			if (userPlay) {
				userPlay = false;
			} else {
				userPlay = true;
				host.classList.add("motion-ok");
				tl.seek(0);
			}
		} else {
			userPaused = !userPaused;
		}
		sync();
	});

	const onVis = () => sync();
	document.addEventListener("visibilitychange", onVis);

	function applyReduced(r: boolean): void {
		reduced = r;
		tl.o.loop = !r;
		userPlay = false;
		host.classList.toggle("motion-ok", false);
		if (r) {
			tl.pause();
			tl.seek(tl.duration);
		}
		sync();
	}
	if (reduced) applyReduced(true);
	else tl.seek(0);
	sync();

	return {
		setVisible(v) {
			visible = v;
			sync();
		},
		setReduced(r) {
			if (r !== reduced) applyReduced(r);
		},
		freeze(t) {
			userPaused = true;
			userPlay = false;
			sync();
			tl.seek(t);
		},
		destroy() {
			tl.destroy();
			ro.disconnect();
			document.removeEventListener("visibilitychange", onVis);
			for (const c of cleanups) c();
			stage.remove();
			desc.remove();
			ctl.remove();
			host.classList.remove("sc-host", "motion-ok");
			delete host.dataset.mounted;
			delete host.dataset.state;
		},
	};
}

export { Timeline };
