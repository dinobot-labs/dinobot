import { expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { LoginCard } from "../src/tui/login-card.ts";

const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m|\x1b_pi:c\x07|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
const fits = (lines: readonly string[], width: number, label: string): void => {
	expect(lines.length, label).toBeGreaterThan(0);
	for (const line of lines) expect(visibleWidth(line), `${label}: ${strip(line)}`).toBe(width);
};
const click = (x: number, y: number, cols: number, rows: number) => ({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: cols, height: rows, shift: false, alt: false, ctrl: false }) as const;
const move = (x: number, y: number, cols: number, rows: number) => ({ ...click(x, y, cols, rows), type: "move" }) as const;

type Log = { cancels: number; closes: number };
type State = "running" | "auth-url" | "prompt" | "device-code" | "success" | "error";
const STATES: readonly State[] = ["running", "auth-url", "prompt", "device-code", "success", "error"];

function card(state: State, size: () => { cols: number; rows: number }): { card: LoginCard; log: Log } {
	const log: Log = { cancels: 0, closes: 0 };
	const login = new LoginCard("GitHub Copilot", { onCancel: () => log.cancels++, onClose: () => log.closes++, onChooseModel: () => {}, open: () => {}, copy: () => {} }, size, { autoOpen: false });
	login.event({ type: "progress", message: "Starting the github-copilot login with a fairly long progress message" });
	if (state === "auth-url" || state === "prompt") login.event({ type: "auth_url", url: "https://example.com/oauth/authorize?client_id=abcdef&state=0123456789", instructions: "Open this URL in your browser to continue:" });
	if (state === "prompt") login.ask({ type: "secret", message: "Paste the authorization code" }, { onAnswer: () => {}, onCancel: () => {} });
	if (state === "device-code") login.event({ type: "device_code", userCode: "WDJB-MJHT", verificationUri: "https://github.com/login/device" });
	if (state === "success") login.finish("Logged in to GitHub Copilot", "success");
	if (state === "error") login.finish("the daemon closed /login before it finished", "error");
	return { card: login, log };
}

/** The tui-polish change in modal.ts (plain top border below 8 frame cells, withMargin clipping) also governs the login card: every line keeps exactly the overlay width. */
test("login card: every rendered line has exactly the overlay width for every width 4..40, in every phase and terminal height", () => {
	for (const state of STATES) {
		for (let cols = 4; cols <= 40; cols++) {
			for (const rows of [4, 6, 8, 12, 20, 40]) {
				const { card: login } = card(state, () => ({ cols, rows }));
				fits(login.render(cols), cols, `${state} ${cols}x${rows}`);
				login.handleInput("\t");
				login.handleMouse(move(cols - 4, 1, cols, rows));
				fits(login.render(cols), cols, `${state} ${cols}x${rows} after tab+hover`);
			}
		}
	}
});

test("login card: below 10 overlay columns the top border is a plain rule without [x]; clicks and hovers along it never close or cancel the card; from 10 columns [x] is back and closes it", () => {
	for (const state of STATES) {
		const finished = state === "success" || state === "error";
		for (let cols = 4; cols <= 12; cols++) {
			const rows = 20;
			const { card: login, log } = card(state, () => ({ cols, rows }));
			const before = login.render(cols);
			const top = strip(before[1] ?? "");
			if (cols < 10) {
				expect(top, `${state} ${cols}`).not.toContain("x]");
				expect(top, `${state} ${cols}`).toMatch(new RegExp(`^ .[^ ]{${cols - 4}}. $`));
				for (let x = 0; x < cols; x++) {
					login.handleMouse(move(x, 1, cols, rows));
					expect(login.render(cols), `${state} ${cols} hover ${x}`).toEqual(before);
				}
				for (let x = 1; x < cols - 1; x++) login.handleMouse(click(x, 1, cols, rows));
				expect(log, `${state} ${cols} border clicks`).toEqual({ cancels: 0, closes: 0 });
				// Only the two blank margin columns count as outside clicks, which close a finished card and leave a running one open.
				login.handleMouse(click(0, 1, cols, rows));
				login.handleMouse(click(cols - 1, 1, cols, rows));
				expect(log, `${state} ${cols} margin clicks`).toEqual({ cancels: 0, closes: finished ? 2 : 0 });
			} else {
				expect(top, `${state} ${cols}`).toContain("x]");
				const frame = cols - 2;
				login.handleMouse(click(1 + frame - 5, 1, cols, rows));
				expect(log, `${state} ${cols} [x] click`).toEqual(finished ? { cancels: 0, closes: 1 } : { cancels: 1, closes: 0 });
			}
		}
	}
});
