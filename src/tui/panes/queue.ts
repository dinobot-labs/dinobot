import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { QueuedInput } from "../../core/ui-contract.ts";
import { researchText } from "../slash.ts";
import { color, glyph, spacing } from "../theme.ts";

/**
 * Queued input on the prompt box (ADR 0036): a `Queued N` title in the TODO caption's token, then the newest items one
 * row each, the newest nearest the prompt because ↓ takes it back. Undelivered input keeps the gray arrow; the mint
 * `accentUser` arrow belongs to prompts the model has received.
 */
const MAX_ITEM_ROWS = 3;
const ITEM_ROW_FRACTION = 0.1;
/** Columns between the title and its hidden count, and between an item's text and its mode word. */
const GAP = 2;
/** Below this many text columns the mode word drops so the text stays readable. */
const MIN_TEXT = 12;
const MODE_WORD: Readonly<Record<QueuedInput["mode"], string>> = { steer: "steer", followUp: "follow-up" };

/** Item rows for a terminal `viewHeight` rows tall: a tenth of it, at least one, at most three. */
export const queueItemRows = (viewHeight: number): number => Math.max(1, Math.min(MAX_ITEM_ROWS, Math.floor(viewHeight * ITEM_ROW_FRACTION)));

/** Untrusted text as one plain line cut to `width`; styling comes after the cut. */
const fit = (text: string, width: number): string => truncateToWidth(text, Math.max(0, width), glyph.ellipsis);

/** The queue rows (no background; the screen paints them). No items, no rows. */
export function renderQueue(items: readonly QueuedInput[], width: number, viewHeight: number): string[] {
	if (items.length === 0) return [];
	const margin = " ".repeat(spacing.margin);
	const inner = Math.max(0, width - spacing.margin * 2);
	const shown = items.slice(-Math.min(items.length, queueItemRows(viewHeight)));
	const hidden = items.length - shown.length;
	const title = fit(`Queued ${items.length}`, inner);
	const earlier = `+${hidden} earlier`;
	const head = hidden > 0 && visibleWidth(title) + GAP + earlier.length <= inner ? `${color.grayBright(title)}${" ".repeat(GAP)}${color.gray(earlier)}` : color.grayBright(title);
	const lead = `${" ".repeat(spacing.status)}${glyph.promptArrow}`;
	const room = Math.max(0, inner - visibleWidth(lead));
	const rows = shown.map((item) => {
		const word = MODE_WORD[item.mode];
		const textRoom = room - GAP - word.length;
		const text = researchText(item.text);
		const arrow = `${" ".repeat(spacing.status)}${color.grayBright(glyph.promptArrow)}`;
		if (textRoom < MIN_TEXT) return `${margin}${arrow}${color.textSecondary(fit(text, room))}`;
		const body = fit(text, textRoom);
		const padding = " ".repeat(Math.max(0, textRoom - visibleWidth(body)) + GAP);
		return `${margin}${arrow}${color.textSecondary(body)}${padding}${color.gray(word)}`;
	});
	return [`${margin}${head}`, ...rows];
}
