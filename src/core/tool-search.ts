export interface ToolDocument {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

function tokens(text: string): string[] {
	return text.normalize("NFC").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** BM25, k1=1.2/b=.75, names weighted 6, description/schema keys 1.
 * Callers must filter the catalogue by conversation permissions before ranking.
 */
export function searchTools(query: string, documents: readonly ToolDocument[], limit = 3): ToolDocument[] {
	if (query.length > 256 || !Number.isInteger(limit) || limit < 1 || limit > 5) throw new RangeError("Invalid query length or limit");
	const exact = documents.find(t => t.name === query.trim());
	if (exact) return [exact];
	const terms = new Set(tokens(query));
	if (!terms.size) return [];
	const df = new Map<string, number>();
	const corpus = documents.map(tool => {
		const tf = new Map<string, number>();
		for (const [text, weight] of [[tool.name, 6], [tool.description, 1], [Object.keys((tool.parameters.properties ?? {}) as object).join(" "), 1]] as const) {
			for (const term of tokens(text)) tf.set(term, (tf.get(term) ?? 0) + weight);
		}
		for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
		return { tool, tf, length: [...tf.values()].reduce((a, b) => a + b, 0) };
	});
	const average = corpus.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, corpus.length) || 1;
	return corpus.map(doc => {
		let score = 0;
		for (const term of terms) {
			const tf = doc.tf.get(term) ?? 0;
			if (!tf) continue;
			const frequency = df.get(term) ?? 0;
			score += Math.log(1 + (corpus.length - frequency + .5) / (frequency + .5)) * tf * 2.2 / (tf + 1.2 * (.25 + .75 * doc.length / average));
		}
		return { tool: doc.tool, score };
	}).filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name)).slice(0, limit).map(r => r.tool);
}
