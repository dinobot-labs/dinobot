import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";

/** Keys whose action is an involution on screen state (view toggles and the todo pane). */
export const TOGGLE_KEYS = ["ctrl+x", "ctrl+t", "ctrl+o", "ctrl+e"] as const;

/**
 * What the app-level key handler does with one input event.
 * - `pass`: not ours; hand it on unchanged (the TUI drops releases for components that did not opt in).
 * - `swallow`: consume without acting.
 * - `handle`: run the normal bindings.
 */
export type KeyGate = "pass" | "swallow" | "handle";

/**
 * With the Kitty keyboard protocol's event-type flag, one physical stroke arrives as press · repeat^r · release, and
 * `matchesKey` matches all three. A toggle t is an involution (t∘t = id), so acting on every event applies t^(r+2):
 * a tap (r = 0) flips twice and lands back where it started, which reads as "only on while held".
 * Acting on presses alone applies t exactly once per stroke, so the state is the parity of the number of strokes —
 * the same as on legacy terminals, where a tap is one control byte. Releases are never acted on by any binding,
 * and repeats are dropped only for toggles so held editing keys (Backspace, arrows) still auto-repeat.
 */
export function gateKey(data: string): KeyGate {
	if (isKeyRelease(data)) return "pass";
	if (isKeyRepeat(data) && TOGGLE_KEYS.some((key) => matchesKey(data, key))) return "swallow";
	return "handle";
}
