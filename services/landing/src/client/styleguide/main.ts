/**
 * /design/ living style guide (src/pages/design.html). Renders token specimens from the computed style, so the
 * page always shows what tokens.css ships, and wires the live demos. Styles: tokens, base, components and the
 * guide's own layout (styleguide.css). No framework, no inline styles (CSP): values go through CSSOM.
 */
import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/components.css";
import "./styleguide.css";
import { evaluatePairs, formatRatio, grade, type PairResult, SIGNALS, contrastRatio } from "./contrast.ts";
import { DURATIONS, EASINGS, NEUTRALS, RADII, ROLES, SIGNAL_ROLES, SPACE, TYPE_SCALE, Z_INDEX } from "./data.ts";
import { type DinoState, GLYPHS, renderDino, renderGlyph } from "./dots.ts";
import { renderThemes } from "./themes.ts";

const root = document.documentElement;
const computed = getComputedStyle(root);
const token = (name: string): string => computed.getPropertyValue(`--${name}`).trim();
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...children: Child[]): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	for (const child of children) if (child) node.append(child);
	return node;
}
const setVar = (node: HTMLElement, name: string, value: string) => node.style.setProperty(name, value);
const $all = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document) => [...scope.querySelectorAll<T>(sel)];

const NEUTRAL_NAMES = NEUTRALS.map((n) => n.name);
const ALL_COLOR_NAMES = [
	...NEUTRAL_NAMES,
	"white",
	...SIGNALS.flatMap((s) => [s, `${s}-deep`, `${s}-tint`, `${s}-soft`]),
	"red",
	"red-deep",
	"red-tint",
	"red-soft",
];
/** Which palette token a role resolves to ("n-1"), by value. */
function paletteName(value: string): string | undefined {
	const v = value.toLowerCase();
	return ALL_COLOR_NAMES.find((n) => token(n).toLowerCase() === v);
}
/** Display form: #RRGGBB (the build minifier may shorten #ffffff to #fff). */
const hex = (value: string) => {
	const v = value.trim();
	return (/^#[0-9a-f]{3}$/i.test(v) ? `#${[...v.slice(1)].map((c) => c + c).join("")}` : v).toUpperCase();
};

// ---------------------------------------------------------------- color

function renderNeutrals(host: HTMLElement) {
	const paper = token("n-1");
	for (const n of NEUTRALS) {
		const value = token(n.name);
		const ratio = contrastRatio(value, paper) ?? 0;
		const g = grade(ratio);
		const chip = h("span", "sg-swatch__chip");
		setVar(chip, "--sg-c", `var(--${n.name})`);
		const label = g === "fail" ? "fill" : g === "AA large" ? "3:1" : g;
		const gradeEl = h("span", g === "fail" ? "sg-grade sg-grade--fill" : "sg-grade", label);
		host.append(
			h(
				"div",
				"sg-swatch",
				chip,
				h("span", "sg-swatch__name", `--${n.name}`),
				h("span", undefined, hex(value)),
				h("span", undefined, `${formatRatio(ratio)}`, gradeEl),
				h("span", "sg-swatch__role", n.role),
			),
		);
	}
}

function signalRow(sample: HTMLElement, name: string, detail: string) {
	const info = h("div", undefined, h("b", undefined, name), detail);
	return h("div", "sg-signal__row", sample, info);
}

function renderSignals(host: HTMLElement) {
	const paper = token("n-1");
	const list: { key: string; title: string; chapter: string; role: string }[] = [
		...SIGNALS.map((s) => ({ key: s, title: s, chapter: SIGNAL_ROLES[s].chapter, role: SIGNAL_ROLES[s].role })),
		{ key: "red", title: "red", chapter: "Errors", role: "Error dots and text; the mascot's cheek" },
	];
	for (const s of list) {
		const solid = h("div", "sg-signal__solid", h("span", "sg-signal__chapter", s.chapter), h("span", "sg-signal__name", s.title));
		setVar(solid, "--sg-c", `var(--${s.key})`);
		const solidRatio = contrastRatio(token(s.key), paper) ?? 0;
		const deepRatio = contrastRatio(token(`${s.key}-deep`), paper) ?? 0;
		const tintRatio = contrastRatio(token(`${s.key}-deep`), token(`${s.key}-tint`)) ?? 0;
		const chip = (bg: string, fg: string | null, text = "Aa") => {
			const c = h("span", "sg-signal__chip", fg ? text : "");
			setVar(c, "--sg-bg", bg);
			if (fg) setVar(c, "--sg-fg", fg);
			return c;
		};
		host.append(
			h(
				"article",
				"sg-signal",
				solid,
				signalRow(chip(`var(--${s.key})`, null), `--${s.key}`, `${hex(token(s.key))} · ${formatRatio(solidRatio)} fill only`),
				signalRow(chip("var(--surface)", `var(--${s.key}-deep)`), `--${s.key}-deep`, `${hex(token(`${s.key}-deep`))} · ${formatRatio(deepRatio)} ${grade(deepRatio)}`),
				signalRow(chip(`var(--${s.key}-tint)`, `var(--${s.key}-deep)`), `--${s.key}-tint`, `${hex(token(`${s.key}-tint`))} · deep ${formatRatio(tintRatio)}`),
				signalRow(chip(`var(--${s.key}-soft)`, "var(--text-1)"), `--${s.key}-soft`, `${hex(token(`${s.key}-soft`))} · ink ${formatRatio(contrastRatio(token("n-12"), token(`${s.key}-soft`)) ?? 0)}`),
				h("p", "sg-signal__role", s.role),
			),
		);
	}
}

function renderRoles(host: HTMLElement) {
	for (const role of ROLES) {
		const value = token(role.name);
		const chip = h("span", "sg-role__chip");
		setVar(chip, "--sg-c", `var(--${role.name})`);
		const maps = paletteName(value);
		host.append(
			h(
				"div",
				"sg-role",
				chip,
				h("span", "sg-role__name", `--${role.name}`, h("span", "sg-role__use", role.use)),
				h("span", "sg-role__maps", maps ? `${maps} · ${hex(value)}` : hex(value)),
			),
		);
	}
}

function contrastCell(r: PairResult): HTMLElement {
	const sample = h("div", "sg-cc__sample");
	setVar(sample, "--sg-bg", `var(--${r.bg})`);
	setVar(sample, "--sg-fg", `var(--${r.fg})`);
	if (r.kind === "ui") sample.append(h("span", "sg-cc__ring"), h("span", "sg-cc__ring"));
	else sample.append(r.kind === "large" ? "Ag" : "Aa", h("span", "t-small", r.kind === "large" ? "24px+" : "body"));
	const ratio = r.ratio === null ? "n/a" : formatRatio(r.ratio);
	const verdict = r.pass ? (r.kind === "text" ? grade(r.ratio ?? 0) : `${r.kind} 3:1`) : "fail";
	return h(
		"div",
		r.pass ? "sg-cc" : "sg-cc sg-cc--fail",
		sample,
		h("div", "sg-cc__info", h("span", "sg-cc__ratio", h("span", undefined, `${ratio}:1`), h("span", undefined, verdict)), h("span", "sg-cc__pair", r.fg), h("span", "sg-cc__pair", `on ${r.bg}`)),
	);
}

function renderContrast(host: HTMLElement): PairResult[] {
	const results = evaluatePairs((name) => token(name) || undefined);
	const groups = new Map<string, PairResult[]>();
	const groupOf = (r: PairResult) => {
		if (r.bg === "bg" || r.bg === "surface" || r.bg === "bg-band") return "Paper, white and band";
		if (r.bg.startsWith("surface-") || r.bg === "selection") return "Fills, ink and selection";
		if (r.bg.startsWith("danger")) return "Error";
		if (r.fg.startsWith("dino-") || r.bg.startsWith("dino-")) return "Dinosaur themes";
		return `${r.bg.replace(/-(tint|soft)$/, "")} fills`;
	};
	for (const r of results) {
		const key = r.fg.endsWith("-deep") && !r.fg.startsWith("dino-") && (r.bg === "bg" || r.bg === "surface" || r.bg === "bg-band") ? "Signal deep variants as text" : groupOf(r);
		groups.set(key, [...(groups.get(key) ?? []), r]);
	}
	for (const [title, list] of groups) {
		const grid = h("div", "sg-contrast__grid");
		for (const r of list) grid.append(contrastCell(r));
		host.append(h("div", "sg-contrast__group", h("h4", undefined, `${title} · ${list.length}`), grid));
	}
	return results;
}

// ---------------------------------------------------------------- typography

function renderTypeScale(host: HTMLElement) {
	const probes: { el: HTMLElement; live: HTMLElement }[] = [];
	for (const step of TYPE_SCALE) {
		const live = h("span", undefined, "");
		live.dataset.live = "";
		const en = h("p", step.cls, step.en);
		const ko = h("p", step.cls, step.ko);
		ko.lang = "ko";
		const base = ({ "body-lg": "body", caption: "small" } as Record<string, string>)[step.token] ?? step.token;
		const lead0 = (v: string) => v.replace(/^(-?)\./, "$10.");
		const lh = lead0(token(`lh-${base}`));
		const tr = lead0(token(`tr-${base}`));
		host.append(
			h(
				"div",
				"sg-type-row",
				h(
					"div",
					"sg-type-meta",
					h("b", undefined, `--fs-${step.token}`),
					h("span", undefined, `${step.size} px`),
					live,
					h("span", undefined, [lh && `lh ${lh}`, tr && tr].filter(Boolean).join(" · ") || "mono, uppercase"),
					h("span", undefined, step.use),
				),
				h("div", "sg-type-specimens", en, ko),
			),
		);
		probes.push({ el: en, live });
	}
	const update = () => {
		for (const p of probes) {
			const cs = getComputedStyle(p.el);
			p.live.textContent = `now ${Math.round(Number.parseFloat(cs.fontSize))}px · ${cs.fontWeight}`;
		}
	};
	update();
	document.fonts?.ready.then(update).catch(() => {});
	let frame = 0;
	window.addEventListener(
		"resize",
		() => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(update);
		},
		{ passive: true },
	);
}

