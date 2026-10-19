import { type Static, Type } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

/** Manifest `memory` block. Every field is optional; see `memoryConfig` for the defaults. */
export const MemoryShape = Type.Object({
	auto: Type.Optional(Type.Object({
		enabled: Type.Optional(Type.Boolean()),
		/** Extract once every N user turns of a channel/TUI thread. */
		everyTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
		/** `inherit` (the conversation's model) or `provider/modelId`. */
		model: Type.Optional(Type.String({ minLength: 1 })),
		maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
		leaseMs: Type.Optional(Type.Integer({ minimum: 10_000 })),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000 })),
		maxPerProject: Type.Optional(Type.Integer({ minimum: 1, maximum: 800 })),
	}, { additionalProperties: false })),
	recall: Type.Optional(Type.Object({
		enabled: Type.Optional(Type.Boolean()),
		maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
		budgetChars: Type.Optional(Type.Integer({ minimum: 80, maximum: 8000 })),
	}, { additionalProperties: false })),
	/** Work retrospectives that maintain the working agreements (retro.ts, agreements.ts). */
	retro: Type.Optional(Type.Object({
		enabled: Type.Optional(Type.Boolean()),
		/** Review at the latest every K user turns of a thread. */
		everyTurns: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
		/** Review a thread with unreviewed work after this many idle minutes. */
		idleMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
		/** `inherit` (the conversation's model) or `provider/modelId`. */
		model: Type.Optional(Type.String({ minLength: 1 })),
		maxRetries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
		leaseMs: Type.Optional(Type.Integer({ minimum: 10_000 })),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1_000 })),
		maxActivePerProject: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		maxActiveTeam: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		/** A retro agreement the user had to correct this often again is flagged for a person. */
		escalateAfterViolations: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	}, { additionalProperties: false })),
}, { additionalProperties: false });
export type MemoryOptions = Static<typeof MemoryShape>;

export type MemoryConfig = {
	readonly auto: {
		readonly enabled: boolean;
		readonly everyTurns: number;
		/** Absent: the conversation's own model. */
		readonly model?: ModelRef;
		readonly maxRetries: number;
		readonly leaseMs: number;
		readonly timeoutMs: number;
		readonly maxPerProject: number;
	};
	readonly recall: { readonly enabled: boolean; readonly maxItems: number; readonly budgetChars: number };
	readonly retro: {
		readonly enabled: boolean;
		readonly everyTurns: number;
		readonly idleMs: number;
		/** Absent: the conversation's own model. */
		readonly model?: ModelRef;
		readonly maxRetries: number;
		readonly leaseMs: number;
		readonly timeoutMs: number;
		readonly maxActivePerProject: number;
		readonly maxActiveTeam: number;
		readonly escalateAfterViolations: number;
	};
};

/** Off unless configured: the defaults a deployment gets once it passes a (possibly empty) `memory` block. */
export const DISABLED_MEMORY: MemoryConfig = {
	auto: { enabled: false, everyTurns: 6, maxRetries: 2, leaseMs: 300_000, timeoutMs: 120_000, maxPerProject: 200 },
	recall: { enabled: false, maxItems: 3, budgetChars: 1200 },
	retro: {
		enabled: false, everyTurns: 6, idleMs: 15 * 60_000, maxRetries: 2, leaseMs: 300_000, timeoutMs: 120_000,
		maxActivePerProject: 20, maxActiveTeam: 10, escalateAfterViolations: 3,
	},
};

function parseModel(raw: string, field: string, problems: string[]): ModelRef | undefined {
	if (raw === "inherit") return undefined;
	const slash = raw.indexOf("/");
	if (slash <= 0 || slash === raw.length - 1) {
		problems.push(`${field}: expected inherit or provider/modelId, got "${raw}"`);
		return undefined;
	}
	return { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}

/** Defaults applied, `model` parsed. Every loop is on unless a deployment turns it off. */
export function memoryConfig(options: MemoryOptions = {}): { config: MemoryConfig; problems: string[] } {
	const problems: string[] = [];
	const model = parseModel(options.auto?.model ?? "inherit", "memory.auto.model", problems);
	const defaults = DISABLED_MEMORY.auto;
	const given = options.auto ?? {};
	const auto = {
		enabled: given.enabled ?? true,
		everyTurns: given.everyTurns ?? defaults.everyTurns,
		maxRetries: given.maxRetries ?? defaults.maxRetries,
		leaseMs: given.leaseMs ?? defaults.leaseMs,
		timeoutMs: given.timeoutMs ?? defaults.timeoutMs,
		maxPerProject: given.maxPerProject ?? defaults.maxPerProject,
		...(model ? { model } : {}),
	};
	// A window may call two models (configured, then the conversation's), each bounded by timeoutMs.
	if (auto.leaseMs <= 2 * auto.timeoutMs) problems.push("memory.auto.leaseMs must exceed twice memory.auto.timeoutMs");
	const { idleMinutes, model: retroRaw, ...retroGiven } = options.retro ?? {};
	const retroModel = parseModel(retroRaw ?? "inherit", "memory.retro.model", problems);
	const retro = {
		...DISABLED_MEMORY.retro, ...retroGiven, enabled: retroGiven.enabled ?? true,
		...(idleMinutes === undefined ? {} : { idleMs: idleMinutes * 60_000 }),
		...(retroModel ? { model: retroModel } : {}),
	};
	if (retro.leaseMs <= 2 * retro.timeoutMs) problems.push("memory.retro.leaseMs must exceed twice memory.retro.timeoutMs");
	return {
		config: {
			auto,
			recall: { ...DISABLED_MEMORY.recall, ...options.recall, enabled: options.recall?.enabled ?? true },
			retro,
		},
		problems,
	};
}
