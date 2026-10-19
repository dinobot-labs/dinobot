/** Test-only host entry: isolated profiles supplied by the smoke runner, never the user profile. */
import { chromium } from "patchright";
import { hostConfigFromEnv, serveStdio, Session, type Chromium } from "../../src/plugins/browser/host.ts";
const driver = {
 launchPersistentContext: (path: string, options: Parameters<Chromium["launchPersistentContext"]>[1]) => chromium.launchPersistentContext(path, { ...options, channel: "chrome", headless: true, viewport: { width: 800, height: 600 } }),
 connectOverCDP: chromium.connectOverCDP.bind(chromium),
} as Chromium;
await serveStdio(new Session(hostConfigFromEnv(), { chromium: driver }));