// ---------------------------------------------------------------- space, shape, layout

function renderSpace(host: HTMLElement) {
	for (const s of SPACE) {
		const bar = h("span", "sg-space-row__bar");
		bar.style.width = `var(--${s.token})`;
		host.append(h("div", "sg-space-row", h("span", undefined, `--${s.token}`), h("span", "sg-space-row__px", `${s.px}`), h("span", undefined, bar), h("span", "sg-space-row__use", s.use)));
	}
}

function renderRadii(host: HTMLElement) {
	for (const r of RADII) {
		const shape = h("span", "sg-radius__shape");
		setVar(shape, "--sg-r", `var(--${r.token})`);
		const value = token(r.token);
		host.append(h("div", "sg-radius", shape, h("span", undefined, h("b", undefined, `--${r.token}`), `${value} · ${r.use}`)));
	}
}

function fillTable(table: HTMLTableElement, rows: string[][]) {
	const body = table.tBodies[0] ?? table.createTBody();
	for (const row of rows) {
		const tr = h("tr");
		row.forEach((cell, i) => tr.append(h("td", undefined, i === 0 ? h("code", undefined, cell) : cell)));
		body.append(tr);
	}
}

// ---------------------------------------------------------------- motion

const ms = (value: string) => {
	const v = value.trim();
	return v.endsWith("ms") ? Number.parseFloat(v) : v.endsWith("s") ? Number.parseFloat(v) * 1000 : Number.parseFloat(v) || 0;
};

