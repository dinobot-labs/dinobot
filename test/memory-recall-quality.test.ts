import { expect, test } from "bun:test";
import { rankMemories, recallTerms } from "../src/core/memory/recall.ts";

const docs = (...contents: string[]) => contents.map((content, i) => ({ key: `auto/${i}`, content }));
const facts = docs(
	"Vanguard가 설치되어 있고 같은 드라이버를 사용한다.",
	"CI는 GitHub Actions으로 실행한다.",
	"VPS는 SSH으로 접속한다.",
	"Slack에서 메시지를 받고 웹훅으로 전달한다.",
	"파일시스템 경로는 NTFS이다.",
	"릴리스는 수동으로 배포한다.",
	"브라우저는 Chrome으로 실행한다.",
	"테스트는 Bun으로 실행한다.",
	"패키지는 npm으로 설치한다.",
	"로그는 파일로 보관한다.",
);

for (const query of [
	"지금 전혀 관련 없는 기억에 서치되는거 같은데?",
	"수학적으로 분석해서 원인 찾고 개선방안 리서치",
	"디자인 시스템 Geist 폰트 어드민 UI",
	"개선하고 테스팅도 다 해줘 실제로",
]) {
	test(`unrelated Korean request abstains: ${query}`, () => {
		expect(rankMemories(facts, query)).toEqual([]);
	});
}

test("internal Hangul fragments and particles are not lexical anchors", () => {
	const terms = recallTerms("파일시스템 설치되어 수학적으로 Vanguard가 Slack에서");
	for (const fragment of ["시스", "스템", "치되", "으로"]) expect(terms.has(fragment)).toBe(false);
	for (const anchor of ["파일시스템", "설치", "수학적", "vanguard", "slack"]) expect(terms.has(anchor)).toBe(true);
	expect(rankMemories(docs("파일시스템", "설치되어", "수학적으로"), "시스템 서치되는거 자동으로")).toEqual([]);
});

for (const [content, query] of [
	["Vanguard가 설치되어 있다.", "Vanguard"],
	["Slack에서 알림을 받는다.", "SLACK!"],
	["배포는 금요일이다.", "배포"],
	["설치되어 있다.", "설치"],
	["문서를 저장한다.", "문서는"],
	["한글 경로", "한글에서".normalize("NFD")],
	["MEMORY_NOTE_KIND is stable", "memory_note_kind"],
	["Geist 폰트", "(GEIST),"],
	["사과", "사과는"],
	["npm 로그인이 필요하다.", "로그인"],
	["PC에는 Node가 있다.", "PC"],
	["publish하려면 npm login", "publish"],
	["전문가", "전문가가"],
	["매크로를 실행한다.", "매크로"],
	["매크로는 유용하다.", "매크로"],
	["해상도를 높인다.", "해상도"],
	["매크로", "매크로는"],
] as const) {
	test(`one-memory lexical lookup: ${query}`, () => {
		expect(rankMemories(docs(content), query).map(({ entry }) => entry.key)).toEqual(["auto/0"]);
	});
}

test("empty, stopword-only and unanchored queries abstain even in a large corpus", () => {
	const corpus = [...facts, ...docs(...Array.from({ length: 100 }, (_, i) => `unrelated${i}`))];
	for (const query of ["", "?!", "the and with", "으로 에서 같은", "계속해", "quartz"]) {
		expect(rankMemories(corpus, query)).toEqual([]);
	}
	expect(rankMemories([], "Vanguard")).toEqual([]);
});

test("lexical IDF ranks distinct anchors, not repetitions or word length", () => {
	const corpus = docs("alpha beta", "alpha", "beta", "beta");
	const result = rankMemories(corpus, "alpha beta");
	expect(result.map(({ entry }) => entry.key)).toEqual(["auto/0", "auto/1", "auto/2", "auto/3"]);
	expect(result[0]!.score).toBeCloseTo(Math.log(3) + Math.log(1 + 4 / 3));
	expect(rankMemories(corpus, "ALPHA alpha beta beta")).toEqual(result);
	expect(rankMemories(docs("파일시스템"), "파일시스템")[0]!.score).toBeCloseTo(Math.log(2));
	expect(rankMemories(docs("배포"), "배포 배포는 배포를")[0]!.score).toBeCloseTo(Math.log(2));
});

test("ambiguous noun endings are not treated as particles", () => {
	expect(rankMemories(docs("해상 운송은 선박을 사용한다."), "해상도")).toEqual([]);
	expect(rankMemories(docs("다운로드"), "다운로드경로")).toEqual([]);
	expect(recallTerms("매크로 해상도 다운로드경로")).toEqual(new Set(["매크로", "해상도", "다운로드경로"]));
});

test("manual keys are anchors but automatic key hashes are not", () => {
	expect(rankMemories([{ key: "Vanguard", content: "Installed locally." }], "vanguard")).toHaveLength(1);
	expect(rankMemories([{ key: "auto/deadbeef", content: "Installed locally." }], "deadbeef")).toEqual([]);
});
