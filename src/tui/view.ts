/**
 * Screen-wide view toggles: Ctrl+O (tool details), Ctrl+E (thinking), Ctrl+X (shortcuts cheatsheet).
 *
 * The state is a point in {0,1}³ and each key is the involution `toggle(s, k)` that flips coordinate `k` only.
 * A transcript entry of a toggle class is open iff `mode ⊕ flipped`: the class mode from here XOR the entry's own
 * Right/Left override. Changing a class mode clears that class's overrides, so every entry of it then matches the mode.
 */
export type ViewToggle = "tools" | "thinking" | "shortcuts";
export type ViewState = Readonly<Record<ViewToggle, boolean>>;

export const initialView: ViewState = { tools: false, thinking: false, shortcuts: false };

export function setView(state: ViewState, key: ViewToggle, value: boolean): ViewState {
	return state[key] === value ? state : { ...state, [key]: value };
}

export function toggleView(state: ViewState, key: ViewToggle): ViewState {
	return setView(state, key, !state[key]);
}

/** An entry is open when its class mode and its own override disagree. */
export const entryOpen = (mode: boolean, flipped: boolean): boolean => mode !== flipped;