/** Moves a track's dot to the other end with WAAPI (transform only). */
function runTrack(track: HTMLElement, duration: number, easing: string) {
	const dot = track.querySelector<HTMLElement>(".sg-track__dot");
	if (!dot) return;
	const distance = track.clientWidth - dot.offsetWidth - dot.offsetLeft * 2;
	const atEnd = track.dataset.at === "end";
	const from = atEnd ? distance : 0;
	const to = atEnd ? 0 : distance;
	track.dataset.at = atEnd ? "start" : "end";
	dot.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], { duration, easing, fill: "forwards" });
}

function renderDurations(host: HTMLElement) {
	const tracks: (() => void)[] = [];
	for (const d of DURATIONS) {
		const track = h("div", "sg-track", h("span", "sg-track__dot"));
		const raw = token(d.raw);
		const play = () => runTrack(track, ms(raw), token("ease-out") || "ease-out");
		const button = h("button", "btn btn--ghost btn--sm btn--icon");
		button.type = "button";
		button.setAttribute("aria-label", `Play ${d.token}`);
		button.append(playIcon());
		button.addEventListener("click", play);
		tracks.push(play);
		host.append(h("div", "sg-motion-row", h("div", "sg-motion-meta", h("b", undefined, `--${d.token}`), h("span", undefined, `${Math.round(ms(raw))}ms · ${d.use}`)), track, button));
	}
	return () => tracks.forEach((t) => t());
}

