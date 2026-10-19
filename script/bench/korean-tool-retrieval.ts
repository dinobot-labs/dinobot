// Research prototype only: intentionally not imported by src/. Not a general Korean analyzer.
// Token coverage + controlled bilingual concepts; mathematical TF-IDF, independently implemented.
import { actions, domains, profiles } from "./korean-tool-metadata.ts";

export interface Document { name: string; description: string; }
export interface Match { name: string; score: number; }
const vocabulary = new Map<string, Set<string>>();
for (const [kind, entries] of [["d", domains], ["a", actions]] as const) {
	for (const [concept, words] of Object.entries(entries)) {
		for (const word of words) {
			const normalized = word.normalize("NFC").toLowerCase().replace(/\s+/g, "");
			const meanings = vocabulary.get(normalized) ?? new Set<string>();
			meanings.add(`${kind}:${concept}`);
			vocabulary.set(normalized, meanings);
		}
	}
}
// Finite surface endings, not arbitrary suffix stripping. Unknown eojeol remain unknown.
const endings = ["은", "는", "이", "가", "을", "를", "에", "에서", "에게", "의", "도", "만", "과", "와", "로", "으로", "들", "하고", "해서", "해", "해줘", "해요", "해주세요", "해주세요요", "해줄래", "해줄래요", "해주시고", "해주시겠어요", "해보자", "해봐", "해봐요", "하기", "하는", "한", "된", "좀", "줘", "주세요", "어", "어줘", "어주세요", "아", "아줘", "아주세요", "보여줘", "보여주세요", "보기", "해라", "하기를", "됐는지", "했는지", "중인", "할", "할게", "하기전에"];
const entries = [...vocabulary.entries()].sort(([a], [b]) => b.length - a.length || a.localeCompare(b));

function conceptsForWord(word: string): Set<string> {
	if (/^[a-z0-9_]+$/.test(word)) return new Set(vocabulary.get(word) ?? []);
	const memo = new Map<number, string[] | null>();
	function segment(offset: number): string[] | null {
		if (offset === word.length) return [];
		if (memo.has(offset)) return memo.get(offset)!;
		for (const [text, concepts] of entries) {
			if (!word.startsWith(text, offset)) continue;
			const rest = segment(offset + text.length);
			if (rest !== null) {
				const result = [...concepts, ...rest];
				memo.set(offset, result);
				return result;
			}
		}
		if (offset > 0) {
			for (const ending of endings) {
				if (!word.startsWith(ending, offset)) continue;
				const rest = segment(offset + ending.length);
				if (rest !== null) { memo.set(offset, rest); return rest; }
			}
		}
		memo.set(offset, null);
		return null;
	}
	return new Set(segment(0) ?? []);
}

export function retrieve(query: string, documents: readonly Document[], allowed: ReadonlySet<string>, limit = 3): Match[] {
	if (query.length > 256) throw new RangeError("Query exceeds 256 UTF-16 units");
	if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new RangeError("Limit must be 1–5");
	// Filter BEFORE exact lookup, document-frequency calculation and scoring.
	const eligible = [...new Map(documents.filter(d => allowed.has(d.name)).map(d => [d.name, d])).values()];
	const normalized = query.normalize("NFC").toLowerCase().trim();
	const exact = eligible.find(d => d.name === normalized);
	if (exact) return [{ name: exact.name, score: 1 }];
	// Complex negation is deliberately not interpreted as an affirmative action.
	if (/(?:말고|말아|마세요|하지|않|아니|금지|\bnot\b|\bwithout\b|don't)/u.test(normalized)) return [];
	const words = normalized.match(/[\p{L}\p{N}_]+/gu) ?? [];
	const concepts = new Set(words.flatMap(word => [...conceptsForWord(word)]));
	// Compact only bounded adjacent words for explicitly defined multiword lexical entries.
	for (let i = 0; i < words.length; i++) {
		for (let size = 2; size <= 3 && i + size <= words.length; size++) {
			const phrase = words.slice(i, i + size).join("");
			for (const concept of vocabulary.get(phrase) ?? []) concepts.add(concept);
		}
	}
	const candidates = eligible.flatMap(document => {
		const profile = profiles[document.name];
		if (!profile) return [];
		return [{ document, domain: profile.domains.map(x => `d:${x}`), action: profile.actions.map(x => `a:${x}`) }];
	});
	const frequencies = new Map<string, number>();
	for (const candidate of candidates) for (const c of new Set([...candidate.domain, ...candidate.action])) frequencies.set(c, (frequencies.get(c) ?? 0) + 1);
	const idf = (c: string) => 1 + Math.log((candidates.length + 1) / ((frequencies.get(c) ?? 0) + 1));
	return candidates.flatMap(candidate => {
		const domain = candidate.domain.filter(c => concepts.has(c));
		const action = candidate.action.filter(c => concepts.has(c));
		if (!domain.length || !action.length) return [];
		return [{ name: candidate.document.name, score: [...domain, ...action].reduce((sum, c) => sum + idf(c), 0) }];
	}).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}
