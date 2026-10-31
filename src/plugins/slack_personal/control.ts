import { Type } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import type { SlackMonitor } from "./monitor.ts";

/** Shared command/tool boundary; all mutation still belongs to SlackMonitor. */
export const SlackMonitorConfigSchema = Type.Object({
 enabled: Type.Boolean(),
 channels: Type.Array(Type.String({ pattern: "^[CDG][A-Z0-9]{2,}$" }), { maxItems: 5, uniqueItems: true }),
 intervalSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 3600 })),
 summaries: Type.Optional(Type.Boolean()),
 timeZone: Type.String({ minLength: 1, maxLength: 64 }),
 quietStart: Type.Optional(Type.Integer({ minimum: 0, maximum: 23 })),
 quietEnd: Type.Optional(Type.Integer({ minimum: 0, maximum: 23 })),
}, { additionalProperties: false });
export type SlackMonitorConfig = Static<typeof SlackMonitorConfigSchema>;
export function validateMonitorConfig(value: unknown): SlackMonitorConfig {
 if (!Value.Check(SlackMonitorConfigSchema, value)) throw new Error("Invalid Slack monitor configuration");
 try { new Intl.DateTimeFormat("en", { timeZone: value.timeZone }).format(); } catch { throw new Error("Invalid Slack monitor time zone"); }
 if (value.enabled && value.channels.length === 0) throw new Error("Select at least one channel");
 return value;
}
export type SlackPersonalControl = {
 status(): { teamId: string; ownerUserId: string; readIdentity: "bot" | "user"; monitor: ReturnType<SlackMonitor["status"]> };
 configure(value: unknown, conversationId: string): void;
 disable(): void;
};