function playIcon(): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("class", "icon");
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("aria-hidden", "true");
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", "M5 3.5v9l7-4.5z");
	svg.append(path);
	return svg;
}

function cubic([x1, y1, x2, y2]: [number, number, number, number], n = 48): [number, number][] {
	const pts: [number, number][] = [];
	for (let i = 0; i <= n; i++) {
		const t = i / n;
		const u = 1 - t;
		pts.push([3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3, 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3]);
	}
	return pts;
}

function linearPoints(value: string): [number, number][] {
	const inner = /linear\((.*)\)/s.exec(value)?.[1];
	if (!inner) return [];
	const stops = inner.split(",").map((s) => Number.parseFloat(s.trim()));
	return stops.map((y, i) => [i / (stops.length - 1), y]);
}

function curveSvg(points: [number, number][]): SVGSVGElement {
	const NS = "http://www.w3.org/2000/svg";
	const W = 200;
	const H = 110;
	const ys = points.map((p) => p[1]);
	const lo = Math.min(0, ...ys);
	const hi = Math.max(1, ...ys);
	const pad = 8;
	const x = (v: number) => pad + v * (W - pad * 2);
	const y = (v: number) => H - pad - ((v - lo) / (hi - lo)) * (H - pad * 2);
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
	svg.setAttribute("class", "sg-curve__plot");
	svg.setAttribute("aria-hidden", "true");
	const line = (cls: string, d: string) => {
		const p = document.createElementNS(NS, "path");
		p.setAttribute("class", cls);
		p.setAttribute("d", d);
		svg.append(p);
	};
	line("grid", `M${x(0)} ${y(0)}H${x(1)}M${x(0)} ${y(1)}H${x(1)}M${x(0)} ${y(lo)}V${y(hi)}`);
	if (hi > 1.001) line("base", `M${x(0)} ${y(1)}H${x(1)}`);
	line("curve", points.map((p, i) => `${i ? "L" : "M"}${x(p[0]).toFixed(2)} ${y(p[1]).toFixed(2)}`).join(""));
	const end = document.createElementNS(NS, "circle");
	end.setAttribute("class", "end");
	end.setAttribute("cx", String(x(1)));
	end.setAttribute("cy", String(y(1)));
	end.setAttribute("r", "4");
	svg.append(end);
	return svg;
}

function renderEasings(host: HTMLElement) {
	const plays: (() => void)[] = [];
	for (const e of EASINGS) {
		const value = token(e.token);
		const points = e.bezier ? cubic(e.bezier) : linearPoints(value);
		const track = h("div", "sg-track", h("span", "sg-track__dot"));
		const duration = ms(token(e.duration));
		const play = () => runTrack(track, duration, value || "ease");
		const button = h("button", "btn btn--secondary btn--sm btn--icon");
		button.type = "button";
		button.setAttribute("aria-label", `Play ${e.token}`);
		button.append(playIcon());
		button.addEventListener("click", play);
		plays.push(play);
		const label = e.bezier ? `cubic-bezier(${e.bezier.join(", ")})` : `linear(), ${points.length} stops`;
		host.append(
			h(
				"div",
				"sg-curve",
				h("div", "sg-curve__head", h("div", "sg-motion-meta", h("b", undefined, `--${e.token}`), h("span", undefined, label), h("span", undefined, `${Math.round(duration)}ms · ${e.use}`)), button),
				curveSvg(points),
				track,
			),
		);
	}
	return () => plays.forEach((p) => p());
}

function playStagger(host: HTMLElement) {
	const dots = $all("i", host);
	const stagger = ms(token("stagger")) || 50;
	dots.forEach((dot, i) => {
		dot.animate(
			[
				{ opacity: 0, transform: "translateY(18px) scale(0.4)" },
				{ opacity: 1, transform: "none" },
			],
			{ duration: ms(token("spring-bouncy-dur")), easing: token("spring-bouncy") || "ease-out", delay: i * stagger, fill: "backwards" },
		);
	});
}

