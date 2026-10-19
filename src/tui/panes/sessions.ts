import { matchesKey } from "@earendil-works/pi-tui";
import type { CommandSelectOption } from "../../commands/types.ts";
import type { SessionsSnapshot } from "../../core/sessions.ts";
import type { OverlaySize } from "../modal.ts";
import { PICKER_HINTS, Picker, type PickerHandlers } from "../picker.ts";
import { color } from "../theme.ts";

const singleLine = (text: string): string => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();

function ago(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
	return `${Math.round(seconds / 86_400)}d`;
}

const message = (label: string): CommandSelectOption[] => [{ id: "", label, disabled: true }];

export const SESSIONS_HINTS: readonly string[] = [...PICKER_HINTS.slice(0, 2), "del delete", ...PICKER_HINTS.slice(2)];
const CONFIRM_BADGE = "press del again to delete";

/** `onDelete` receives a session key after the delete key was pressed twice on the same deletable row. */
export type SessionsHandlers = PickerHandlers & { readonly onDelete?: (key: string) => void };

/** Live sessions (newest first, so the most recent one is focused on open) composed with the shared modal selector, not a second list implementation. */
export class SessionsPicker extends Picker {
	private snapshot: SessionsSnapshot | undefined;
	/** The row armed by a first delete press; any other key disarms it. */
	private armed: string | undefined;
	private note: { text: string; level: "info" | "error" } | undefined;

	constructor(private readonly current: string, handlers: SessionsHandlers, size: () => OverlaySize) {
		const self: { picker?: SessionsPicker } = {};
		super("Sessions", message("Connecting…"), {
			...handlers,
			onKey: key => self.picker?.deleteKey(key, handlers.onDelete) ?? false,
		}, size, {
			hoverSelect: true, wheelSelect: true, descriptionBelow: true, focusDisabled: true, focusFirst: true,
			hints: SESSIONS_HINTS,
			header: () => {
				const note = self.picker?.note;
				return note === undefined ? [] : [note.level === "error" ? color.accentError(note.text) : color.textSecondary(note.text)];
			},
		});
		self.picker = this;
	}

	update(snapshot: SessionsSnapshot): void {
		this.snapshot = snapshot;
		if (this.armed !== undefined && !snapshot.sessions.some(session => session.thread === this.armed)) this.armed = undefined;
		this.updateOptions(snapshot.sessions.length === 0 ? message("No sessions yet") : snapshot.sessions.map(session => ({
			id: session.thread,
			label: singleLine(session.thread),
			description: singleLine(session.lastText ?? "") || "No messages yet",
			badge: session.thread === this.armed
				? CONFIRM_BADGE
				: `${session.state.replaceAll("_", " ")} · ${session.lastActivityAt === undefined ? "no activity" : ago(snapshot.at - session.lastActivityAt)}${session.thread.startsWith("tui:") ? "" : " · external"}`,
			current: session.thread === this.current,
			disabled: !session.thread.startsWith("tui:") || session.thread.length <= 4,
		})));
	}

	fail(messageText: string): void {
		this.updateOptions(message(singleLine(messageText)));
	}

	/** A line above the filter, e.g. why a deletion was refused; undefined clears it. */
	setNote(text: string | undefined, level: "info" | "error" = "info"): void {
		this.note = text === undefined ? undefined : { text: singleLine(text), level };
		this.invalidate();
	}

	/** First delete press arms the selected deletable row, the second deletes it; other keys disarm and pass through. */
	private deleteKey(key: string, onDelete: ((key: string) => void) | undefined): boolean {
		if (!matchesKey(key, "delete") || onDelete === undefined) {
			if (this.armed !== undefined) this.arm(undefined);
			return false;
		}
		const selected = this.selected;
		if (selected === undefined || selected.id === "") return true;
		if (selected.disabled) {
			this.arm(undefined);
			this.setNote("Only tui sessions can be deleted here", "error");
			return true;
		}
		if (selected.id === this.current) {
			this.arm(undefined);
			this.setNote("This session is open here; switch to another one before deleting it", "error");
			return true;
		}
		if (this.armed === selected.id) {
			this.arm(undefined);
			this.setNote(`Deleting ${selected.id}…`);
			onDelete(selected.id);
			return true;
		}
		this.setNote(undefined);
		this.arm(selected.id);
		return true;
	}

	private arm(key: string | undefined): void {
		this.armed = key;
		if (this.snapshot !== undefined) this.update(this.snapshot);
	}
}
