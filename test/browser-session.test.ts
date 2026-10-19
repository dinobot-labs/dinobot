import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureBrowserSession as capture, type BrowserSessionRequest } from "../src/auth/browser-session.ts";

const FAKE_CHROME = join(import.meta.dir, "fixtures", "fake-chrome.ts");
// Windows cannot uv_spawn a shebang script; launch the same fixture explicitly through Bun on every platform.
const captureBrowserSession = (request: BrowserSessionRequest, signal?: AbortSignal) => capture(request, signal, { command: [process.execPath, FAKE_CHROME] });

afterEach(() => {
	delete process.env.DINOBOT_CHROME;
	delete process.env.FAKE_CHROME_LOG;
	delete process.env.FAKE_CHROME_EXIT;
	delete process.env.FAKE_CHROME_HANG;
});

async function useFakeChrome(): Promise<string> {
	const log = join(await mkdtemp(join(tmpdir(), "fake-chrome-")), "log");
	process.env.FAKE_CHROME_LOG = log;
	return log;
}

test("opens the sign-in URL on a throwaway profile, returns the matching domain's session cookie, and removes the profile", async () => {
	const log = await useFakeChrome();
	const token = await captureBrowserSession({ url: "https://www.example.com/auth/signin", cookieNames: ["session"] });
	expect(token).toBe("tok-123");
	const [profile, url] = (await readFile(log, "utf8")).split("\n");
	expect(url).toBe("https://www.example.com/auth/signin");
	expect(await Bun.file(join(profile as string, "DevToolsActivePort")).exists()).toBe(false);
});

test("a closed window, a cancelled login and a non-HTTPS URL reject", async () => {
	await useFakeChrome();
	process.env.FAKE_CHROME_EXIT = "1";
	await expect(captureBrowserSession({ url: "https://www.example.com/", cookieNames: ["missing"] })).rejects.toThrow("login window closed before sign-in completed");
	delete process.env.FAKE_CHROME_EXIT;
	const controller = new AbortController();
	const pending = captureBrowserSession({ url: "https://www.example.com/", cookieNames: ["missing"] }, controller.signal);
	controller.abort();
	await expect(pending).rejects.toThrow("Login cancelled");
	await expect(captureBrowserSession({ url: "http://www.example.com/", cookieNames: ["session"] })).rejects.toThrow("HTTPS");
});

test("cancelling while the DevTools handshake hangs rejects and still removes the browser profile", async () => {
	const log = await useFakeChrome();
	process.env.FAKE_CHROME_HANG = "1";
	const controller = new AbortController();
	const pending = captureBrowserSession({ url: "https://www.example.com/", cookieNames: ["session"] }, controller.signal);
	while (!(await Bun.file(log).exists())) await Bun.sleep(20);
	const [profile] = (await readFile(log, "utf8")).split("\n");
	while (!(await Bun.file(`${log}.handshake`).exists())) await Bun.sleep(20);
	controller.abort();
	await expect(pending).rejects.toThrow("Login cancelled");
	expect(await Bun.file(join(profile as string, "DevToolsActivePort")).exists()).toBe(false);
});