function playAssemble(host: HTMLElement) {
	const circles = $all<SVGCircleElement>("circle[data-x]", host);
	const dur = ms(token("duration-900"));
	for (const c of circles) {
		const x = Number(c.dataset.x);
		const y = Number(c.dataset.y);
		const seed = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
		const r = seed - Math.floor(seed);
		c.animate(
			[
				{ opacity: 0, transform: `translate(${(r - 0.5) * 6}px, ${-3 - r * 5}px)` },
				{ opacity: 1, transform: "translate(0px, 0px)" },
			],
			{ duration: dur * 0.6, easing: token("spring-gentle") || "ease-out", delay: x * 14 + r * 60, fill: "backwards" },
		);
	}
}

// ---------------------------------------------------------------- dots

function mountDots() {
	for (const host of $all("[data-dino]")) {
		const state = (host.dataset.dinoState ?? "idle") as DinoState;
		const crop = host.dataset.dinoCrop === "head" ? "head" : undefined;
		// A head crop repeats the full specimen next to it, so only the full T-rex carries the label.
		const label = crop || host.closest("figure")?.getAttribute("aria-label") ? undefined : `dinobot T-rex, ${state}`;
		host.append(renderDino({ state, unlit: host.hasAttribute("data-dino-unlit"), label, crop }));
	}
	for (const host of $all("[data-dino-mark]")) host.append(renderDino({ fill: 0.86 }));
	for (const host of $all("[data-glyph]")) host.replaceWith(renderGlyph(host.dataset.glyph ?? "chat"));
	for (const host of $all("[data-glyph-tile]")) host.append(renderGlyph(host.dataset.glyphTile ?? "chat"));
	const list = document.querySelector<HTMLElement>('[data-sg="glyphs"]');
	if (list) for (const name of Object.keys(GLYPHS)) list.append(h("div", "sg-glyph", renderGlyph(name), name));
}

// ---------------------------------------------------------------- live components

function mountWaitlistDemo() {
	const form = document.querySelector<HTMLFormElement>("[data-sg-waitlist]");
	if (!form) return;
	const email = form.querySelector<HTMLInputElement>('input[type="email"]');
	const consent = form.querySelector<HTMLInputElement>('input[type="checkbox"]');
	const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]');
	const msg = form.querySelector<HTMLElement>(".msg");
	const position = form.querySelector<HTMLElement>("[data-sg-position]");
	if (!email || !consent || !submit || !msg) return;
	let outcome: "success" | "error" = "success";
	let timer = 0;
	const say = (text: string, kind: "error" | "success" | "info" | "") => {
		msg.className = kind ? `msg msg--${kind}` : "msg";
		msg.textContent = text;
		if (text) {
			msg.classList.remove("is-entering");
			void msg.offsetWidth;
			msg.classList.add("is-entering");
		}
	};
	const setState = (state: "idle" | "submitting" | "success" | "error") => {
		form.dataset.state = state;
		const busy = state === "submitting";
		submit.setAttribute("aria-busy", String(busy));
		submit.disabled = busy;
		email.readOnly = busy;
	};
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		if (form.dataset.state === "submitting") return;
		const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.value.trim());
		email.setAttribute("aria-invalid", String(!valid));
		consent.setAttribute("aria-invalid", String(!consent.checked));
		if (!valid) {
			setState("error");
			say("Check the email address and try again.", "error");
			email.focus();
			return;
		}
		if (!consent.checked) {
			setState("error");
			say("Please confirm you're 14 or older and agree to the waitlist terms.", "error");
			consent.focus();
			return;
		}
		say("", "");
		setState("submitting");
		window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			if (outcome === "error") {
				setState("error");
				say("We couldn't save that. Your email is still here; it's safe to retry.", "error");
				return;
			}
			const n = 40 + Math.floor(Math.random() * 60);
			if (position) position.textContent = `#${new Intl.NumberFormat("en", { minimumIntegerDigits: 4, useGrouping: false }).format(n)}`;
			setState("success");
		}, 1100);
	});
	for (const button of $all<HTMLButtonElement>("[data-sg-outcome]")) {
		button.addEventListener("click", () => {
			outcome = button.dataset.sgOutcome === "error" ? "error" : "success";
			for (const b of $all<HTMLButtonElement>("[data-sg-outcome]")) {
				const on = b === button;
				b.setAttribute("aria-checked", String(on));
				if (on) b.setAttribute("aria-current", "true");
				else b.removeAttribute("aria-current");
			}
		});
	}
	document.querySelector("[data-sg-reset]")?.addEventListener("click", () => {
		window.clearTimeout(timer);
		form.reset();
		email.removeAttribute("aria-invalid");
		consent.removeAttribute("aria-invalid");
		say("", "");
		setState("idle");
	});
}

