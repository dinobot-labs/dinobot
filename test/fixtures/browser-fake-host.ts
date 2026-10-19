// A stand-in for the browser plugin's Patchright host: the real host Session and RPC loop over a fake `chromium`.
// Run as `bun browser-fake-host.ts <log> [connectDelayMs]`; every spawn, launch, connect and page action is appended
// to <log> so tests can assert on what the host did without a real Chrome.
import { appendFileSync } from "node:fs";
import type { Chromium } from "../../src/plugins/browser/host.ts";

// 1x1 opaque red PNG.
export const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

type Listener = (...args: unknown[]) => void;

class Emitter {
	readonly #listeners = new Map<string, Listener[]>();
	on(event: string, listener: Listener): this {
		this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
		return this;
	}
	emit(event: string, ...args: unknown[]): void {
		for (const listener of this.#listeners.get(event) ?? []) listener(...args);
	}
}

export class FakeDialog {
	answered: string | undefined;
	readonly #done: () => void;
	constructor(private readonly kind: string, private readonly text: string, done: () => void) {
		this.#done = done;
	}
	type(): string {
		return this.kind;
	}
	message(): string {
		return this.text;
	}
	defaultValue(): string {
		return "";
	}
	async accept(promptText?: string): Promise<void> {
		this.answered = `accept${promptText === undefined ? "" : `:${promptText}`}`;
		this.#done();
	}
	async dismiss(): Promise<void> {
		this.answered = "dismiss";
		this.#done();
	}
}

const REFS = new Set(["e1", "e2", "e3"]);

class FakeLocator {
	constructor(private readonly page: FakePage, private readonly selector: string) {}
	#act(name: string, detail = ""): void {
		if (this.selector === "#missing") throw new Error(`locator.${name}: Timeout 15000ms exceeded.\nCall log:\n  - waiting for locator('#missing')`);
		this.page.record(`${name} ${this.selector}${detail}`);
	}
	async count(): Promise<number> {
		const ref = /^aria-ref=(e\d+)$/.exec(this.selector)?.[1];
		return ref === undefined || REFS.has(ref) ? 1 : 0;
	}
	async click(options?: { button?: string }): Promise<void> {
		this.#act("click", options?.button && options.button !== "left" ? ` ${options.button}` : "");
	}
	async dblclick(): Promise<void> {
		this.#act("dblclick");
	}
	async fill(text: string): Promise<void> {
		this.#act("fill", ` ${JSON.stringify(text)}`);
	}
	async hover(): Promise<void> {
		this.#act("hover");
	}
	async selectOption(values: string[]): Promise<string[]> {
		this.#act("select", ` ${values.join(",")}`);
		return values;
	}
	async scrollIntoViewIfNeeded(): Promise<void> {
		this.#act("scrollIntoView");
	}
	async setInputFiles(paths: string[]): Promise<void> {
		this.#act("setInputFiles", ` ${paths.join(",")}`);
	}
	async evaluate(): Promise<boolean> {
		return this.selector.includes("file");
	}
	async innerText(): Promise<string> {
		return this.selector === "body" ? "Fake body text" : `text of ${this.selector}`;
	}
	first(): this {
		return this;
	}
	async waitFor(): Promise<void> {
		this.#act("waitFor");
	}
}

