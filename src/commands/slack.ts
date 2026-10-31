import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import type { Bot } from "../core/bot.ts";
import type { LoadedPlugin } from "../plugins/types.ts";
import { validateMonitorConfig } from "../plugins/slack_personal/control.ts";
import { editManifestEntry } from "../setup/manifest-edit.ts";
import { readManifestSnapshot } from "../setup/manifest-file.ts";
import type { SetupDeps } from "./setup.ts";
import type { SlashCommand } from "./types.ts";

const nullableString = Type.Union([Type.String(), Type.Null()]);
/** Version 1 is carried as one JSON output event, not model text or a new HTTP route. */
export const SlackCommandStatusSchema = Type.Object({
 kind: Type.Literal("slack.status"), version: Type.Literal(1),
 configured: Type.Object({ source: Type.Union([Type.Literal("manifest-on-disk"), Type.Literal("unavailable")]), channel: Type.Boolean(), personal: Type.Boolean() }, { additionalProperties: false }),
 runtime: Type.Object({ loaded: Type.Boolean(), started: Type.Boolean(), connection: Type.Literal("unknown"), teamId: nullableString, ownerUserId: nullableString, readIdentity: Type.Union([Type.Literal("bot"), Type.Literal("user"), Type.Null()]) }, { additionalProperties: false }),
 monitor: Type.Union([Type.Null(), Type.Object({
  started: Type.Boolean(), enabled: Type.Boolean(), intervalSeconds: Type.Integer({ minimum: 60, maximum: 3600 }),
  watch: Type.Union([Type.Null(), Type.Object({ conversationId: Type.String(), channels: Type.Array(Type.String()), timeZone: Type.String(), summaries: Type.Boolean(), quietStart: Type.Integer(), quietEnd: Type.Integer() }, { additionalProperties: false })]),
  lastPollAt: Type.Union([Type.Number(), Type.Null()]), lastError: nullableString, threadError: nullableString, trackedThreads: Type.Integer(), delivery: Type.String(),
 }, { additionalProperties: false })]),
 disconnect: Type.Object({ configuration: Type.Union([Type.Literal("not-staged"), Type.Literal("staged")]), connection: Type.Literal("unchanged"), restartRequired: Type.Boolean() }, { additionalProperties: false }),
}, { additionalProperties: false });
export type SlackCommandStatus = Static<typeof SlackCommandStatusSchema>;

export function slackCommand(bot: Bot, plugins: readonly LoadedPlugin[], setup?: Pick<SetupDeps, "manifestPath">): SlashCommand {
 const service = plugins.find(p => p.id === "slack_personal")?.slackPersonal;
 let staged = false;
 return {
  name: "slack", description: "Local Slack status, monitoring and staged disconnect", usage: "status|monitor <json>|disconnect", surfaces: ["tui"],
  arguments: async () => ["status", "monitor", "disconnect"].map(value => ({ value, label: value })),
  async run(args, invocation) {
   const { io, surface, channel, threadKey, context } = invocation;
   // Do not trust the interactive bit alone or a command object retained from local discovery.
   if (surface !== "tui" || channel !== "tui" || !io.interactive) throw new Error("Slack commands require a trusted local TUI conversation");
   if (io.signal.aborted) throw new Error("aborted");
   const match = /^(status|monitor|disconnect)(?:\s+([\s\S]*))?$/.exec(args.trim());
   if (!match || match[1] !== "monitor" && match[2]?.trim()) throw new Error("Use /slack status|monitor <json>|disconnect");
   const action = match[1];
   let value: ReturnType<typeof validateMonitorConfig> | undefined;
   if (action === "monitor") {
    let raw: unknown;
    try { raw = JSON.parse(match[2] ?? ""); } catch { throw new Error("Invalid Slack monitor JSON"); }
    value = validateMonitorConfig(raw);
    if (!service) throw new Error("Slack personal runtime is not loaded; apply setup and restart first");
    if (staged) throw new Error("Slack disconnect is staged; resolve the configuration apply and restart first");
   }
   // Read errors and YAML diagnostics must not echo manifest contents or credentials.
   let base: Awaited<ReturnType<typeof readManifestSnapshot>> | undefined;
   let configured: SlackCommandStatus["configured"] = { source: "unavailable", channel: false, personal: false };
   if (setup) {
    try {
     base = await readManifestSnapshot(setup.manifestPath);
     const raw = Bun.YAML.parse(base.text) as { channels?: { slack?: unknown }; plugins?: { slack_personal?: unknown } } | null;
     configured = { source: "manifest-on-disk", channel: !!raw?.channels?.slack, personal: !!raw?.plugins?.slack_personal };
    } catch { throw new Error("Unable to read Slack configuration"); }
   }
   if (io.signal.aborted) throw new Error("aborted");
   if (action === "monitor") {
    const conversation = await bot.conversation(channel, threadKey, context);
    if (io.signal.aborted) throw new Error("aborted");
    if (staged) throw new Error("Slack disconnect is staged; restart first");
    service!.configure(value, String(conversation.id));
   }
   if (action === "disconnect") {
    if (!setup || !base || !io.apply) throw new Error("This front end cannot stage Slack configuration changes");
    let candidate: string;
    try {
     candidate = editManifestEntry(base.text, "channels", "slack", undefined);
     candidate = editManifestEntry(candidate, "plugins", "slack_personal", false);
    } catch { throw new Error("Cannot safely stage Slack disconnect; manifest unchanged"); }
    // Stop/fence the single loaded monitor before handing ownership of CAS/restart to the front end.
    // No credential files, live Socket Mode consumer or manifest bytes are changed here.
    service?.disable();
    io.apply({ manifestPath: setup.manifestPath, baseSha256: base.sha256, candidate,
     changes: ["- channels.slack", "plugins.slack_personal: false"],
     summary: ["Slack configuration disabled after successful apply/restart. Credential files retained."], locale: invocation.locale ?? "" });
    staged = true;
   }
   const state = service?.status();
   const result: SlackCommandStatus = {
    kind: "slack.status", version: 1, configured,
    runtime: { loaded: !!service, started: state?.monitor.started ?? false, connection: "unknown", teamId: state?.teamId ?? null, ownerUserId: state?.ownerUserId ?? null, readIdentity: state?.readIdentity ?? null },
    monitor: state?.monitor ?? null,
    disconnect: { configuration: staged ? "staged" : "not-staged", connection: "unchanged", restartRequired: staged },
   };
   io.print(JSON.stringify(result));
  },
 };
}
