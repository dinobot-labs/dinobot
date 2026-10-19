import { expect, test } from "bun:test";
import type { JsonValue } from "@earendil-works/chord";
import { AUTO_TURNS, projectEntries, TOOL_CHARS } from "../src/report/bundle.ts";

const ROOT = 7;
let nextId = 1;
const user = (who: string, text: string, conversationId = ROOT): JsonValue => ({ id: nextId++, conversationId, kind: "pi.user", model: [{ role: "user", content: `<from user="${who}" channel="slack"/>\n${text}` }] });
const assistant = (text: string, args?: Record<string, JsonValue>, conversationId = ROOT): JsonValue => ({
	id: nextId++,
	conversationId,
	kind: "pi.assistant",
	model: [{ role: "assistant", content: [{ type: "text", text }, ...(args ? [{ type: "toolCall", id: "t", name: "bash", arguments: args }] : [])] }],
});
const tool = (text: string, conversationId = ROOT): JsonValue => ({ id: nextId++, conversationId, kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "bash", content: [{ type: "text", text }] }] });
const nudge: JsonValue = { id: nextId++, conversationId: ROOT, kind: "dinobot.nudge", model: [{ role: "user", content: "[dinobot memory] secret project memory" }] };
const system: JsonValue = { id: nextId++, conversationId: ROOT, kind: "pi.system", model: [] };
const summary: JsonValue = { id: nextId++, conversationId: ROOT, kind: "pi.compaction", model: [{ role: "user", content: "summary of everything bob said" }] };

test("T2: whole thread incl. subagents, nudges dropped, senders pseudonymised, secrets redacted", () => {
	const raw = [system, nudge, user("roach", "내 번호 010-1234-5678"), assistant("ok"), tool("x".repeat(5_000)), user("roach", "sub", 99), summary];
	const result = projectEntries(raw, { tier: "T2", root: ROOT, reporter: "roach", excludeOthers: false });
	const text = JSON.stringify(result.entries);
	expect(result.entries).toHaveLength(5);
	expect(text).not.toContain("secret project memory");
	expect(text).not.toContain("010-1234-5678");
	expect(text).not.toContain('user=\\"roach\\"');
	expect(text).toContain('user=\\"reporter\\"');
	expect(text).toContain("x".repeat(5_000)); // T2 keeps long tool output up to 64 KiB
	expect(result.omitted.nudges).toBe(2);
	expect(result.redactions.phone).toBe(1);
});

test("T1: root only, last AUTO_TURNS user turns, tool output and tool-call args capped, assistant prose intact", () => {
	const raw: JsonValue[] = [];
	for (let i = 0; i < AUTO_TURNS + 5; i++) raw.push(user("roach", `turn ${i}`), assistant(`answer ${i} ${"p".repeat(3_000)}`, { command: "c".repeat(5_000) }), tool("o".repeat(5_000)));
	raw.push(user("roach", "child", 99), tool("child output", 99));
	const result = projectEntries(raw, { tier: "T1", root: ROOT, reporter: "roach", excludeOthers: false });
	const users = result.entries.filter((e) => e.kind === "pi.user");
	expect(users).toHaveLength(AUTO_TURNS);
	expect(JSON.stringify(users[0])).toContain("turn 5");
	expect(result.entries.every((e) => e.conversationId === ROOT)).toBe(true);
	const toolText = JSON.stringify(result.entries.find((e) => e.kind === "pi.tool-result"));
	expect(toolText).toContain("[truncated");
	expect(toolText.length).toBeLessThan(TOOL_CHARS + 500);
	const assistantText = JSON.stringify(result.entries.find((e) => e.kind === "pi.assistant"));
	expect(assistantText).toContain("p".repeat(3_000));
	expect(assistantText).not.toContain("c".repeat(TOOL_CHARS + 1));
	expect(result.lastUserEntryId).toBe((users.at(-1) as { id: number }).id);
});

test("shared channel: other participants' text and whole-thread summaries are excluded", () => {
	const raw = [user("roach", "my question"), user("bob", "bob's private reply"), assistant("answer"), summary];
	const result = projectEntries(raw, { tier: "T2", root: ROOT, reporter: "roach", excludeOthers: true });
	const text = JSON.stringify(result.entries);
	expect(text).toContain("my question");
	expect(text).not.toContain("bob's private reply");
	expect(text).not.toContain("bob");
	expect(text).toContain("participant-1");
	expect(text).toContain("[participant omitted]");
	expect(text).not.toContain("summary of everything");
	expect(result.omitted).toMatchObject({ participants: 1, summaries: 1 });
});

test("newest-first storage order is projected chronologically (T1 window picks the latest turns)", () => {
	const raw: JsonValue[] = [];
	for (let i = 0; i < AUTO_TURNS + 3; i++) raw.push(user("roach", `turn ${i}`), assistant(`answer ${i}`));
	const result = projectEntries([...raw].reverse(), { tier: "T1", root: ROOT, reporter: "roach", excludeOthers: false });
	const users = result.entries.filter((e) => e.kind === "pi.user").map((e) => JSON.stringify(e));
	expect(users[0]).toContain("turn 3");
	expect(users.at(-1)).toContain(`turn ${AUTO_TURNS + 2}`);
	expect(result.entries.at(-1)?.kind).toBe("pi.assistant");
});
