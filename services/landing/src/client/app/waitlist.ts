/**
 * Waitlist forms (BRIEF 9). Every `form[data-waitlist]` posts JSON to /api/waitlist:
 *   { email, consent: true, locale, source, website, elapsedMs }
 * States on the form (`data-state`, styled by components.css): idle -> submitting -> success | error.
 * Messages (aria-live polite, no layout jump: they replace the trust line in place) cover invalid email, missing
 * consent, rate limiting, offline and server failures. Success shows "#N" (or the "already" copy), sets every
 * waitlist form on the page to success, bursts five-signal dot confetti, and dispatches
 * `window` CustomEvent "dinobot:joined" { position } for the mascot and the runner.
 *
 * The consent text version shown on the page is the worker's CONSENT_VERSION (imported, so the two cannot drift;
 * the worker stores it with each entry). The form also carries it as data-consent-version for QA.
 */
import { CONSENT_VERSION, LIMITS } from "../../worker/waitlist.ts";
import { $all, locale, reducedMotion } from "./env.ts";

export { CONSENT_VERSION };

export type Outcome =
	| { kind: "joined"; position?: number }
	| { kind: "already" }
	| { kind: "error"; code: "invalid_email" | "consent_required" | "rate_limited" | "offline" | "failed" };

/** Client check mirroring the worker's pragmatic rule closely enough to catch typos before a round trip. */
export function looksLikeEmail(value: string): boolean {
	const email = value.trim();
	if (!email || email.length > LIMITS.emailChars) return false;
	return /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/.test(email);
}

/** Maps an HTTP response of POST /api/waitlist to an outcome. */
export function outcomeOf(status: number, body: unknown): Outcome {
	const data = (typeof body === "object" && body !== null ? body : {}) as { status?: unknown; position?: unknown; error?: unknown };
	if ((status === 200 || status === 201) && data.status === "already") return { kind: "already" };
	if ((status === 200 || status === 201) && data.status === "joined") {
		return typeof data.position === "number" && Number.isFinite(data.position) ? { kind: "joined", position: data.position } : { kind: "joined" };
	}
	if (status === 429 || data.error === "rate_limited") return { kind: "error", code: "rate_limited" };
	if (data.error === "invalid_email") return { kind: "error", code: "invalid_email" };
	if (data.error === "consent_required") return { kind: "error", code: "consent_required" };
	return { kind: "error", code: "failed" };
}

export const formatPosition = (n: number) => `#${String(Math.max(1, Math.floor(n))).padStart(4, "0")}`;

const MESSAGE_ATTR: Record<Extract<Outcome, { kind: "error" }>["code"], string> = {
	invalid_email: "msgInvalid",
	consent_required: "msgConsent",
	rate_limited: "msgRate",
	offline: "msgOffline",
	failed: "msgFailed",
};

const CONFETTI = ["mint", "teal", "cyan", "blue", "indigo"] as const;

function burst(host: HTMLElement | null): void {
	if (!host || reducedMotion()) return;
	host.textContent = "";
	const count = 26;
	for (let i = 0; i < count; i++) {
		const dot = document.createElement("i");
		dot.className = `confetti__dot confetti__dot--${CONFETTI[i % CONFETTI.length]}`;
		const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
		const dist = 60 + Math.random() * 90;
		dot.style.setProperty("--x", `${Math.cos(angle) * dist}px`);
		dot.style.setProperty("--y", `${Math.sin(angle) * dist * 0.7 - 30}px`);
		dot.style.setProperty("--d", `${Math.round(Math.random() * 120)}ms`);
		dot.style.setProperty("--s", String(0.6 + Math.random() * 0.8));
		host.append(dot);
	}
	window.setTimeout(() => (host.textContent = ""), 1600);
}

