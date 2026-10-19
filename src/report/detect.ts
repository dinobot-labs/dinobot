/**
 * Frustration/profanity detection for automatic reports. Local, lexical, no model call.
 * A rule id names what matched; the matched text itself is never sent anywhere.
 * False positives cost one bounded, undoable report; false negatives cost nothing but a missed signal.
 */

export type DetectionRule = "profanity.ko" | "profanity.en" | "frustration.ko" | "frustration.en";

/** Words containing a profanity stem that are ordinary vocabulary. */
const KO_SAFE = /시발점|시발역|개시발[표송행매주]|출시발[표송]/g;

const KO_PROFANITY = new RegExp(
	[
		"[시씨쉬쓔쒸][이]?[발빨팔벌]",
		"ㅅ\\s*ㅂ",
		"ㅆ\\s*ㅂ",
		"ㅂ\\s*ㅅ",
		"ㅈ\\s*같",
		"존나|졸라|좆|좃같",
		"개새[끼기]|개색[기히]|새끼야",
		"병신|븅신|빙신",
		"미친[놈년새것]|미친\\s*거\\s*아냐|미쳤냐",
		"엿\\s*먹",
		"꺼지라고|닥쳐|닥치고",
		"지랄",
		"염병|썅",
	].join("|"),
);

const EN_PROFANITY = /\b(?:fuck(?:ing|ed|er|s)?|f+u+c+k+|wtf|shit(?:ty)?|bullshit|damn(?:it)?|goddamn|crap(?:py)?|stupid (?:bot|ai|thing)|useless (?:bot|ai|piece)|piece of (?:shit|crap)|dumbass|idiot(?:ic)?)\b/i;

const KO_FRUSTRATION = /(?:왜\s*또|또\s*(?:이러|틀렸|안\s*돼|안\s*되)|몇\s*번(?:을|째)?\s*말|아까\s*말했잖|하지\s*말라고\s*했|제대로\s*좀|답답(?:하|해)|짜증(?:나|난|이)|어이\s*없|말\s*좀\s*들어|장난\s*하냐|이게\s*뭐야)/;

const EN_FRUSTRATION = /\b(?:again\?!|(?:i|I) (?:already|just) told you|how many times|stop doing that|that's (?:still )?wrong again|you keep (?:doing|breaking|ignoring)|for the (?:third|fourth|fifth|last) time|are you kidding me)\b/i;

/** Quoted or fenced text (code, logs, pasted output) is not the user's own voice. */
function ownWords(text: string): string {
	return text
		.replace(/```[\s\S]*?(?:```|$)/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		.split("\n")
		.filter((line) => !/^\s*>/.test(line))
		.join("\n");
}

export function detectFrustration(text: string): DetectionRule | undefined {
	const own = ownWords(text).replace(KO_SAFE, " ");
	if (KO_PROFANITY.test(own)) return "profanity.ko";
	if (EN_PROFANITY.test(own)) return "profanity.en";
	if (KO_FRUSTRATION.test(own)) return "frustration.ko";
	if (EN_FRUSTRATION.test(own)) return "frustration.en";
	return undefined;
}
