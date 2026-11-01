import { expect, test } from "bun:test";
import { localePreferenceTarget } from "../src/client/app/locale-preference.ts";

test("root honors existing selector cookie before browser suggestion", () => {
	for (const cookie of ['lang=en', 'other=x; lang="EN"', 'lang=invalid; lang=en']) expect(localePreferenceTarget("/", cookie, ["ko-KR"])).toBeNull();
	for (const cookie of ['lang=ko', 'lang="KO"', 'x=en; lang=ko']) expect(localePreferenceTarget("/", cookie, ["en-US"])).toBe("/ko/");
});
test("browser preference uses first language, English is the default", () => {
	for (const languages of [["ko"], ["ko-KR", "en"], ["KO-kr"]]) expect(localePreferenceTarget("/", "lang=invalid", languages)).toBe("/ko/");
	for (const languages of [[], ["en", "ko"], ["fr", "ko"], ["korean"], ["*"]]) expect(localePreferenceTarget("/", "", languages)).toBeNull();
});
test("explicit routes win, Korean redirect target is a fixed point", () => {
	for (const path of ["/ko/", "/ko", "/privacy/", "/ko/privacy/", "/design/", "/unknown", "//evil.example/"]) {
		expect(localePreferenceTarget(path, "lang=ko", ["ko"])).toBeNull();
		expect(localePreferenceTarget(path, "lang=en", ["en"])).toBeNull();
	}
	const target = localePreferenceTarget("/", "", ["ko"]);
	expect(target).toBe("/ko/");
	expect(localePreferenceTarget(target!, "", ["ko"])).toBeNull();
});
