import { describe, expect, test } from "bun:test";
import { type DetectionRule, detectFrustration } from "../src/report/detect.ts";

describe("detectFrustration: triggers", () => {
	const cases: Array<[string, DetectionRule]> = [
		["아 씨발 왜 이래", "profanity.ko"],
		["ㅅㅂ 또 틀렸네", "profanity.ko"],
		["존나 느리네", "profanity.ko"],
		["이 병신 같은 코드", "profanity.ko"],
		["지랄하지 마", "profanity.ko"],
		["what the fuck is this", "profanity.en"],
		["this is bullshit", "profanity.en"],
		["wtf", "profanity.en"],
		["왜 또 이래요", "frustration.ko"],
		["아까 말했잖아요", "frustration.ko"],
		["몇 번을 말해야 돼", "frustration.ko"],
		["진짜 답답하네", "frustration.ko"],
		["I already told you not to do that", "frustration.en"],
		["how many times do I have to say it", "frustration.en"],
	];
	for (const [text, rule] of cases) test(text, () => expect(detectFrustration(text)).toBe(rule));
});

describe("detectFrustration: ordinary text stays quiet", () => {
	const quiet = [
		"시발점부터 다시 계산해 주세요",
		"서울역은 KTX 시발역이야",
		"신제품 개시발표 일정 잡아줘",
		"화면이 꺼져요",
		"테스트를 다시 돌려 주세요",
		"좋아요 고마워요",
		"please fix the failing test",
		"Scunthorpe and class assignment",
		"이 로그 봐줘:\n```\nERROR: fuck() is not defined\n```",
		"> 사용자가 '씨발'이라고 썼다는 신고\n이 인용문을 분석해줘",
		"`wtf` 라는 변수 이름 바꿔줘",
	];
	for (const text of quiet) test(JSON.stringify(text), () => expect(detectFrustration(text)).toBeUndefined());
});
