import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Event, ID, type Ledger, type Op, reduce } from "./model.ts";

/**
 * Event-sourced ledger files (ADR 0105). `<root>/<id>.json` holds only the hash-chained event list; the state is the
 * replay of those events, so a stored snapshot can never drift from its history. The root lives in the bot's data
 * directory, outside workspaces; a hand edit breaks the chain, which every load detects. The chain is unkeyed: it does
 * not stop an agent with a shell from recomputing every hash (ADR 0105).
 */
export const GENESIS = "0".repeat(64);

export function eventHash(prev: string, event: Omit<Event, "hash" | "prev">): string {
	return createHash("sha256").update(prev).update("\n").update(JSON.stringify(event)).digest("hex");
}

export type Loaded = { readonly ledger: Ledger; readonly events: readonly Event[] };

/** Verify the chain and replay it. Throws with the first broken event. */
export function replay(events: readonly Event[]): Ledger {
	let prev = GENESIS;
	let state: Ledger | undefined;
	events.forEach((event, index) => {
		const { hash, prev: storedPrev, ...body } = event;
		if (event.seq !== index + 1) throw new Error(`event ${index + 1}: sequence ${event.seq}`);
		if (storedPrev !== prev) throw new Error(`event ${event.seq}: chain broken (prev ${storedPrev.slice(0, 12)} != ${prev.slice(0, 12)})`);
		if (eventHash(prev, body) !== hash) throw new Error(`event ${event.seq}: hash mismatch (edited outside the pm tools)`);
		state = reduce(state, event);
		prev = hash;
	});
	if (state === undefined) throw new Error("ledger has no events");
	return state;
}

export class LedgerStore {
	readonly #root: string;
	readonly #queues = new Map<string, Promise<unknown>>();
	constructor(root: string) {
		this.#root = root;
	}

	get root(): string {
		return this.#root;
	}

	#path(id: string): string {
		if (!ID.test(id)) throw new Error(`ledger id ${JSON.stringify(id)} must match ${ID}`);
		return join(this.#root, `${id}.json`);
	}

	async load(id: string): Promise<Loaded> {
		let text: string;
		try {
			text = await readFile(this.#path(id), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`unknown ledger ${id}`);
			throw error;
		}
		const events = (JSON.parse(text) as { events: Event[] }).events;
		return { ledger: replay(events), events };
	}

	async ids(): Promise<string[]> {
		try {
			return (await readdir(this.#root)).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).filter((id) => ID.test(id)).sort();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	/**
	 * Serialized read-check-append for one ledger: `decide` sees the current state and returns the ops to record (or
	 * throws to record nothing). The new file replaces the old one atomically.
	 */
	async mutate<T>(id: string, actor: string, now: () => number, decide: (current: Loaded | undefined) => Promise<{ ops: readonly Op[]; result: (ledger: Ledger) => T }>): Promise<T> {
		const previous = this.#queues.get(id) ?? Promise.resolve();
		const run = previous.catch(() => undefined).then(async () => {
			const path = this.#path(id);
			let current: Loaded | undefined;
			try {
				current = await this.load(id);
			} catch (error) {
				if (!(error instanceof Error && error.message === `unknown ledger ${id}`)) throw error;
			}
			const { ops, result } = await decide(current);
			const events = [...(current?.events ?? [])];
			let prev = events.at(-1)?.hash ?? GENESIS;
			for (const op of ops) {
				const body = { ...op, seq: events.length + 1, at: now(), actor } as Omit<Event, "hash" | "prev">;
				const hash = eventHash(prev, body);
				events.push({ ...body, prev, hash } as Event);
				prev = hash;
			}
			const ledger = replay(events);
			if (ops.length) {
				await mkdir(this.#root, { recursive: true });
				const tmp = `${path}.${randomUUID()}.tmp`;
				await writeFile(tmp, `${JSON.stringify({ events }, null, 1)}\n`, "utf8");
				await rename(tmp, path);
			}
			return result(ledger);
		});
		this.#queues.set(id, run);
		try {
			return await run;
		} finally {
			if (this.#queues.get(id) === run) this.#queues.delete(id);
		}
	}
}