function mountToasts() {
	const region = document.querySelector<HTMLElement>("[data-sg-toasts]");
	if (!region) return;
	const show = (kind: "success" | "error") => {
		const toast = h("div", `toast toast--${kind}`, h("span", "toast__text", kind === "success" ? "You're on the list. #0042" : "We couldn't save that. It's safe to retry."));
		toast.setAttribute("role", "status");
		region.append(toast);
		while (region.children.length > 3) region.firstElementChild?.remove();
		window.setTimeout(() => {
			toast.dataset.leaving = "";
			const done = () => toast.remove();
			toast.addEventListener("animationend", done, { once: true });
			window.setTimeout(done, 600);
		}, 3600);
	};
	for (const b of $all<HTMLButtonElement>("[data-sg-toast]")) b.addEventListener("click", () => show(b.dataset.sgToast === "error" ? "error" : "success"));
}

function mountMarquee() {
	for (const marquee of $all("[data-sg-marquee]")) {
		const list = marquee.querySelector<HTMLElement>("[data-marquee-list]");
		const track = marquee.querySelector<HTMLElement>(".marquee__track");
		if (!list || !track) continue;
		const clone = list.cloneNode(true) as HTMLElement;
		clone.setAttribute("aria-hidden", "true");
		clone.removeAttribute("data-marquee-list");
		track.append(clone);
		const toggle = marquee.querySelector<HTMLButtonElement>("[data-sg-marquee-toggle]");
		toggle?.addEventListener("click", () => {
			const paused = marquee.hasAttribute("data-paused");
			marquee.toggleAttribute("data-paused", !paused);
			toggle.setAttribute("aria-pressed", String(!paused));
			toggle.setAttribute("aria-label", paused ? "Pause the list" : "Play the list");
			const path = toggle.querySelector("path");
			path?.setAttribute("d", paused ? "M6 4v8M10 4v8" : "M5 3.5v9l7-4.5z");
		});
		// Pause offscreen: no work while it cannot be seen (BRIEF 8).
		new IntersectionObserver(([entry]) => track.style.setProperty("animation-play-state", entry?.isIntersecting ? "" : "paused")).observe(marquee);
	}
}

function mountToc() {
	const links = $all<HTMLAnchorElement>("[data-toc]");
	const byId = new Map(links.map((a) => [a.hash.slice(1), a]));
	const targets = [...byId.keys()].map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el);
	const visible = new Map<string, number>();
	const sync = () => {
		// The innermost target in the reading band wins: a component specimen over its section.
		let best: string | undefined;
		let bestTop = Number.NEGATIVE_INFINITY;
		for (const [id, top] of visible) {
			if (top > bestTop) {
				bestTop = top;
				best = id;
			}
		}
		if (!best) return;
		const section = document.getElementById(best)?.closest(".sg-section")?.id;
		for (const a of links) {
			const id = a.hash.slice(1);
			const on = id === best || id === section;
			if (on) a.setAttribute("aria-current", "true");
			else a.removeAttribute("aria-current");
		}
		const current = byId.get(section ?? best);
		// Only the sticky horizontal tab bar (560-1023px) follows the reading position; on phones the index is static
		// in the page, and scrolling it into view would yank the page back to the top.
		if (current && window.matchMedia("(min-width: 560px) and (max-width: 1023.98px)").matches) current.scrollIntoView({ block: "nearest", inline: "nearest" });
	};
	const io = new IntersectionObserver(
		(entries) => {
			for (const e of entries) {
				if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top);
				else visible.delete(e.target.id);
			}
			sync();
		},
		{ rootMargin: "-20% 0px -60% 0px" },
	);
	for (const t of targets) io.observe(t);
}

function mountNavRule() {
	const nav = document.querySelector<HTMLElement>("[data-sg-nav]");
	if (!nav) return;
	const sentinel = h("div");
	sentinel.setAttribute("aria-hidden", "true");
	nav.before(sentinel);
	new IntersectionObserver(([entry]) => nav.toggleAttribute("data-stuck", !entry?.isIntersecting)).observe(sentinel);
}

