/**
 * "Watch it work" ([data-scene="demo"]): a chat window in which one scripted run ties the four strengths together:
 * plan graph -> helper agents -> memory recall -> verification ticks -> answer -> "Learned 1 working agreement".
 *
 * Stage: 750 x 500 when the host is landscape, 360 x 720 when it is portrait; it scales to fit the host.
 * Recommended host aspect ratio: 3 / 2 on desktop and 1 / 2 below 640px.
 *
 * Controls: three sample-request chips, a Tasklet-style numbered step bar (C13) with progress underlines (click a step
 * to jump; arrow keys move between steps), Play/Replay ([data-action="play"], the QA hook) and Pause/Resume
 * ([data-action="pause"]). Narration goes to an aria-live region for user-started runs. Reduced motion: the final
 * state of the selected request; Play animates it once inside `.motion-ok`.
 */
import { type Entry, type Registry, Timeline } from "./engine.ts";
import { glyph, h, loader, mark, place } from "./dom.ts";
import type { LabelKey, Labels } from "./labels.ts";
import { DEMO_CHAPTERS, DEMO_IDS, DEMO_REQUESTS, DEMO_SCRIPT, type DemoRequest, type DemoSlot, demoKey } from "./scripts.ts";
import type { Unit } from "./scene.ts";

export const DEMO_WIDE = { w: 750, h: 500 } as const;
export const DEMO_NARROW = { w: 360, h: 720 } as const;

