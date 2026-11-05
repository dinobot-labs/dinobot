import { expect, test } from "bun:test";
import { foldProgress, initialProgress, parseProgressEvent, renderProgress } from "../src/channels/progress.ts";
import { telegramProgress } from "../src/channels/telegram-progress.ts";

test("explicit wire clear retracts draft without accepting malformed empty drafts", () => {
 expect(parseProgressEvent({ type: "draft", text: "" })).toBeUndefined();
 const clear = parseProgressEvent({ type: "draft_clear" });
 expect(clear).toEqual({ type: "draft_clear" });
 if (!clear) throw new Error("missing clear event");
 const before = foldProgress(initialProgress(0), { type: "draft", text: "retracted public draft" }, 1);
 const after = foldProgress(before, clear, 2);
 expect(after.draft).toBeUndefined();
 expect(renderProgress(after, 2)).not.toContain("retracted public draft");
 expect(renderProgress(after, 2).length).toBeGreaterThan(0);
});

test("Telegram clears a published draft with a nonempty progress card", async () => {
 let now = 10000;
 const writes: { method: string; text: string }[] = [];
 const reporter = telegramProgress({ chat: "123", topic: "0", now: () => now, sleep: async ms => { now += ms; }, call: async (method, body) => {
  if (method === "sendMessage" || method === "editMessageText") {
   expect(typeof body.text).toBe("string");
   expect(String(body.text).length).toBeGreaterThan(0);
   writes.push({ method, text: String(body.text) });
  }
  return { ok: true, result: { message_id: 7 } };
 } });
 try {
  reporter.event({ type: "tool_start", id: "active", name: "read" });
  reporter.event({ type: "draft", text: "retracted public draft" });
  await reporter.tick();
  expect(writes.at(-1)?.text).toContain("retracted public draft");
  const clear = parseProgressEvent({ type: "draft_clear" });
  if (!clear) throw new Error("missing clear event");
  reporter.event(clear); now += 3001; await reporter.tick();
  expect(writes.at(-1)?.method).toBe("editMessageText");
  expect(writes.at(-1)?.text).not.toContain("retracted public draft");
  expect(writes.at(-1)?.text).toContain("read");
 } finally { await reporter.finish({ kind: "done" }); }
});