export function mountWaitlist(): void {
	const forms = $all<HTMLFormElement>("form[data-waitlist]");
	const renderedAt = performance.now();
	let joined = false;

	const showSuccess = (form: HTMLFormElement, outcome: Extract<Outcome, { kind: "joined" | "already" }>, celebrate: boolean) => {
		const title = form.querySelector<HTMLElement>("[data-done-title-text]");
		const sub = form.querySelector<HTMLElement>("[data-done-sub-text]");
		const pos = form.querySelector<HTMLElement>("[data-position]");
		const value = form.querySelector<HTMLElement>("[data-position-value]");
		const already = outcome.kind === "already";
		if (title) title.textContent = (already ? form.dataset.alreadyTitle : form.dataset.doneTitle) ?? "";
		if (sub) sub.textContent = (already ? form.dataset.alreadySub : form.dataset.doneSub) ?? "";
		const position = outcome.kind === "joined" ? outcome.position : undefined;
		if (pos) pos.hidden = position === undefined;
		if (value) value.textContent = position === undefined ? "" : formatPosition(position);
		form.dataset.state = "success";
		form.dataset.outcome = outcome.kind;
		const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
		button?.removeAttribute("aria-busy");
		if (celebrate) {
			burst(form.querySelector<HTMLElement>("[data-confetti]"));
			form.querySelector<HTMLElement>("[data-done]")?.focus({ preventScroll: true });
		}
	};

	for (const form of forms) {
		const input = form.querySelector<HTMLInputElement>('input[type="email"]');
		const consent = form.querySelector<HTMLInputElement>('input[name="consent"]');
		const honeypot = form.querySelector<HTMLInputElement>('input[name="website"]');
		const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
		const msg = form.querySelector<HTMLElement>(".msg");
		if (!input || !consent || !button || !msg) continue;

		const setMessage = (text: string, tone: "error" | "" = "error") => {
			msg.textContent = text;
			msg.classList.toggle("msg--error", tone === "error" && text !== "");
			if (text) {
				msg.classList.remove("is-entering");
				void msg.offsetWidth;
				msg.classList.add("is-entering");
			}
		};
		const clearInvalid = () => {
			input.removeAttribute("aria-invalid");
			consent.removeAttribute("aria-invalid");
		};
		const fail = (code: Extract<Outcome, { kind: "error" }>["code"]) => {
			form.dataset.state = "error";
			button.removeAttribute("aria-busy");
			input.readOnly = false;
			setMessage(form.dataset[MESSAGE_ATTR[code]] ?? "");
			if (code === "invalid_email") {
				input.setAttribute("aria-invalid", "true");
				input.focus();
			} else if (code === "consent_required") {
				consent.setAttribute("aria-invalid", "true");
				consent.focus();
			}
		};

		input.addEventListener("input", () => {
			if (form.dataset.state !== "error") return;
			form.dataset.state = "idle";
			clearInvalid();
			setMessage("", "");
		});
		consent.addEventListener("change", () => {
			if (consent.checked) consent.removeAttribute("aria-invalid");
			if (form.dataset.state === "error" && consent.checked && !input.hasAttribute("aria-invalid")) {
				form.dataset.state = "idle";
				setMessage("", "");
			}
		});

		form.addEventListener("submit", async (event) => {
			event.preventDefault();
			if (form.dataset.state === "submitting" || form.dataset.state === "success") return;
			clearInvalid();
			const email = input.value.trim();
			if (!looksLikeEmail(email)) return fail("invalid_email");
			if (!consent.checked) return fail("consent_required");
			if (!navigator.onLine) return fail("offline");

			form.dataset.state = "submitting";
			button.setAttribute("aria-busy", "true");
			input.readOnly = true;
			setMessage("", "");
			const controller = new AbortController();
			const timeout = window.setTimeout(() => controller.abort(), 15000);
			let outcome: Outcome;
			try {
				const response = await fetch("/api/waitlist", {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({
						email,
						consent: true,
						locale: locale(),
						source: form.dataset.source,
						website: honeypot?.value ?? "",
						elapsedMs: Math.round(performance.now() - renderedAt),
					}),
					signal: controller.signal,
					credentials: "same-origin",
				});
				const body: unknown = await response.json().catch(() => null);
				outcome = outcomeOf(response.status, body);
			} catch {
				outcome = { kind: "error", code: navigator.onLine ? "failed" : "offline" };
			} finally {
				window.clearTimeout(timeout);
			}
			input.readOnly = false;
			if (outcome.kind === "error") return fail(outcome.code);

			// One signup per page: every form shows the result; only the submitting one celebrates.
			for (const other of forms) showSuccess(other, outcome, other === form);
			if (!joined && outcome.kind === "joined") {
				joined = true;
				window.dispatchEvent(new CustomEvent("dinobot:joined", { detail: { position: outcome.position ?? null } }));
			}
		});
	}
}
