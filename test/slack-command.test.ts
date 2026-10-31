import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Value } from "typebox/value";
import { openBot } from "../src/core/bot.ts";
import { createCommands, withCommands, type CommandRequest } from "../src/commands/index.ts";
import { slackCommand, SlackCommandStatusSchema, type SlackCommandStatus } from "../src/commands/slack.ts";
import type { CommandEvent, CommandIO } from "../src/commands/types.ts";
import { createSlackPersonalPlugin } from "../src/plugins/slack_personal/index.ts";
import { SlackMonitor } from "../src/plugins/slack_personal/monitor.ts";
import { SlackPersonalClient } from "../src/plugins/slack_personal/client.ts";
import { SlackMonitorConfigSchema } from "../src/plugins/slack_personal/control.ts";
import { loadPlugin } from "../src/plugins/types.ts";
import { SLACK_BOT_SCOPES, type SlackFetch } from "../src/setup/slack.ts";
import { createPrivateFile } from "../src/telegram-private-files/index.ts";
import { readManifestSnapshot, replaceManifest } from "../src/setup/manifest-file.ts";
import { startClientApi } from "../src/api/server.ts";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const settings = { enabled: true, channels: ["D123", "C123"], timeZone: "Asia/Seoul", intervalSeconds: 120, quietStart: 22, quietEnd: 8, summaries: true };
async function fixture(loaded = true, history?: SlackFetch) {
 const dir = mkdtempSync(join(tmpdir(), "slack-command-"));
 cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
 const token = "xoxb-fixture-secret";
 const botFile = join(dir, "bot.token"); createPrivateFile(botFile, token);
 const manifestPath = join(dir, "dinobot.yaml");
 const base = "# preserved\nchannels:\n  slack:\n    botTokenFile: " + JSON.stringify(botFile) + "\n  http:\n    port: 1234\nplugins:\n  slack_personal:\n    botTokenFile: " + JSON.stringify(botFile) + "\n  web: false\n";
 writeFileSync(manifestPath, base);
 let monitor!: SlackMonitor;
 let apiCalls = 0;
 const fetch: SlackFetch = async (url, init) => {
  apiCalls++;
  if (url.endsWith("bots.info")) return Response.json({ ok: true, bot: { app_id: "A123" } });
  if (url.endsWith("auth.test")) return Response.json({ ok: true, team_id: "T123", user_id: "UBOT", bot_id: "B123" }, { headers: { "x-oauth-scopes": SLACK_BOT_SCOPES.join(",") } });
  return history ? history(url, init) : Response.json({ ok: true, messages: [] });
 };
 const load = async () => {
  const p = await loadPlugin(createSlackPersonalPlugin({ fetch, timers: false, onMonitor: m => { monitor = m; } }), { botTokenFile: botFile, teamId: "T123", ownerUserId: "U123" }, { dataDir: dir, resolveDependency: async () => undefined });
  if (Array.isArray(p)) throw new Error(p.join(";"));
  return p;
 };
 const plugin = loaded ? await load() : undefined;
 let pluginClosed = false;
 const closePlugin = async () => { if (plugin && !pluginClosed) { pluginClosed = true; await plugin.close?.(); } };
 cleanup.push(closePlugin);
 const models = createModels();
 const faux = fauxProvider({ provider: "faux", models: [{ id: "faux" }] }); models.setProvider(faux.provider);
 // No responses are queued: any accidental model call fails.
 const bot = await openBot({ storage: await openNodeSqliteStorage(join(dir, "bot.sqlite")), models, defaultModel: { provider: "faux", modelId: "faux" }, plugins: [], toolMode: "direct", curation: { enabled: false } }, context);
 cleanup.push(() => bot.close(context));
 const commands = createCommands({ bot, models, auth: {} as never, plugins: plugin ? [plugin] : [], setup: { manifestPath, dataDir: dir, pluginCatalog: {} } });
 const run = async (args: string, scope: Partial<CommandRequest> = {}) => {
  const events: CommandEvent[] = [];
  for await (const event of commands.run(commands.find("slack", "tui")!, args, { surface: "tui", channel: "tui", threadKey: "local", userId: "local", context, ...scope }).events) events.push(event);
  expect(JSON.stringify(events)).not.toContain(token);
  return events;
 };
 return { dir, bot, commands, run, plugin, load, closePlugin, manifestPath, base, botFile, token, calls: () => apiCalls, get monitor() { return monitor; } };
}
function status(events: CommandEvent[]): SlackCommandStatus {
 expect(events.at(-1)?.type).toBe("done");
 const outputs = events.filter(e => e.type === "output"); expect(outputs).toHaveLength(1);
 const value = JSON.parse(outputs[0]!.text);
 expect(Value.Check(SlackCommandStatusSchema, value)).toBe(true);
 return value;
}
test("actual registry dispatch returns versioned state without model, tools or Slack API calls", async () => {
 const f = await fixture(); const before = f.calls();
 // Commands must not dispatch the model tools even when those tools are present.
 for (const tool of f.plugin!.tools) tool.execute = async () => { throw new Error("model tool invoked"); };
 expect(f.commands.list("tui").some(c => c.name === "slack")).toBe(true);
 const initial = status(await f.run("status"));
 expect(initial).toMatchObject({ version: 1, configured: { channel: true, personal: true }, runtime: { loaded: true, started: false, connection: "unknown", readIdentity: "bot" }, monitor: { enabled: false } });
 const next = status(await f.run("monitor " + JSON.stringify(settings)));
 const local = await f.bot.conversation("tui", "local", context);
 expect(next.monitor).toMatchObject({ enabled: true, intervalSeconds: 120, watch: { channels: settings.channels, summaries: true, conversationId: String(local.id), timeZone: settings.timeZone, quietStart: 22, quietEnd: 8 } });
 expect(f.calls()).toBe(before);
 expect(readFileSync(f.manifestPath, "utf8")).toBe(f.base);
 expect(status(await f.run("status"))).toEqual(next);
});
test("remote surfaces, mismatched local channel and channel wrapper deny every action", async () => {
 const f = await fixture(); const before = f.calls();
 expect(f.commands.find("slack", "channel")).toBeUndefined();
 for (const scope of [{ surface: "channel" as const, channel: "slack" }, { surface: "tui" as const, channel: "slack" }, { surface: "channel" as const, channel: "tui" }, { channel: "http" }]) {
  for (const args of ["status", "monitor " + JSON.stringify(settings), "disconnect"]) expect((await f.run(args, scope)).at(-1)).toMatchObject({ type: "error", message: expect.stringContaining("trusted local") });
 }
 const handler = withCommands(f.commands, async () => { throw new Error("model reached"); }, context);
 expect(await handler({ channel: "slack", threadKey: "D123", messageId: "1", userId: "U123", text: "/slack status" })).toMatchObject({ status: "answered", text: expect.stringContaining("unknown command") });
 expect(f.calls()).toBe(before); expect(f.monitor.status().enabled).toBe(false);
});
test("validation fails closed without modifying persisted monitoring; errors never echo arguments", async () => {
 const f = await fixture(); const initial = status(await f.run("monitor " + JSON.stringify(settings)));
 for (const bad of [null, {}, { ...settings, enabled: "true" }, { ...settings, channels: [] }, { ...settings, channels: ["U123"] }, { ...settings, channels: ["D123", "D123"] }, { ...settings, channels: Array.from({length: 6}, (_, i) => "C12" + i) }, { ...settings, intervalSeconds: 59 }, { ...settings, intervalSeconds: 3601 }, { ...settings, intervalSeconds: 60.5 }, { ...settings, quietStart: -1 }, { ...settings, quietEnd: 24 }, { ...settings, timeZone: f.token }, { ...settings, summaries: "yes" }, { ...settings, token: f.token }]) {
  expect((await f.run("monitor " + JSON.stringify(bad))).at(-1)?.type).toBe("error");
  expect(status(await f.run("status"))).toEqual(initial);
 }
 for (const args of ["monitor " + f.token, "status " + f.token, "disconnect " + f.token]) expect((await f.run(args)).at(-1)?.type).toBe("error");
 const disabled = status(await f.run("monitor " + JSON.stringify({ ...settings, enabled: false, channels: [], intervalSeconds: 3600 })));
 expect(disabled.monitor).toMatchObject({ enabled: false, watch: null, intervalSeconds: 3600 });
});
test("disconnect fences in-flight polling, stages CAS only, preserves unrelated config and secrets", async () => {
 let release!: (response: Response) => void; let entered!: () => void;
 const enteredPromise = new Promise<void>(r => { entered = r; });
 const f = await fixture(true, async () => { entered(); return new Promise<Response>(r => { release = r; }); });
 await f.run("monitor " + JSON.stringify(settings));
 let wakes = 0; await f.plugin!.start?.({ wake: async () => { wakes++; return "admitted"; } });
 await enteredPromise;
 const events = await f.run("disconnect"); const state = status(events);
 expect(state).toMatchObject({ configured: { channel: true, personal: true }, runtime: { loaded: true, started: true }, monitor: { enabled: false, watch: null }, disconnect: { configuration: "staged", connection: "unchanged", restartRequired: true } });
 const apply = events.find(e => e.type === "apply"); expect(apply?.type).toBe("apply"); if (apply?.type !== "apply") throw new Error("missing apply");
 const parsed = Bun.YAML.parse(apply.request.candidate) as any;
 expect(parsed.channels).toEqual({ http: { port: 1234 } }); expect(parsed.plugins).toEqual({ slack_personal: false, web: false });
 expect(readFileSync(f.manifestPath, "utf8")).toBe(f.base); expect(readFileSync(f.botFile, "utf8")).toBe(f.token);
 release(Response.json({ ok: true, messages: [{ ts: String(Date.now()/1000+1), user: "UOTHER", text: "private request" }] }));
 await f.monitor.tick(); expect(wakes).toBe(0); expect(f.monitor.db.query("SELECT * FROM outbox").all()).toHaveLength(0);
 expect(status(await f.run("status")).disconnect.configuration).toBe("staged");
 expect((await f.run("monitor " + JSON.stringify(settings))).at(-1)?.type).toBe("error");
 await expect(f.plugin!.tools.find(t => t.name === "slack_personal_monitor")!.execute(settings, { conversationId: "1", channel: async () => "tui" })).rejects.toThrow("staged");
 // Existing CAS rejects an intervening editor; command never owns that write/restart.
 writeFileSync(f.manifestPath, f.base + "# concurrent\n");
 await expect(replaceManifest(f.manifestPath, apply.request.candidate, apply.request.baseSha256)).rejects.toThrow("changed");
 expect((await readManifestSnapshot(f.manifestPath)).text).toEndWith("# concurrent\n");
 // Reopen the same durable state without touching a live daemon.
 await f.closePlugin();
 const restored = await f.load(); try { expect(restored.slackPersonal!.status().monitor).toMatchObject({ enabled: false, intervalSeconds: 120 }); } finally { await restored.close?.(); }
});
test("monitor state restores including interval, timezone, summary and local destination", async () => {
 const f = await fixture(); const first = status(await f.run("monitor " + JSON.stringify({ ...settings, intervalSeconds: 60, quietStart: 0, quietEnd: 0 })));
 await f.closePlugin();
 const restored = await f.load(); try { expect(restored.slackPersonal!.status().monitor).toEqual(first.monitor!); } finally { await restored.close?.(); }
});
test("unloaded status is explicit; absent service cannot pretend to configure monitoring", async () => {
 const f = await fixture(false);
 expect(status(await f.run("status"))).toMatchObject({ configured: { personal: true }, runtime: { loaded: false, started: false }, monitor: null });
 expect((await f.run("monitor " + JSON.stringify(settings))).at(-1)?.type).toBe("error");
 expect(status(await f.run("disconnect"))).toMatchObject({ monitor: null, disconnect: { configuration: "staged" } });
});
test("aborted or unsupported apply and malformed manifest leave monitoring unchanged", async () => {
 const f = await fixture(); const original = status(await f.run("monitor " + JSON.stringify(settings)));
 expect((await f.run("disconnect", { signal: AbortSignal.abort() })).at(-1)?.type).toBe("error");
 expect(status(await f.run("status"))).toEqual(original);
 const io: CommandIO = { signal: new AbortController().signal, interactive: true, print() {}, notify() {}, state() {}, prompt: async () => { throw new Error("unexpected prompt"); } };
 await expect(slackCommand(f.bot, [f.plugin!], { manifestPath: f.manifestPath }).run("disconnect", { surface: "tui", channel: "tui", threadKey: "local", userId: "local", context, io })).rejects.toThrow("cannot stage");
 expect(status(await f.run("status"))).toEqual(original);
 writeFileSync(f.manifestPath, "channels: [" + f.token);
 expect((await f.run("disconnect")).at(-1)).toMatchObject({ type: "error", message: "Unable to read Slack configuration" });
 expect(f.monitor.status()).toEqual(original.monitor!);
 expect(Value.Check(SlackCommandStatusSchema, { ...original, version: 2 })).toBe(false);
 expect(Value.Check(SlackCommandStatusSchema, { ...original, token: f.token })).toBe(false);
});
test("persisted interval rearms the sole timer and disable cancels polling", async () => {
 const dir = mkdtempSync(join(tmpdir(), "slack-timers-"));
 cleanup.push(async () => rmSync(dir, {recursive: true, force: true}));
 const m = new SlackMonitor(join(dir, "state.sqlite"), new SlackPersonalClient(undefined, "fixture", async () => Response.json({ok: true, messages: []})), "U123");
 const timer = spyOn(globalThis, "setTimeout"); const clear = spyOn(globalThis, "clearTimeout");
 try {
  m.start({wake: async () => "admitted"}); await m.tick(); expect(timer).not.toHaveBeenCalled();
  const watch = {conversationId: "1", channels: ["D123"], timeZone: "UTC", quietStart: 0, quietEnd: 0, summaries: false};
  m.configure(watch, 60); expect(timer.mock.calls.at(-1)?.[1]).toBe(60000);
  const first = timer.mock.results.at(-1)!.value;
  m.configure(watch, 120); expect(clear).toHaveBeenCalledWith(first); expect(timer.mock.calls.at(-1)?.[1]).toBe(120000);
  const second = timer.mock.results.at(-1)!.value;
  m.configure(undefined); expect(clear).toHaveBeenCalledWith(second);
  const count = timer.mock.calls.length; await m.tick(); expect(timer.mock.calls).toHaveLength(count);
 } finally { await m.close(); timer.mockRestore(); clear.mockRestore(); }
});
test("published machine schemas exactly match the command and shared input schemas", () => {
 const artifact = JSON.parse(readFileSync(new URL("../docs/slack-command-v1.schema.json", import.meta.url), "utf8"));
 expect(artifact.statusResponse).toEqual(JSON.parse(JSON.stringify(SlackCommandStatusSchema)));
 expect(artifact.monitorInput).toEqual(JSON.parse(JSON.stringify(SlackMonitorConfigSchema)));
});
test("existing HTTP command SSE carries schema-valid state and rejects remote thread selection", async () => {
 const f = await fixture(); const api = startClientApi(f.bot, 0, context, f.commands);
 try {
  const send = async (channel: string, args: string) => {
   const response = await fetch(new URL("/v1/threads/" + channel + "/local/commands", api.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "slack", args }) });
   expect(response.status).toBe(200);
   return (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)) as CommandEvent);
  };
  expect(status(await send("tui", "monitor " + JSON.stringify(settings))).monitor?.enabled).toBe(true);
  expect(status(await send("tui", "status")).runtime.loaded).toBe(true);
  expect((await send("slack", "disconnect")).at(-1)?.type).toBe("error");
 } finally { await api.stop(); }
});
