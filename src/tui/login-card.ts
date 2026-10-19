import type { AuthEvent } from "@earendil-works/pi-ai";
import { type Component, matchesKey, truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CommandPromptSpec } from "../commands/types.ts";
import { closeButtonHit, MODAL_CHROME_ROWS, MODAL_MARGIN, modalBottom, modalContent, modalContentWidth, modalFrameHeight, modalFrameWidth, modalRow, modalTop, type OverlaySize, renderHints, splitKeys, withMargin } from "./modal.ts";
import { brailleSpinner, color, glyph, inverse, link, modalSizing, separator, spinnerFrame, square } from "./theme.ts";

export type LoginPromptSpec = Exclude<CommandPromptSpec, { readonly type: "select" | "checklist" }>;
export type LoginPromptHandlers = { readonly onAnswer: (value: string) => void; readonly onCancel: () => void };
export type LoginCardHandlers = {
	readonly onCancel: () => void;
	readonly onClose: () => void;
	readonly onChooseModel: () => void;
	readonly open: (url: string) => void;
	readonly copy: (text: string) => void;
};
export type LoginCardOptions = { readonly autoOpen?: boolean };
export type LoginPhase = "running" | "success" | "error";
export type ButtonId = "open" | "copy" | "copy-code" | "model" | "done" | "close";
export type ButtonHit = { readonly id: ButtonId; readonly label: string; readonly x: number; readonly y: number; readonly width: number };

type Step = { readonly text: string; readonly links: readonly { readonly label?: string; readonly url: string }[] };
type AuthLink = { readonly url: string; readonly instructions: string; readonly code?: string };
type Button = { readonly id: ButtonId; readonly label: string; readonly hotkey?: string };
type Control = { readonly kind: "input" } | { readonly kind: "button"; readonly button: Button };
type Layout = { readonly width: number; readonly height: number; readonly buttons: readonly ButtonHit[]; readonly inputRow: number | undefined };

const HINT_SEP = separator.meta;
const MASK = "•";
const BUTTON_GAP = "  ";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const EMPTY_LAYOUT: Layout = { width: 0, height: 0, buttons: [], inputRow: undefined };
const DEFAULT_INSTRUCTIONS = "Open this URL in your browser to continue:";
const DEVICE_INSTRUCTIONS = "Open the link below and enter this code:";

const printable = (text: string): string => [...text].filter((char) => char >= " " && char !== "\x7f").join("");

function typedText(data: string): string | undefined {
	if (data === "" || data.includes("\x1b")) return undefined;
	const text = printable(data);
	return text === data ? text : undefined;
}

/** Opens `url` with the platform's URL handler, detached; a missing handler leaves the link and the copy button as the fallback. */
export function openInBrowser(url: string): void {
	const command = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
	try {
		Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
	} catch {
		return;
	}
}

