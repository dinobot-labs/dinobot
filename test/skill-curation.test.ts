import { expect, test } from "bun:test";
import {
	archiveThreshold, CURATION_DEFAULTS, curatableProvenance, decideCuration, expectedFalseArchiveExposures,
	skillCurationConfig, skillProvenance,
	type CurationConversationFacts, type CurationSkillFacts, type SkillCurationConfig,
} from "../src/core/skills/curation.ts";

const DAY = 86_400_000;
const L = archiveThreshold(CURATION_DEFAULTS.alpha, CURATION_DEFAULTS.pMax);

test("archive threshold numerics match the design values and are minimal", () => {
	expect(L).toBe(149);
	expect(archiveThreshold(0.05, 0.05)).toBe(59);
	expect(archiveThreshold(0.01, 0.02)).toBe(228);
	for (const [alpha, pMax] of [[0.05, 0.02], [0.05, 0.05], [0.01, 0.02], [0.1, 0.3]] as const) {
		const n = archiveThreshold(alpha, pMax);
		// Per-run error bound holds at L*, and L*-1 would violate it.
		expect((1 - pMax) ** n).toBeLessThanOrEqual(alpha);
		expect((1 - pMax) ** (n - 1)).toBeGreaterThan(alpha);
	}
	for (const [alpha, pMax] of [[0, 0.02], [1, 0.02], [0.05, 0], [0.05, 1], [Number.NaN, 0.02], [-1, 0.5]] as const) {
		expect(() => archiveThreshold(alpha, pMax)).toThrow(RangeError);
	}
});

test("expected exposures before a false archive follow ((1-p)^-L - 1)/p", () => {
	expect(expectedFalseArchiveExposures(0.02, L)).toBeCloseTo(964.6, 0);
	expect(Math.abs(expectedFalseArchiveExposures(0.05, L) / 41_600 - 1)).toBeLessThan(0.01);
	expect(Math.abs(expectedFalseArchiveExposures(0.1, L) / 6.6e7 - 1)).toBeLessThan(0.01);
	// A never-used skill is archived after exactly L* exposures.
	expect(expectedFalseArchiveExposures(0, L)).toBe(L);
	expect(() => expectedFalseArchiveExposures(1, L)).toThrow(RangeError);
	expect(() => expectedFalseArchiveExposures(0.1, 0)).toThrow(RangeError);
});

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

test("seeded simulation of the first use-free run agrees with E[T]", () => {
	for (const [p, threshold, trials] of [[0.05, 59, 4000], [0.1, 20, 4000]] as const) {
		const random = mulberry32(0xc0ffee + threshold);
		let total = 0;
		for (let trial = 0; trial < trials; trial++) {
			let run = 0, exposures = 0;
			while (run < threshold) {
				exposures++;
				run = random() < p ? 0 : run + 1;
			}
			total += exposures;
		}
		const expected = expectedFalseArchiveExposures(p, threshold);
		// Standard error ~ E[T]/sqrt(trials) ≈ 1.6%; tolerance 6%.
		expect(Math.abs(total / trials / expected - 1)).toBeLessThan(0.06);
	}
});

test("provenance derives from the first history actor", () => {
	expect(skillProvenance("source")).toBe("bundled");
	expect(skillProvenance("agent:17")).toBe("agent");
	expect(skillProvenance("host:skill-review")).toBe("review");
	expect(skillProvenance("system:skill-evaluation")).toBe("evolution");
	expect(skillProvenance("owner")).toBe("user");
	expect(skillProvenance("user:alice")).toBe("user");
	expect(skillProvenance(undefined)).toBe("user");
	const config = { includeUser: false, includeBundled: false };
	expect(["agent", "review", "evolution", "user", "bundled"].map(p => curatableProvenance(p as never, config))).toEqual([true, true, true, false, false]);
	expect(curatableProvenance("user", { includeUser: true, includeBundled: false })).toBe(true);
	expect(curatableProvenance("bundled", { includeUser: false, includeBundled: true })).toBe(true);
});

test("configuration defaults and validation", () => {
	expect(skillCurationConfig(undefined)).toEqual({ config: CURATION_DEFAULTS, problems: [] });
	expect(CURATION_DEFAULTS).toMatchObject({ enabled: true, minIdleMs: 14 * DAY, settleMs: 3_600_000, intervalMs: 6 * 3_600_000 });
	expect(skillCurationConfig({ alpha: 1, pMax: 0, intervalMs: 5, minIdleMs: -1 }).problems).toHaveLength(4);
});

// ─── Scan rules on synthetic facts ──────────────────────────────────────────

const NOW = 100 * DAY;
const config: SkillCurationConfig = { ...CURATION_DEFAULTS };
function skill(extra: Partial<CurationSkillFacts> = {}): CurationSkillFacts {
	return { name: "s", provenance: "agent", active: true, pinned: false, activationGeneration: 2, activatedAt: 0, ...extra };
}
let nextId = 1;
function root(extra: Partial<CurationConversationFacts> = {}): CurationConversationFacts {
	return { id: nextId++, up: null, root: true, createdAt: DAY, excluded: false, pin: { generation: 2, skills: ["s"] }, uses: {}, ...extra };
}
function roots(n: number, extra: Partial<CurationConversationFacts> = {}): CurationConversationFacts[] {
	return Array.from({ length: n }, () => root(extra));
}
function decide(conversations: CurationConversationFacts[], skills = [skill()], options: Partial<{ now: number; config: SkillCurationConfig }> = {}) {
	return decideCuration({ now: options.now ?? NOW, config: options.config ?? config, skills, conversations });
}

