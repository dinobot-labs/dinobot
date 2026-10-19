/**
 * Bounded pagination and text truncation. The proofs these functions satisfy are in
 * openwiki/architecture/github.md and are checked exhaustively in test/github.test.ts.
 */

export type Collected<T> = {
	readonly items: T[];
	/** `false` proves `items` holds every kept item of the source; `true` means more may exist. */
	readonly truncated: boolean;
};

/**
 * Read pages 1..maxPages in order and keep the first `limit` distinct items accepted by `keep`.
 * At most `maxPages` requests. A short page (fewer than `perPage` items) means the source ended.
 */
export async function collect<T>(
	fetchPage: (page: number) => Promise<readonly T[]>,
	options: {
		readonly limit: number;
		readonly perPage: number;
		readonly maxPages: number;
		readonly keep?: (item: T) => boolean;
		readonly key: (item: T) => unknown;
	},
): Promise<Collected<T>> {
	const items: T[] = [];
	const seen = new Set<unknown>();
	for (let page = 1; page <= options.maxPages; page++) {
		const batch = await fetchPage(page);
		for (const item of batch) {
			if (options.keep !== undefined && !options.keep(item)) continue;
			const key = options.key(item);
			if (seen.has(key)) continue;
			if (items.length === options.limit) return { items, truncated: true };
			seen.add(key);
			items.push(item);
		}
		if (batch.length < options.perPage) return { items, truncated: false };
		if (items.length === options.limit) return { items, truncated: true };
	}
	return { items, truncated: true };
}

/**
 * Pages (1-based, ascending) that hold the last `min(limit, total)` items of an
 * oldest-first list of `total` items: page k holds indices [(k-1)·perPage, k·perPage).
 */
export function tailPages(total: number, limit: number, perPage: number): number[] {
	if (total <= 0 || limit <= 0) return [];
	const first = Math.floor(Math.max(0, total - limit) / perPage) + 1;
	const last = Math.ceil(total / perPage);
	return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

export type Truncated = { readonly text: string; readonly truncated: boolean };

/** Cut to at most `max` UTF-16 code units without splitting a surrogate pair. */
export function truncate(text: string, max: number): Truncated {
	if (text.length <= max) return { text, truncated: false };
	let end = max;
	const last = text.charCodeAt(end - 1);
	if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
	return { text: text.slice(0, end), truncated: true };
}
