/**
 * Hero motion: the H1 pill word swap and the chat-card story the mascot peeks over (BRIEF 5.2, 12a).
 *
 * Pill: every word shares one grid cell (sections.css), so swapping is a transform/opacity crossfade with no layout
 * change. It plays through the words once and settles back on the first one ("nothing loops in your face").
 *
 * Chat: a timeline of beats. Elements with `data-at="n"` appear at beat n (and leave at `data-until`); plan steps
 * change status at fixed beats. The story starts when the card is on screen, pauses with the tab, and under reduced
 * motion jumps straight to the final state. Status text comes from the card's data-l-* attributes (locale copy).
 */
import type { MascotHandle } from "../mascot/index.ts";
import { $all, onceVisible, reducedMotion } from "./env.ts";

export function mountPillSwap(root: ParentNode = document): void {
	for (const swap of $all("[data-swap]", root)) {
		const words = $all(".swap__word", swap);
		if (words.length < 2 || reducedMotion()) continue;
		let index = 0;
		let shown = 0;
		const order = [...words.keys(), 0].slice(1); // 1, 2, ..., 0
		const step = () => {
			if (document.visibilityState !== "visible") return void setTimeout(step, 1000);
			const next = order[shown];
			if (next === undefined) return;
			words[index]?.removeAttribute("data-on");
			words[index]?.setAttribute("data-off", "");
			const incoming = words[next];
			if (incoming?.hasAttribute("data-off")) {
				// A word that left upward re-enters from below: park it there without a transition first.
				incoming.style.transition = "none";
				incoming.removeAttribute("data-off");
				void incoming.offsetWidth;
				incoming.style.transition = "";
			}
			incoming?.setAttribute("data-on", "");
			index = next;
			shown++;
			if (shown < order.length) setTimeout(step, 2600);
		};
		onceVisible(swap, () => setTimeout(step, 2400));
	}
}

type Status = "queued" | "running" | "waiting" | "done";

/** Beat -> plan step statuses that change at that beat. */
const STATUS_AT: Record<number, [number, Status][]> = {
	2: [
		[0, "running"],
		[1, "running"],
	],
	3: [
		[0, "done"],
		[1, "done"],
		[2, "running"],
	],
	4: [
		[2, "done"],
		[3, "waiting"],
	],
	5: [
		[3, "done"],
		[4, "running"],
	],
	6: [[4, "done"]],
};
/** Milliseconds from the start of the story to each beat. */
const BEAT_MS = [250, 1050, 2000, 3500, 4600, 6300, 7100];
const LAST_BEAT = BEAT_MS.length - 1;

export function mountChat(card: HTMLElement, mascot?: MascotHandle): void {
	const items = $all("[data-at]", card);
	const steps = $all("[data-step]", card);
	const approve = card.querySelector<HTMLElement>(".chat__approve");
	const label = (s: Status) => card.dataset[`l${s[0]!.toUpperCase()}${s.slice(1)}`] ?? s;

	const setStatus = (i: number, status: Status) => {
		const tag = steps[i]?.querySelector<HTMLElement>(".plan__tag");
		const text = steps[i]?.querySelector<HTMLElement>(".plan__status");
		if (!tag || !text) return;
		tag.dataset.status = status === "waiting" ? "queued" : status;
		if (status === "waiting") tag.dataset.waiting = "";
		else delete tag.dataset.waiting;
		text.textContent = label(status);
	};

	const applyBeat = (beat: number) => {
		for (const el of items) {
			const at = Number(el.dataset.at);
			const until = el.dataset.until === undefined ? Infinity : Number(el.dataset.until);
			const on = beat >= at && beat < until;
			if (on && !el.classList.contains("is-on") && beat >= 0 && !reducedMotion()) {
				el.animate([{ opacity: 0.16, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 420, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
			}
			el.classList.toggle("is-on", on);
			el.classList.toggle("is-past", beat >= until);
		}
		for (let b = 0; b <= beat; b++) for (const [i, s] of STATUS_AT[b] ?? []) setStatus(i, s);
		approve?.classList.toggle("is-pressed", beat === 5);
		card.dataset.beat = String(beat);
	};

	card.dataset.play = "";
	if (reducedMotion()) {
		applyBeat(LAST_BEAT);
		return;
	}
	applyBeat(-1);

	let beat = -1;
	let started = false;
	let timer = 0;
	let startedAt = 0;
	let elapsed = 0;
	const schedule = () => {
		const next = beat + 1;
		if (next > LAST_BEAT) return;
		const delay = Math.max(0, (BEAT_MS[next] ?? 0) - elapsed);
		startedAt = performance.now() - elapsed;
		timer = window.setTimeout(() => {
			beat = next;
			elapsed = performance.now() - startedAt;
			applyBeat(beat);
			if (beat === LAST_BEAT && mascot) {
				mascot.setState("happy");
				mascot.jump();
				window.setTimeout(() => mascot.setState("idle"), 1800);
			}
			schedule();
		}, delay);
	};
	// Pause with the tab so nobody comes back to a finished story they never saw.
	document.addEventListener("visibilitychange", () => {
		if (!started || beat >= LAST_BEAT) return;
		if (document.visibilityState === "hidden") {
			clearTimeout(timer);
			elapsed = performance.now() - startedAt;
		} else schedule();
	});
	onceVisible(
		card,
		() =>
			window.setTimeout(() => {
				started = true;
				schedule();
			}, 500),
		"0px",
	);
}