/** OSC 52: the terminal copies `text` to the system clipboard. */
export const osc52 = (text: string): string => `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;

/** A one-line field with no undo stack or kill ring, so a pasted secret lives nowhere but `value` until `reset()`. */
class LineInput {
	private chars: string[] = [];
	private cursor = 0;
	private pasting: string | undefined;

	get value(): string {
		return this.chars.join("");
	}

	reset(): void {
		this.chars = [];
		this.cursor = 0;
		this.pasting = undefined;
	}

	handleInput(data: string): void {
		if (this.pasting !== undefined || data.startsWith(PASTE_START)) return this.paste(data);
		if (matchesKey(data, "left")) this.cursor = Math.max(0, this.cursor - 1);
		else if (matchesKey(data, "right")) this.cursor = Math.min(this.chars.length, this.cursor + 1);
		else if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) this.cursor = 0;
		else if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) this.cursor = this.chars.length;
		else if (matchesKey(data, "backspace")) {
			if (this.cursor > 0) this.chars.splice(--this.cursor, 1);
		} else if (matchesKey(data, "delete")) this.chars.splice(this.cursor, 1);
		else if (matchesKey(data, "ctrl+u")) {
			this.chars.splice(0, this.cursor);
			this.cursor = 0;
		} else if (matchesKey(data, "ctrl+k")) this.chars.splice(this.cursor);
		else if (matchesKey(data, "ctrl+w")) {
			let from = this.cursor;
			while (from > 0 && this.chars[from - 1] === " ") from--;
			while (from > 0 && this.chars[from - 1] !== " ") from--;
			this.chars.splice(from, this.cursor - from);
			this.cursor = from;
		} else {
			const text = typedText(data);
			if (text !== undefined) this.insert(text);
		}
	}

	render(width: number, masked: boolean, focused: boolean): string {
		const shown = masked ? this.chars.map(() => MASK) : this.chars;
		const cells = Math.max(1, width - 1);
		const start = Math.max(0, this.cursor - cells + 1);
		const before = shown.slice(start, this.cursor).join("");
		const at = shown[this.cursor];
		const after = shown.slice(this.cursor + 1, start + cells).join("");
		const cursor = focused ? inverse(at ?? " ") : (at ?? "");
		return `${color.textPrimary(before)}${cursor}${color.textPrimary(after)}`;
	}

	private insert(text: string): void {
		const chars = [...text];
		this.chars.splice(this.cursor, 0, ...chars);
		this.cursor += chars.length;
	}

	private paste(data: string): void {
		let text = data;
		if (text.startsWith(PASTE_START)) {
			this.pasting = "";
			text = text.slice(PASTE_START.length);
		}
		const end = text.indexOf(PASTE_END);
		if (end < 0) {
			this.pasting = `${this.pasting ?? ""}${text}`;
			return;
		}
		this.insert(printable(`${this.pasting ?? ""}${text.slice(0, end)}`));
		this.pasting = undefined;
		const rest = text.slice(end + PASTE_END.length);
		if (rest !== "") this.handleInput(rest);
	}
}

/**
 * The login card: a centered modal that follows one `/login` run from the chosen provider to its result. Progress and info
 * events form a step list (the newest spins), an auth URL or device code shows with [ Open in browser ] / [ Copy link ]
 * buttons and opens the browser once by itself, text and secret prompts are answered in a field inside the card (secrets
 * masked with `•`), and the run's success or error output ends it with [ Choose a model ] [ Done ] or [ Close ].
 */
export class LoginCard implements Component {
	private provider: string;
	private steps: Step[] = [];
	private auth: AuthLink | undefined;
	private prompt: { readonly spec: LoginPromptSpec; readonly handlers: LoginPromptHandlers } | undefined;
	private result: { readonly ok: boolean; readonly text: string } | undefined;
	private notice: string | undefined;
	private readonly opened = new Set<string>();
	private readonly input = new LineInput();
	private readonly autoOpen: boolean;
	private focus = 0;
	private hoveredButton: number | undefined;
	private closeHovered = false;
	private tick = 0;
	private layout: Layout = EMPTY_LAYOUT;
	private cache: { key: string; lines: string[] } | undefined;

	constructor(
		provider: string,
		private readonly handlers: LoginCardHandlers,
		private readonly size: () => OverlaySize,
		options: LoginCardOptions = {},
	) {
		this.provider = provider;
		this.autoOpen = options.autoOpen ?? process.env.DINOBOT_NO_BROWSER !== "1";
	}

	get phase(): LoginPhase {
		return this.result === undefined ? "running" : this.result.ok ? "success" : "error";
	}

	get animating(): boolean {
		return this.phase === "running";
	}

	get title(): string {
		return `Log in${separator.meta}${this.provider}`;
	}

	get awaiting(): LoginPromptSpec | undefined {
		return this.prompt?.spec;
	}

	get buttons(): readonly ButtonHit[] {
		return this.layout.buttons;
	}

	setProvider(name: string): void {
		this.provider = name;
		this.cache = undefined;
	}

	event(event: AuthEvent): void {
		switch (event.type) {
			case "progress":
				this.steps.push({ text: event.message, links: [] });
				break;
			case "info":
				this.steps.push({ text: event.message, links: event.links ?? [] });
				break;
			case "auth_url":
				this.auth = { url: event.url, instructions: event.instructions ?? DEFAULT_INSTRUCTIONS };
				this.launch(event.url);
				break;
			case "device_code":
				this.auth = { url: event.verificationUri, instructions: DEVICE_INSTRUCTIONS, code: event.userCode };
				this.launch(event.verificationUri);
				break;
		}
		this.notice = undefined;
		this.cache = undefined;
	}

	ask(spec: LoginPromptSpec, handlers: LoginPromptHandlers): void {
		this.input.reset();
		this.prompt = { spec, handlers };
		this.focus = 0;
		this.notice = undefined;
		this.cache = undefined;
	}

	endPrompt(): void {
		this.prompt = undefined;
		this.input.reset();
		this.cache = undefined;
	}

	finish(text: string, level: "success" | "error"): void {
		this.endPrompt();
		this.result = { ok: level === "success", text };
		this.focus = 0;
		this.notice = undefined;
		this.cache = undefined;
	}

	cancel(): void {
		if (this.phase === "running") this.handlers.onCancel();
		else this.handlers.onClose();
	}

	animate(tick: number): void {
		if (this.tick === tick) return;
		this.tick = tick;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	handleInput(data: string): void {
		for (const key of splitKeys(data)) this.handleKey(key);
	}

	private handleKey(data: string): void {
		this.cache = undefined;
		if (matchesKey(data, "escape")) return this.cancel();
		const controls = this.controls();
		if (this.awaiting !== undefined && this.phase === "running" && data.startsWith(PASTE_START)) {
			this.focus = 0;
			return this.input.handleInput(data);
		}
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			if (controls.length > 0) this.focus = (this.focus + (matchesKey(data, "tab") ? 1 : controls.length - 1)) % controls.length;
			return;
		}
		const focused = controls[this.focus];
		if (matchesKey(data, "enter")) {
			if (focused?.kind === "input") this.submit();
			else if (focused?.kind === "button") this.activate(focused.button);
			else if (this.phase !== "running") this.handlers.onClose();
			return;
		}
		if (focused?.kind === "input") return this.input.handleInput(data);
		if (controls.length > 0 && (matchesKey(data, "left") || matchesKey(data, "right"))) {
			this.focus = (this.focus + (matchesKey(data, "right") ? 1 : controls.length - 1)) % controls.length;
			return;
		}
		const button = this.availableButtons().find((candidate) => candidate.hotkey === data.toLowerCase());
		if (button !== undefined) this.activate(button);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const { width, height, inputRow } = this.layout;
		const frameWidth = modalFrameWidth(width);
		const frameX = event.x - MODAL_MARGIN;
		const frameY = event.y - MODAL_MARGIN;
		const inside = frameX >= 0 && frameY >= 0 && frameX < frameWidth && frameY < height - MODAL_MARGIN * 2;
		if (event.type === "wheel") return { handled: true };
		if (event.type === "move" || event.type === "drag") {
			const hit = inside ? this.buttonAt(event.x, event.y) : undefined;
			const close = inside && closeButtonHit(frameWidth, frameX, frameY);
			const changed = hit !== this.hoveredButton || close !== this.closeHovered;
			this.hoveredButton = hit;
			this.closeHovered = close;
			if (changed) this.cache = undefined;
			return { handled: true, render: changed };
		}
		if (event.type === "click" && event.button === "left") {
			this.cache = undefined;
			if (!inside) {
				if (this.phase !== "running") this.handlers.onClose();
				return { handled: true };
			}
			if (closeButtonHit(frameWidth, frameX, frameY)) {
				this.cancel();
				return { handled: true };
			}
			const hit = this.buttonAt(event.x, event.y);
			if (hit !== undefined) {
				const control = this.controls()[hit];
				this.focus = hit;
				if (control?.kind === "button") this.activate(control.button);
			} else if (inputRow !== undefined && event.y === inputRow) this.focus = 0;
			return { handled: true };
		}
		return { handled: true };
	}

	render(width: number): string[] {
		const frame = modalFrameWidth(width);
		const maxHeight = modalFrameHeight(this.size());
		const content = modalContentWidth(frame);
		const controls = this.controls();
		this.focus = Math.max(0, Math.min(this.focus, controls.length - 1));
		const key = `${width}:${maxHeight}:${this.provider}:${this.steps.length}:${JSON.stringify(this.auth)}:${this.prompt?.spec.message}:${this.input.value.length}:${JSON.stringify(this.result)}:${this.notice}:${this.focus}:${this.hoveredButton}:${this.closeHovered}:${this.tick}`;
		if (this.cache?.key === key) return this.cache.lines;
		const buttons: ButtonHit[] = [];
		let inputRow: number | undefined;
		const rest: string[] = [];
		const top = MODAL_MARGIN + 1 + modalSizing.vPad;
		const rowOf = (index: number): number => top + index;
		const emitButtons = (lines: string[], offset: number): void => {
			const available = this.availableButtons();
			if (available.length === 0) return;
			let text = "";
			available.forEach((button, index) => {
				const control = (this.prompt === undefined ? 0 : 1) + index;
				const active = control === this.focus || control === this.hoveredButton;
				const label = `[ ${button.label} ]`;
				if (index > 0) text += BUTTON_GAP;
				buttons.push({ id: button.id, label: button.label, x: MODAL_MARGIN + 1 + modalSizing.hPad + visibleWidth(text), y: rowOf(offset + lines.length), width: visibleWidth(label) });
				text += active ? color.buttonActiveBg(color.buttonActive(label)) : control === this.hoveredButton ? color.bgHover(color.button(label)) : color.buttonBg(color.button(label));
			});
			lines.push(truncateToWidth(text, content, ""));
		};
		const running = this.phase === "running";
		const auth = running ? this.auth : undefined;
		const stepLines = this.renderSteps(content, running);
		const sections: string[] = [];
		const gap = (): string[] => (stepLines.length + sections.length > 0 ? [""] : []);
		if (auth !== undefined) {
			sections.push(...gap(), ...wrapTextWithAnsi(color.textPrimary(auth.instructions), content));
			if (auth.code !== undefined) sections.push(...this.renderCode(auth.code, content));
			sections.push(link(auth.url, truncateToWidth(auth.url, content, glyph.ellipsis)), "");
			emitButtons(sections, stepLines.length);
		}
		if (running && this.prompt !== undefined) {
			const spec = this.prompt.spec;
			sections.push(...gap(), ...wrapTextWithAnsi(color.textPrimary(spec.message), content));
			inputRow = rowOf(stepLines.length + sections.length);
			const focused = controls[this.focus]?.kind === "input";
			const empty = this.input.value === "";
			const placeholder = empty ? (spec.placeholder ?? (spec.type === "secret" ? "paste the key, Enter to submit" : "")) : "";
			const fieldWidth = Math.max(1, content - visibleWidth(glyph.promptArrow));
			const field = empty && placeholder !== "" ? `${focused ? inverse(" ") : " "}${color.gray(truncateToWidth(placeholder, Math.max(0, fieldWidth - 1), ""))}` : this.input.render(fieldWidth, spec.type === "secret", focused);
			sections.push(`${(focused ? color.accentUser : color.gray)(glyph.promptArrow)}${field}`);
		}
		if (this.result !== undefined) {
			const mark = this.result.ok ? color.accentSuccess(glyph.check) : color.accentError(glyph.ballotX);
			const text = this.result.ok ? color.textPrimary(this.result.text) : color.accentError(this.result.text);
			sections.push(...gap(), ...wrapTextWithAnsi(`${mark} ${text}`, content), "");
			emitButtons(sections, stepLines.length);
		}
		if (this.notice !== undefined) sections.push(color.gray(truncateToWidth(this.notice, content, glyph.ellipsis)));
		rest.push(...sections);
		const budget = Math.max(1, maxHeight - MODAL_CHROME_ROWS - rest.length);
		const steps = stepLines.length > budget ? [color.gray(`${glyph.ellipsis} ${stepLines.length - budget + 1} earlier steps`), ...stepLines.slice(stepLines.length - budget + 1)] : stepLines;
		const trimmed = stepLines.length - steps.length;
		const body = [...steps, ...rest];
		const shiftedButtons = buttons.map((button) => ({ ...button, y: button.y - trimmed }));
		const hints = renderHints(this.hints(), content, HINT_SEP);
		const lines = withMargin([modalTop(this.title, frame, this.closeHovered), ...Array.from({ length: modalSizing.vPad }, () => modalRow("", frame)), ...body.map((row) => modalContent(row, frame)), ...hints.map((row) => modalContent(row, frame)), modalBottom(frame)], width);
		this.layout = { width, height: lines.length, buttons: shiftedButtons, inputRow: inputRow === undefined ? undefined : inputRow - trimmed };
		this.cache = { key, lines };
		return lines;
	}

	private controls(): Control[] {
		return [...(this.prompt !== undefined && this.phase === "running" ? [{ kind: "input" } as const] : []), ...this.availableButtons().map((button) => ({ kind: "button", button }) as const)];
	}

	private availableButtons(): Button[] {
		switch (this.phase) {
			case "success":
				return [
					{ id: "model", label: "Choose a model", hotkey: "m" },
					{ id: "done", label: "Done", hotkey: "d" },
				];
			case "error":
				return [{ id: "close", label: "Close" }];
			case "running":
				if (this.auth === undefined) return [];
				return [
					{ id: "open", label: "Open in browser", hotkey: "o" },
					{ id: "copy", label: "Copy link", hotkey: "c" },
					...(this.auth.code === undefined ? [] : [{ id: "copy-code", label: "Copy code", hotkey: "k" } as const]),
				];
		}
	}

	private hints(): string[] {
		switch (this.phase) {
			case "success":
				return ["m model", "d done", "esc close"];
			case "error":
				return ["esc close"];
			case "running": {
				const hints: string[] = [];
				if (this.prompt !== undefined) hints.push("enter submit");
				if (this.auth !== undefined) hints.push("o open", "c copy");
				if (this.auth?.code !== undefined) hints.push("k code");
				if (this.prompt !== undefined && this.auth !== undefined) hints.push("tab next");
				hints.push("esc cancel");
				return hints;
			}
		}
	}

	private buttonAt(x: number, y: number): number | undefined {
		const hit = this.layout.buttons.findIndex((button) => button.y === y && x >= button.x && x < button.x + button.width);
		return hit < 0 ? undefined : hit + (this.prompt !== undefined && this.phase === "running" ? 1 : 0);
	}

	/** Open and copy hand the focus back to a pending field, so the key can be pasted right after the browser trip. */
	private activate(button: Button): void {
		this.cache = undefined;
		if (this.prompt !== undefined && this.phase === "running") this.focus = 0;
		switch (button.id) {
			case "open":
				if (this.auth !== undefined) {
					this.handlers.open(this.auth.url);
					this.notice = "Opened the link in your browser";
				}
				return;
			case "copy":
				if (this.auth !== undefined) {
					this.handlers.copy(this.auth.url);
					this.notice = "Link copied to the clipboard";
				}
				return;
			case "copy-code":
				if (this.auth?.code !== undefined) {
					this.handlers.copy(this.auth.code);
					this.notice = "Code copied to the clipboard";
				}
				return;
			case "model":
				return this.handlers.onChooseModel();
			case "done":
			case "close":
				return this.handlers.onClose();
		}
	}

	private submit(): void {
		const prompt = this.prompt;
		if (prompt === undefined) return;
		const value = this.input.value.trim();
		this.endPrompt();
		prompt.handlers.onAnswer(value);
	}

	private launch(url: string): void {
		if (!this.autoOpen || this.opened.has(url)) return;
		this.opened.add(url);
		this.handlers.open(url);
	}

	private renderSteps(width: number, running: boolean): string[] {
		const steps = this.steps.length === 0 && running && this.prompt === undefined && this.auth === undefined ? [{ text: `Waiting for ${this.provider}${glyph.ellipsis}`, links: [] }] : this.steps;
		const lines: string[] = [];
		steps.forEach((step, index) => {
			const active = running && index === steps.length - 1;
			const mark = active ? color.textSecondary(spinnerFrame(brailleSpinner, this.tick)) : color.gray(glyph.check);
			const text = active ? color.textPrimary(step.text) : color.gray(step.text);
			lines.push(truncateToWidth(`${mark} ${text}`, width, glyph.ellipsis));
			for (const item of step.links) lines.push(`  ${truncateToWidth(item.label === undefined ? link(item.url) : `${color.gray(item.label)}: ${link(item.url)}`, Math.max(0, width - 2), glyph.ellipsis)}`);
		});
		return lines;
	}

	private renderCode(code: string, width: number): string[] {
		const inner = Math.min(Math.max(0, width - 2), visibleWidth(code) + 4);
		const border = color.modalBorder;
		const text = truncateToWidth(code, Math.max(0, inner - 4), "");
		return [
			border(`${square.tl}${square.h.repeat(inner)}${square.tr}`),
			`${border(square.v)}${color.codeBg(`  ${color.code(text)}${" ".repeat(Math.max(0, inner - 4 - visibleWidth(text)))}  `)}${border(square.v)}`,
			border(`${square.bl}${square.h.repeat(inner)}${square.br}`),
		];
	}
}