test("a never-used skill is archived after exactly L* exposures and D_min idle", () => {
	expect(decide(roots(L - 1))[0]).toMatchObject({ action: "none", run: L - 1, exposures: L - 1, state: "stale" });
	expect(decide(roots(L))[0]).toMatchObject({ action: "archive", run: L, uses: 0 });
	// The idle bound: enough exposures but activated recently.
	const recent = roots(L, { createdAt: NOW - DAY });
	expect(decide(recent, [skill({ activatedAt: NOW - 14 * DAY + 1 })])[0]).toMatchObject({ action: "none", run: L, state: "stale" });
	expect(decide(recent, [skill({ activatedAt: NOW - 14 * DAY })])[0]?.action).toBe("archive");
});

test("an idle deployment never archives: no exposure, no archive", () => {
	const [result] = decide([], [skill({ activatedAt: 0 })], { now: 10_000 * DAY });
	expect(result).toMatchObject({ action: "none", run: 0, exposures: 0, state: "stale" });
});

test("a use by a child conversation resets the run at its root", () => {
	const before = roots(L);
	const used = root();
	const child: CurationConversationFacts = { id: nextId++, up: used.id, root: false, createdAt: DAY, excluded: false, pin: { generation: 2, skills: ["s"] }, uses: { s: { lastAt: DAY } } };
	const grandchild: CurationConversationFacts = { ...child, id: nextId++, up: child.id, uses: {} };
	const after = roots(3);
	const [result] = decide([...before, used, child, grandchild, ...after]);
	expect(result).toMatchObject({ action: "none", run: 3, uses: 1, exposures: L + 4 });
	// Then the idle clock counts from the last use.
	expect(result?.idleMs).toBe(NOW - DAY);
	// The same use attributed nowhere (orphan child) does not reset the run.
	const [orphan] = decide([...before, used, { ...child, up: 999_999 }, ...after]);
	expect(orphan?.run).toBe(L + 4);
});

test("worker conversations are neither exposures nor uses", () => {
	const workers = roots(L, { excluded: true });
	expect(decide(workers)[0]).toMatchObject({ exposures: 0, action: "none" });
	const base = roots(L);
	const worker = root({ excluded: true, uses: { s: { lastAt: NOW } } });
	expect(decide([...base, worker])[0]).toMatchObject({ exposures: L, run: L, action: "archive" });
});

test("settle window excludes young roots; unknown creation time counts as settled", () => {
	const settled = roots(L - 1);
	expect(decide([...settled, root({ createdAt: NOW - config.settleMs + 1 })])[0]?.action).toBe("none");
	expect(decide([...settled, root({ createdAt: NOW - config.settleMs })])[0]?.action).toBe("archive");
	expect(decide([...settled, root({ createdAt: null })])[0]?.action).toBe("archive");
});

test("activation after edit or restore resets exposure counting", () => {
	const old = roots(L, { pin: { generation: 2, skills: ["s"] } });
	// Activation generation moved to 5: roots pinned earlier are not exposures.
	expect(decide(old, [skill({ activationGeneration: 5 })])[0]).toMatchObject({ exposures: 0, action: "none" });
	// Roots created before activatedAt (e.g. reset by unpin) are not exposures either.
	expect(decide(old, [skill({ activatedAt: DAY + 1 })])[0]).toMatchObject({ exposures: 0 });
	// A root whose pin lacks the skill is not an exposure.
	expect(decide(roots(L, { pin: { generation: 9, skills: ["other"] } }))[0]).toMatchObject({ exposures: 0 });
	expect(decide(roots(L, { pin: null }))[0]).toMatchObject({ exposures: 0 });
	// Non-root (owned) conversations are never exposures.
	expect(decide(roots(L, { root: false }))[0]).toMatchObject({ exposures: 0 });
});

test("pinned, protected-by-provenance and inactive skills are exempt", () => {
	const conversations = roots(L);
	const results = decide(conversations, [
		skill({ name: "s", pinned: true }),
		skill({ name: "s", provenance: "bundled" }),
		skill({ name: "s", provenance: "user" }),
		skill({ name: "s", active: false }),
		skill({ name: "s", provenance: "review" }),
		skill({ name: "s", provenance: "evolution" }),
	]);
	expect(results.map(item => item.action)).toEqual(["exempt", "exempt", "exempt", "archived", "archive", "archive"]);
	expect(results[0]?.reason).toBe("pinned");
	expect(results[3]?.state).toBe("archived");
	const opted = decide(conversations, [skill({ provenance: "bundled" }), skill({ provenance: "user" })], { config: { ...config, includeBundled: true, includeUser: true } });
	expect(opted.map(item => item.action)).toEqual(["archive", "archive"]);
});

test("manifest accepts an optional curation block and rejects invalid values", async () => {
	const { parseManifest } = await import("../src/manifest.ts");
	const base = { bot: { enabled: false, dataDir: "/tmp/x", model: { provider: "p", modelId: "m" }, toolMode: "direct" }, channels: {}, plugins: {} };
	const catalogs = { channels: {}, plugins: {} };
	expect((await parseManifest(base, catalogs)).curation).toBeUndefined();
	expect((await parseManifest({ ...base, curation: { enabled: false, pMax: 0.05 } }, catalogs)).curation).toEqual({ enabled: false, pMax: 0.05 });
	await expect(parseManifest({ ...base, curation: { alpha: 1 } }, catalogs)).rejects.toThrow("alpha");
	await expect(parseManifest({ ...base, curation: { unknown: true } }, catalogs)).rejects.toThrow();
});
