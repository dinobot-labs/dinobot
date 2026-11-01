import { describe, expect, test } from "bun:test";
import { LABELS } from "../../src/client/showcase/labels.ts";

const placeholders = (s: string) => (s.match(/\{[^}]+\}/g) ?? []).sort();

describe("showcase labels", () => {
	test("en and ko have identical key sets", () => {
		const en = Object.keys(LABELS.en).sort();
		const ko = Object.keys(LABELS.ko).sort();
		expect(ko).toEqual(en);
		expect(en.length).toBeGreaterThan(100);
	});

	test("every label is a non-empty trimmed string in both locales", () => {
		for (const locale of ["en", "ko"] as const) {
			for (const [key, value] of Object.entries(LABELS[locale])) {
				expect(typeof value, `${locale}.${key}`).toBe("string");
				expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
				expect(value, `${locale}.${key}`).toBe(value.trim());
			}
		}
	});

	test("placeholders match between locales", () => {
		for (const key of Object.keys(LABELS.en) as (keyof typeof LABELS.en)[]) {
			expect(placeholders(LABELS.ko[key]), key).toEqual(placeholders(LABELS.en[key]));
		}
	});

	test("Korean copy is actually Korean where it is prose", () => {
		const hangul = /[\uac00-\ud7a3]/;
		const neutral = new Set(["dag.who", "demo.title", "demo.bot", "asg.file"]);
		for (const [key, value] of Object.entries(LABELS.ko)) {
			if (neutral.has(key)) continue;
			expect(hangul.test(value), `ko.${key} = ${value}`).toBe(true);
		}
	});

	test("copy obeys the facts sheet rulings (no emoji, no exclamation marks, no unsupported claims)", () => {
		const banned = [/gets better every run/i, /smarter/i, /fine-tun/i, /open source/i, /unreleased/i, /remembers everything/i, /unlimited/i, /guarantee/i];
		const emoji = /\p{Extended_Pictographic}/u;
		for (const locale of ["en", "ko"] as const) {
			for (const [key, value] of Object.entries(LABELS[locale])) {
				expect(emoji.test(value), `${locale}.${key}`).toBe(false);
				expect(value.includes("!"), `${locale}.${key}`).toBe(false);
				for (const re of banned) expect(re.test(value), `${locale}.${key}: ${re}`).toBe(false);
			}
		}
	});

	test("the self-improvement copy says it learns", () => {
		expect(LABELS.en["demo.learned"]).toMatch(/^Learned 1 working agreement$/);
		expect(LABELS.ko["demo.learned"]).toContain("작업 약속");
	});
});
