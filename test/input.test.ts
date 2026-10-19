import { expect, test } from "bun:test";
import { formatInput, parseInput } from "../src/core/input.ts";

test("parseInput inverts formatInput, keeps multi-line text, and rejects input without the header", () => {
	const framed = formatInput({ userId: "roach", channel: "tui", text: "line one\nline two" });
	expect(framed).toBe('<from user="roach" channel="tui"/>\nline one\nline two');
	expect(parseInput(framed)).toEqual({ userId: "roach", channel: "tui", text: "line one\nline two" });
	expect(parseInput(formatInput({ userId: "u", channel: "slack", text: "" }))).toEqual({ userId: "u", channel: "slack", text: "" });
	expect(parseInput("plain text")).toBeUndefined();
	expect(parseInput('x<from user="a" channel="b"/>\nhi')).toBeUndefined();
});