export function mountDemo(host: HTMLElement, labels: Labels, reducedInit: boolean): Unit {
	host.classList.add("sc-host", "dm-host");
	host.dataset.mounted = "showcase";
	const reg: Registry = new Map();
	const slots: { el: HTMLElement; slot: DemoSlot }[] = [];
	const L = (k: LabelKey) => labels[k];

	const reg1 = (id: (typeof DEMO_IDS)[number], el: HTMLElement, extra: Partial<Entry> = {}) => {
		el.setAttribute("data-s", "off");
		reg.set(id, { el, init: { s: "off" }, ...extra });
		return el;
	};
	const slot = (el: HTMLElement, name: DemoSlot) => {
		slots.push({ el, slot: name });
		return el;
	};

	// ---------------------------------------------------------------- window
	const stage = h("div", "sc-stage dm");
	stage.setAttribute("role", "group");
	stage.setAttribute("aria-label", L("demo.label"));
	const win = h("div", "dm-win");
	const head = h("div", "dm-head");
	const dots = h("span", "dm-dots");
	dots.append(h("i"), h("i"), h("i"));
	dots.setAttribute("aria-hidden", "true");
	const status = h("span", "tag dm-status");
	status.append(h("span", "tag__dot"), h("span", "dm-status__run", L("status.running")), h("span", "dm-status__done", L("status.done")));
	status.setAttribute("aria-hidden", "true");
	reg1("status", status);
	head.append(dots, h("span", "dm-title", L("demo.title")), status);

	const chat = h("div", "dm-chat");
	const msg = (who: "bot" | "user", cls = "") => {
		const m = h("div", `dm-msg dm-msg--${who} ${cls}`.trim());
		const av = who === "bot" ? mark("dm-av dm-av--bot") : h("span", "dm-av", L("demo.you").slice(0, 1));
		av.setAttribute("aria-hidden", "true");
		const body = h("div", "dm-msg__body");
		body.append(h("span", "dm-msg__who", who === "bot" ? L("demo.bot") : L("demo.you")));
		m.append(av, body);
		return { m, body };
	};
	const greet = msg("bot", "dm-greet");
	greet.body.append(h("p", "dm-msg__t", L("demo.greet")));
	const req = msg("user");
	req.body.append(slot(h("p", "dm-msg__t"), "request"));
	reg1("req", req.m);
	const typing = h("div", "dm-typing");
	typing.append(loader("loader"));
	reg1("typing", typing);

	// run card: plan, helpers, memory, checks
	const card = msg("bot", "dm-runmsg");
	const run = h("div", "dm-run");
	card.body.append(run);
	reg1("card", card.m);
	const section = (cls: string, headKey: LabelKey, headId: (typeof DEMO_IDS)[number], g: Parameters<typeof glyph>[0], signal: string) => {
		const sec = h("section", `dm-sec ${cls}`);
		sec.setAttribute("data-signal", signal);
		const hd = h("p", "dm-sec__h");
		hd.append(glyph(g), h("span", "", L(headKey)));
		reg1(headId, hd);
		sec.append(hd);
		run.append(sec);
		return sec;
	};
	const plan = section("dm-plan", "demo.planHead", "planHead", "plan", "mint");
	const planList = h("ol", "dm-plan__list");
	(["p1", "p2", "p3", "p4", "p5"] as const).forEach((id, i) => {
		const li = h("li", "dm-node");
		const st = h("span", "dm-node__st");
		st.append(h("span", "dm-node__n", String(i + 1)), glyph("check", "sc-glyph dm-node__ok"));
		li.append(st, slot(h("span", "dm-node__t"), id));
		reg1(id, li);
		planList.append(li);
	});
	plan.append(planList);

	const helpers = section("dm-helpers", "demo.helpersHead", "helpersHead", "assign", "cyan");
	(["h1", "h2", "h3"] as const).forEach((id) => {
		const row = h("div", "dm-helper");
		const bar = h("span", "dm-helper__bar");
		const fill = h("span", "dm-helper__fill");
		bar.append(fill);
		reg1(`${id}f` as (typeof DEMO_IDS)[number], fill);
		const st = h("span", "sc-st");
		st.append(loader("loader sc-st__run"), glyph("check", "sc-glyph sc-st__ok"));
		row.append(h("span", "dm-helper__dot"), slot(h("span", "dm-helper__t"), id), bar, st);
		reg1(id, row);
		helpers.append(row);
	});

	const memory = section("dm-memory", "demo.memHead", "memHead", "memory", "teal");
	const memChip = h("div", "dm-mem");
	memChip.append(glyph("memory"), h("span", "dm-mem__cap", L("demo.recalled")), slot(h("span", "dm-mem__t"), "mem"));
	reg1("mem", memChip);
	memory.append(memChip);

	const checks = section("dm-checks", "demo.checksHead", "checksHead", "check", "mint");
	(["c1", "c2", "c3"] as const).forEach((id) => {
		const row = h("div", "dm-check");
		const box = h("span", "dm-check__box");
		box.append(glyph("check"));
		row.append(box, slot(h("span", "dm-check__t"), id));
		reg1(id, row);
		checks.append(row);
	});

	const ans = msg("bot");
	ans.body.append(slot(h("p", "dm-msg__t"), "answer"));
	reg1("ans", ans.m);
	const learn = h("div", "dm-learn");
	learn.setAttribute("data-signal", "blue");
	const learnText = h("span", "dm-learn__t");
	learnText.append(h("b", "", L("demo.learned")), slot(h("span", "dm-learn__sub"), "learn"));
	learn.append(glyph("learn"), learnText);
	reg1("learn", learn);

	// The greeting and the request share one cell: the greeting gives way when the request arrives (no layout shift).
	const top = h("div", "dm-top");
	top.append(greet.m, req.m);
	chat.append(top, typing, card.m, ans.m, learn);
	win.append(head, chat);

	// ---------------------------------------------------------------- controls
	const foot = h("div", "dm-foot");
	const chipsRow = h("div", "dm-chips");
	chipsRow.setAttribute("role", "group");
	chipsRow.setAttribute("aria-label", L("demo.pick"));
	chipsRow.append(h("span", "dm-pick", L("demo.pick")));
	const chipButtons = DEMO_REQUESTS.map((r) => {
		const b = h("button", "dm-chip", L(demoKey(r, "chip")));
		b.type = "button";
		b.dataset.request = r;
		b.setAttribute("aria-pressed", "false");
		chipsRow.append(b);
		return b;
	});

	const ctrl = h("div", "dm-ctrl");
	const steps = h("ol", "dm-steps");
	steps.setAttribute("aria-label", L("demo.steps"));
	const stepButtons = DEMO_CHAPTERS.map((c, i) => {
		const li = h("li", "dm-step");
		const b = h("button", "dm-step__b");
		b.type = "button";
		b.dataset.chapter = c.id;
		const line = h("span", "dm-step__line");
		const fill = h("span", "dm-step__fill");
		line.append(fill);
		line.setAttribute("aria-hidden", "true");
		reg1(`bar${i + 1}` as (typeof DEMO_IDS)[number], fill);
		b.append(h("span", "dm-step__n", String(i + 1)), h("span", "dm-step__t", L(c.label)), line);
		li.append(b);
		steps.append(li);
		return b;
	});
	const playBtn = h("button", "dm-btn dm-btn--play");
	playBtn.type = "button";
	playBtn.dataset.action = "play";
	const playIcon = h("span", "dm-ico");
	playIcon.setAttribute("aria-hidden", "true");
	const playText = h("span", "dm-btn__t");
	playBtn.append(playIcon, playText);
	const pauseBtn = h("button", "dm-btn dm-btn--pause");
	pauseBtn.type = "button";
	pauseBtn.dataset.action = "pause";
	const pauseIcon = h("span", "dm-ico");
	pauseIcon.setAttribute("aria-hidden", "true");
	const pauseText = h("span", "sr-only");
	pauseBtn.append(pauseIcon, pauseText);
	ctrl.append(steps, pauseBtn, playBtn);
	foot.append(chipsRow, ctrl);

	const live = h("div", "sr-only");
	live.setAttribute("aria-live", "polite");
	live.setAttribute("role", "status");

	stage.append(win, foot);
	host.append(stage, live);

	// ---------------------------------------------------------------- state
	let reduced = reducedInit;
	let visible = false;
	let autoplayed = false;
	let announce = false;
	let played = false;
	let request: DemoRequest = "r1";
	/** idle: nothing played yet; playing; paused (by the user); ended */
	let mode: "idle" | "playing" | "paused" | "ended" = "idle";

	const tl = new Timeline({
		script: DEMO_SCRIPT,
		registry: reg,
		labels,
		stage: win,
		loop: false,
		say: (t) => {
			if (announce) live.textContent = t;
		},
		onChapter: (t) => markChapter(t),
		onEnd: () => {
			mode = "ended";
			host.classList.remove("motion-ok");
			markChapter(DEMO_SCRIPT.duration);
			render();
		},
	});

	function markChapter(t: number): void {
		let current = -1;
		DEMO_CHAPTERS.forEach((c, i) => {
			if (t >= c.at) current = i;
		});
		if (mode === "ended" || t >= DEMO_SCRIPT.duration) current = DEMO_CHAPTERS.length - 1;
		stepButtons.forEach((b, i) => {
			if (i === current && mode !== "idle") b.setAttribute("aria-current", "step");
			else b.removeAttribute("aria-current");
		});
	}

	function setRequest(r: DemoRequest): void {
		request = r;
		for (const { el, slot: name } of slots) el.textContent = L(demoKey(r, name));
		chipButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.request === r)));
	}

	function render(): void {
		host.dataset.state = mode;
		const running = mode === "playing";
		const fresh = mode === "idle" || !played;
		playText.textContent = fresh ? L("demo.play") : L("demo.replay");
		playIcon.dataset.icon = fresh ? "play" : "replay";
		pauseIcon.dataset.icon = running ? "pause" : "play";
		pauseText.textContent = running ? L("demo.pause") : L("demo.resume");
		pauseBtn.disabled = !(mode === "playing" || mode === "paused");
		pauseBtn.setAttribute("aria-label", running ? L("demo.pause") : L("demo.resume"));
		const shouldRun = running && visible && !document.hidden;
		if (shouldRun) tl.play();
		else tl.pause();
	}

	function start(from = 0, user = true): void {
		announce = user;
		played = true;
		if (reduced) host.classList.add("motion-ok");
		mode = "playing";
		tl.pause();
		tl.seek(from);
		render();
	}

	function showFinal(): void {
		host.classList.remove("motion-ok");
		tl.pause();
		tl.seek(DEMO_SCRIPT.duration);
		mode = "ended";
		markChapter(DEMO_SCRIPT.duration);
		render();
	}

	chipButtons.forEach((b) =>
		b.addEventListener("click", () => {
			setRequest(b.dataset.request as DemoRequest);
			autoplayed = true;
			if (reduced) showFinal();
			else start(0, true);
		}),
	);
	playBtn.addEventListener("click", () => {
		autoplayed = true;
		start(0, true);
	});
	pauseBtn.addEventListener("click", () => {
		if (mode === "playing") mode = "paused";
		else if (mode === "paused") mode = "playing";
		render();
	});
	stepButtons.forEach((b, i) => {
		b.addEventListener("click", () => {
			autoplayed = true;
			const c = DEMO_CHAPTERS[i]!;
			if (reduced && mode !== "playing") {
				// Reduced motion: jump to the end of that chapter, still.
				tl.seek(c.end);
				mode = "paused";
				markChapter(c.at);
				render();
				return;
			}
			start(c.at, true);
		});
		b.addEventListener("keydown", (e) => {
			const k = e.key;
			let j = -1;
			if (k === "ArrowRight" || k === "ArrowDown") j = (i + 1) % stepButtons.length;
			else if (k === "ArrowLeft" || k === "ArrowUp") j = (i - 1 + stepButtons.length) % stepButtons.length;
			else if (k === "Home") j = 0;
			else if (k === "End") j = stepButtons.length - 1;
			if (j >= 0) {
				e.preventDefault();
				stepButtons[j]!.focus();
			}
		});
	});

	// ---------------------------------------------------------------- layout: pick wide or narrow, scale to fit
	let layout: "wide" | "narrow" | "" = "";
	function fit(): void {
		const w = host.clientWidth;
		const hh = host.clientHeight || w * 0.625;
		const next = w / Math.max(1, hh) >= 1 ? "wide" : "narrow";
		if (next !== layout) {
			layout = next;
			stage.dataset.layout = next;
		}
		const size = layout === "wide" ? DEMO_WIDE : DEMO_NARROW;
		place(stage, 0, 0, size.w, size.h);
		const k = Math.min(w / size.w, hh / size.h) || 1;
		stage.style.transform = `translate(${(w - size.w * k) / 2}px, ${(hh - size.h * k) / 2}px) scale(${k})`;
	}
	const ro = new ResizeObserver(fit);
	ro.observe(host);
	fit();

	const onVis = () => render();
	document.addEventListener("visibilitychange", onVis);

	setRequest("r1");
	function applyReduced(r: boolean): void {
		reduced = r;
		if (r) showFinal();
		else if (mode === "idle") {
			tl.seek(-1);
			render();
		} else render();
	}
	applyReduced(reduced);

	return {
		setVisible(v) {
			visible = v;
			if (v && !reduced && !autoplayed && mode === "idle") {
				autoplayed = true;
				start(0, false);
				return;
			}
			render();
		},
		setReduced(r) {
			if (r !== reduced) applyReduced(r);
		},
		freeze(t) {
			autoplayed = true;
			mode = t >= DEMO_SCRIPT.duration ? "ended" : "paused";
			tl.pause();
			tl.seek(t);
			markChapter(t);
			render();
		},
		destroy() {
			tl.destroy();
			ro.disconnect();
			document.removeEventListener("visibilitychange", onVis);
			stage.remove();
			live.remove();
			host.classList.remove("sc-host", "dm-host", "motion-ok");
			delete host.dataset.mounted;
			delete host.dataset.state;
		},
	};
}

/** For QA/lab: the demo's request ids. */
export { DEMO_REQUESTS };