/** Custom properties declared by the first `:root` rule (the token defaults in tokens.css). */
function countTokens(): number {
	const find = (rules: CSSRuleList): CSSStyleRule | undefined => {
		for (const rule of rules) {
			if (rule instanceof CSSStyleRule && rule.selectorText === ":root") return rule;
			if (rule instanceof CSSLayerBlockRule) {
				const inner = find(rule.cssRules);
				if (inner) return inner;
			}
		}
		return undefined;
	};
	for (const sheet of document.styleSheets) {
		let rule: CSSStyleRule | undefined;
		try {
			rule = find(sheet.cssRules);
		} catch {}
		if (rule) return [...rule.style].filter((p) => p.startsWith("--")).length;
	}
	return 0;
}

// ---------------------------------------------------------------- boot

/** Principle 13: loops stop offscreen. Specimens out of view get data-offscreen, which pauses their CSS loops (loaders). */
function pauseOffscreenLoops() {
	const io = new IntersectionObserver((entries) => {
		for (const entry of entries) entry.target.toggleAttribute("data-offscreen", !entry.isIntersecting);
	});
	for (const el of $all(".sg-specimen")) io.observe(el);
}

function onFirstView(el: Element, fn: () => void) {
	const io = new IntersectionObserver(([entry]) => {
		if (!entry?.isIntersecting) return;
		io.disconnect();
		fn();
	}, { threshold: 0.4 });
	io.observe(el);
}

/** Class lists wrap only between entries, never inside "--modifier". */
function tidyClassLists() {
	for (const el of $all(".sg-classes")) {
		const parts = (el.textContent ?? "").split(" · ");
		el.textContent = "";
		parts.forEach((part, i) => {
			el.append(h("span", "sg-nowrap", part));
			if (i < parts.length - 1) el.append(" · ");
		});
	}
}

function boot() {
	mountDots();
	tidyClassLists();
	const sg = (name: string) => document.querySelector<HTMLElement>(`[data-sg="${name}"]`);
	const neutrals = sg("neutrals");
	if (neutrals) renderNeutrals(neutrals);
	const signals = sg("signals");
	if (signals) renderSignals(signals);
	const roles = sg("roles");
	if (roles) renderRoles(roles);
	const dinos = sg("dinos");
	if (dinos) renderThemes(dinos, token);
	const contrast = sg("contrast");
	const results = contrast ? renderContrast(contrast) : [];
	const typeScale = sg("type-scale");
	if (typeScale) renderTypeScale(typeScale);
	const space = sg("space");
	if (space) renderSpace(space);
	const radii = sg("radii");
	if (radii) renderRadii(radii);
	const z = document.querySelector<HTMLTableElement>('table[data-sg="z"]');
	if (z) fillTable(z, Z_INDEX.map((t) => [`--${t.token}`, token(t.token), t.use]));
	const layout = document.querySelector<HTMLTableElement>('table[data-sg="layout-tokens"]');
	if (layout)
		fillTable(
			layout,
			["container", "container-wide", "container-text", "gutter", "grid-gap", "nav-h", "runner-h", "control-sm", "control-md", "control-lg", "measure"].map((t) => [`--${t}`, token(t)]),
		);

	const durations = sg("durations");
	const playDurations = durations ? renderDurations(durations) : () => {};
	const easings = sg("easings");
	const playEasings = easings ? renderEasings(easings) : () => {};
	document.querySelector('[data-play="durations"]')?.addEventListener("click", playDurations);
	document.querySelector('[data-play="easings"]')?.addEventListener("click", playEasings);
	const stagger = document.querySelector<HTMLElement>("[data-stagger]");
	const assemble = document.querySelector<HTMLElement>("[data-assemble]");
	const replay = () => {
		if (stagger) playStagger(stagger);
		if (assemble) playAssemble(assemble);
	};
	document.querySelector('[data-play="assemble"]')?.addEventListener("click", replay);
	if (assemble && !reduceMotion.matches) onFirstView(assemble, replay);

	pauseOffscreenLoops();
	mountWaitlistDemo();
	mountToasts();
	mountMarquee();
	mountToc();
	mountNavRule();

	const tokensCount = countTokens();
	const tokensEl = document.querySelector('[data-sg-count="tokens"]');
	if (tokensEl && tokensCount) tokensEl.textContent = `${tokensCount} custom properties`;
	const contrastEl = document.querySelector('[data-sg-count="contrast"]');
	if (contrastEl && results.length) contrastEl.textContent = `${results.filter((r) => r.pass).length} of ${results.length} pairs pass AA`;
	document.body.dataset.ready = "1";
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
