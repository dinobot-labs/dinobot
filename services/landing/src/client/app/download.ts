/**
 * Download section and buttons (#download). Without JavaScript every button jumps to #download and all three cards
 * show their commands and files, so nothing here is required to download.
 * - The visitor's OS (macOS, Windows, or "cli" for Linux and the rest; phones and tablets get none) marks its card with the "For this device" badge
 *   and gives `[data-os-cta]` buttons the matching label (data-label-mac / data-label-windows).
 * - `[data-copy]` buttons copy their install command and confirm with the localized "Copied" label for a moment.
 */
import { $all } from "./env.ts";

export type DeviceOs = "mac" | "windows" | "cli" | "mobile";

/**
 * Classifies a platform / user-agent string. Phones and tablets ("mobile") get no recommendation: nothing runs there.
 * Linux and anything unknown get the CLI card.
 */
export function detectOs(platform: string, userAgent: string): DeviceOs {
	const p = platform.toLowerCase();
	const ua = userAgent.toLowerCase();
	if (/iphone|ipad|ipod|android/.test(ua)) return "mobile";
	if (p.startsWith("mac") || p === "macos" || (!p && ua.includes("mac os x"))) return "mac";
	if (p.startsWith("win") || (!p && ua.includes("windows"))) return "windows";
	return "cli";
}

function currentOs(): DeviceOs {
	const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
	const os = detectOs(nav.userAgentData?.platform || navigator.platform || "", navigator.userAgent || "");
	// iPadOS Safari reports a Mac; a touch screen gives it away.
	return os === "mac" && navigator.maxTouchPoints > 1 ? "mobile" : os;
}

async function copyText(value: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(value);
		return true;
	} catch {
		return false;
	}
}

export function mountDownload(): void {
	const os = currentOs();
	document.documentElement.dataset.os = os;

	for (const button of $all<HTMLAnchorElement>("[data-os-cta]")) {
		const label = os === "mac" ? button.dataset.labelMac : os === "windows" ? button.dataset.labelWindows : undefined;
		const target = button.querySelector<HTMLElement>("[data-os-cta-label]");
		if (label && target) target.textContent = label;
	}

	const card = document.querySelector<HTMLElement>(`[data-download-card="${os}"]`);
	if (card) {
		card.dataset.recommended = "";
		card.querySelector<HTMLElement>("[data-recommended-badge]")?.removeAttribute("hidden");
	}

	const grid = document.querySelector<HTMLElement>("[data-download]");
	const copied = grid?.dataset.lCopied ?? "Copied";
	for (const button of $all<HTMLButtonElement>("[data-copy]")) {
		const label = button.querySelector<HTMLElement>("[data-copy-label]");
		const idle = label?.textContent ?? "";
		let timer: ReturnType<typeof setTimeout> | undefined;
		button.addEventListener("click", async () => {
			if (!(await copyText(button.dataset.copy ?? ""))) {
				// No clipboard access (permissions, old browser): select the command so the visitor can copy it by hand.
				const code = button.parentElement?.querySelector("code");
				if (code) window.getSelection()?.selectAllChildren(code);
				return;
			}
			if (!label) return;
			label.textContent = copied;
			button.dataset.copied = "";
			clearTimeout(timer);
			timer = setTimeout(() => {
				label.textContent = idle;
				delete button.dataset.copied;
			}, 1600);
		});
	}
}