export class FakePage extends Emitter {
	#url = "about:blank";
	#closed = false;
	readonly keyboard = {
		type: async (text: string) => this.record(`type ${JSON.stringify(text)}`),
		press: async (key: string) => this.record(`press ${key}`),
	};
	readonly mouse = { wheel: async (dx: number, dy: number) => this.record(`wheel ${dx} ${dy}`) };
	constructor(readonly context: FakeContext, readonly name: string, readonly openerPage: FakePage | null = null) {
		super();
	}
	record(line: string): void {
		this.context.log(`${this.name}: ${line}`);
	}
	url(): string {
		return this.#url;
	}
	async title(): Promise<string> {
		return this.#url === "about:blank" ? "" : "Fake Page";
	}
	async goto(url: string): Promise<null> {
		this.#url = url;
		this.record(`goto ${url}`);
		return null;
	}
	async ariaSnapshot(options?: { mode?: string }): Promise<string> {
		this.record(`ariaSnapshot ${options?.mode ?? "default"}`);
		const tree = '- button "OK" [ref=e1]\n- textbox "Name" [ref=e2]\n';
		return this.#url.includes("long") ? tree + "x".repeat(5000) : tree;
	}
	locator(selector: string): FakeLocator {
		return new FakeLocator(this, selector);
	}
	getByText(text: string): FakeLocator {
		return new FakeLocator(this, `text=${text}`);
	}
	async screenshot(options?: { fullPage?: boolean }): Promise<Buffer> {
		this.record(`screenshot fullPage=${options?.fullPage === true}`);
		return Buffer.from(PIXEL, "base64");
	}
	async evaluate(js: string): Promise<unknown> {
		if (js === "crash") process.exit(3);
		if (js === "alert") {
			return new Promise((resolve) => {
				const dialog = new FakeDialog("alert", "hello", () => resolve("after dialog"));
				this.emit("dialog", dialog);
			});
		}
		if (js === "popup") {
			const popup = new FakePage(this.context, `page${this.context.pages().length}`, this);
			this.context.add(popup);
			return "opened";
		}
		return { evaluated: js };
	}
	async opener(): Promise<FakePage | null> {
		return this.openerPage;
	}
	isClosed(): boolean {
		return this.#closed;
	}
	async close(): Promise<void> {
		this.#closed = true;
		this.record("close");
		this.context.remove(this);
		this.emit("close");
	}
	async bringToFront(): Promise<void> {
		this.record("bringToFront");
	}
	async goBack(): Promise<null> {
		this.record("back");
		return null;
	}
	async goForward(): Promise<null> {
		this.record("forward");
		return null;
	}
	async reload(): Promise<null> {
		this.record("reload");
		return null;
	}
	async waitForTimeout(ms: number): Promise<void> {
		this.record(`waitForTimeout ${ms}`);
	}
	async waitForURL(): Promise<void> {
		this.record("waitForURL");
	}
}

export class FakeContext extends Emitter {
	readonly #pages: FakePage[] = [];
	constructor(readonly log: (line: string) => void, initial: string[]) {
		super();
		for (const name of initial) {
			const page = new FakePage(this, name);
			void page.goto(`https://user.example/${name}`);
			this.#pages.push(page);
		}
	}
	pages(): FakePage[] {
		return [...this.#pages];
	}
	add(page: FakePage): void {
		this.#pages.push(page);
		this.emit("page", page);
	}
	remove(page: FakePage): void {
		this.#pages.splice(this.#pages.indexOf(page), 1);
	}
	async newPage(): Promise<FakePage> {
		const page = new FakePage(this, `page${this.#pages.length}`);
		this.#pages.push(page);
		this.log(`newPage ${page.name}`);
		return page;
	}
	setDefaultTimeout(): void {}
	setDefaultNavigationTimeout(): void {}
	async close(): Promise<void> {
		this.log("context.close");
		this.emit("close");
	}
}

/** A fake `chromium`: dedicated launches get one blank tab; attach connects to a browser with two user tabs. */
export function fakeChromium(log: (line: string) => void, connectDelayMs = 0): Chromium {
	const chromium = {
		launchPersistentContext: async (dir: string, options: Record<string, unknown>) => {
			log(`launch ${dir} ${JSON.stringify(options)}`);
			const context = new FakeContext(log, []);
			const blank = await context.newPage();
			void blank;
			return context;
		},
		connectOverCDP: async (endpoint: string, options: Record<string, unknown>) => {
			log(`connect ${endpoint} ${JSON.stringify(options)}`);
			await new Promise((resolve) => setTimeout(resolve, connectDelayMs));
			log("connected");
			const context = new FakeContext(log, ["user0", "user1"]);
			const browser = new (class extends Emitter {
				contexts() {
					return [context];
				}
				async close() {
					log("browser.close");
				}
			})();
			return browser;
		},
	};
	return chromium as unknown as Chromium;
}

if (import.meta.main) {
	const [logPath, delay] = process.argv.slice(2);
	const log = (line: string) => appendFileSync(logPath!, `${line}\n`);
	log(`spawn ${process.pid}`);
	const { Session, serveStdio, hostConfigFromEnv } = await import("../../src/plugins/browser/host.ts");
	await serveStdio(new Session(hostConfigFromEnv(), { chromium: fakeChromium(log, Number(delay ?? 0)), pendingAfterMs: 150, pendingWaitMs: 5000 }));
}
