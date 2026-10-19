import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type BrowserSessionRequest = { readonly url: string; readonly cookieNames: readonly string[] };

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const START_TIMEOUT_MS = 30_000;
const POLL_MS = 250;
const CHROME_CANDIDATES = [
	"google-chrome-stable",
	"google-chrome",
	"chromium",
	"chromium-browser",
	"/opt/google/chrome/chrome",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

function chromeExecutable(): string {
	const configured = process.env.DINOBOT_CHROME;
	if (configured) return configured;
	for (const candidate of CHROME_CANDIDATES) {
		const found = Bun.which(candidate);
		if (found) return found;
	}
	throw new Error("browser sign-in needs Chrome or Chromium; install one or set DINOBOT_CHROME");
}

function cookieMatches(host: string, domain: string): boolean {
	const bare = domain.replace(/^\./, "");
	return host === bare || host.endsWith(`.${bare}`);
}

/**
 * oh-my-pi's browser-session login (e.g. Perplexity SSO) without puppeteer: a visible Chrome on a throwaway
 * profile opens the sign-in page, and the session cookie is read over the DevTools protocol once it appears.
 * The browser and its profile are always removed afterwards.
 */
export async function captureBrowserSession(request: BrowserSessionRequest, signal?: AbortSignal, deps: { readonly command?: readonly string[] } = {}): Promise<string> {
	const target = new URL(request.url);
	if (target.protocol !== "https:") throw new Error("browser sign-in requires an HTTPS URL");
	signal?.throwIfAborted();
	const timeout = AbortSignal.timeout(LOGIN_TIMEOUT_MS);
	const closed = new AbortController();
	const waiting = AbortSignal.any([timeout, closed.signal, ...(signal ? [signal] : [])]);
	const profile = await mkdtemp(join(tmpdir(), "dinobot-sso-"));
	let browser: ReturnType<typeof Bun.spawn> | undefined;
	let socket: WebSocket | undefined;
	try {
		browser = Bun.spawn(
			[...(deps.command ?? [chromeExecutable()]), `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--new-window", target.href],
			{ stdio: ["ignore", "ignore", "ignore"], env: { ...process.env } },
		);
		void browser.exited.then(() => closed.abort());
		socket = await connect(profile, waiting);
		let id = 0;
		const replies = new Map<number, (cookies: { name: string; value: string; domain: string }[]) => void>();
		socket.addEventListener("message", (message) => {
			const reply = JSON.parse(String(message.data)) as { id?: number; result?: { cookies?: { name: string; value: string; domain: string }[] } };
			if (reply.id !== undefined) replies.get(reply.id)?.(reply.result?.cookies ?? []);
		});
		socket.addEventListener("close", () => closed.abort());
		while (true) {
			waiting.throwIfAborted();
			const request_id = ++id;
			const cookies = await new Promise<{ name: string; value: string; domain: string }[]>((resolve, reject) => {
				replies.set(request_id, resolve);
				waiting.addEventListener("abort", () => reject(waiting.reason), { once: true });
				socket!.send(JSON.stringify({ id: request_id, method: "Storage.getCookies" }));
			});
			replies.delete(request_id);
			for (const name of request.cookieNames) {
				const session = cookies.find((cookie) => cookie.name === name && cookie.value !== "" && cookieMatches(target.hostname, cookie.domain));
				if (session) return session.value;
			}
			await Bun.sleep(POLL_MS);
		}
	} catch (error) {
		if (signal?.aborted) throw new Error("Login cancelled");
		if (timeout.aborted) throw new Error("browser sign-in timed out; start login again");
		if (closed.signal.aborted) throw new Error("login window closed before sign-in completed");
		throw error;
	} finally {
		socket?.close();
		if (browser && browser.exitCode === null) {
			browser.kill("SIGTERM");
			const exited = await Promise.race([browser.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
			if (!exited) browser.kill("SIGKILL");
		}
		await rm(profile, { recursive: true, force: true });
	}
}

/** Chrome writes `<port>\n<browser target path>` to DevToolsActivePort in the profile once remote debugging listens. */
async function connect(profile: string, waiting: AbortSignal): Promise<WebSocket> {
	const deadline = Date.now() + START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		waiting.throwIfAborted();
		const active = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch(() => "");
		const [port, path] = active.split("\n");
		if (port && path) {
			const socket = new WebSocket(`ws://127.0.0.1:${port.trim()}${path.trim()}`);
			const abandon = () => socket.close();
			waiting.addEventListener("abort", abandon, { once: true });
			try {
				await new Promise<void>((resolve, reject) => {
					socket.addEventListener("open", () => resolve(), { once: true });
					socket.addEventListener("error", () => reject(new Error("could not reach the sign-in browser")), { once: true });
					waiting.addEventListener("abort", () => reject(waiting.reason), { once: true });
				});
			} finally {
				waiting.removeEventListener("abort", abandon);
			}
			return socket;
		}
		await Bun.sleep(100);
	}
	throw new Error("the sign-in browser did not start");
}
