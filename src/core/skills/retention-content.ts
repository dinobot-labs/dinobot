import { defineDoc, defineDocFamily, type Tx } from "@earendil-works/pi-durable";
import { skillEvaluationHash } from "./evaluation-contract.ts";
import { skillPackageHash } from "./manifests.ts";
import type { SkillPackage } from "./store.ts";
import { readSkillsState } from "./storage.ts";

/** Migration staging only: existing readers/writers still use SkillsDoc. */
export const RetainedSkillContentDoc = defineDocFamily<{ package: SkillPackage | null }, null>({
	kind: "dinobot.skill-retention.content", version: 1, scope: "session", family: true,
	initial: () => ({ package: null }),
});
export const SkillContentMigrationDoc = defineDoc<{ sourceDigest: string | null; packageCount: number; phase: "absent" | "staged" }>({
	kind: "dinobot.skill-retention.migration", version: 1, scope: "session",
	initial: () => ({ sourceDigest: null, packageCount: 0, phase: "absent" }),
});
export class SkillContentMigrationError extends Error {
	constructor(message: string) { super(message); this.name = "SkillContentMigrationError"; }
}
export function retainedPackageCopy(pkg: SkillPackage): SkillPackage {
	return {
		name: pkg.name, description: pkg.description, body: pkg.body, source: pkg.source,
		files: { ...pkg.files }, ...(pkg.originalSkillMd === undefined ? {} : { originalSkillMd: pkg.originalSkillMd }),
	};
}
/** Immutable bytes, including companion and original SKILL.md. No source mutations. */
export async function stageSkillContentMigration(tx: Tx, admit: (tx: Tx, additionalBytes: number) => Promise<void>): Promise<{ readonly sourceDigest: string; readonly packageCount: number; readonly phase: "staged" }> {
	const state = await readSkillsState(tx);
	const sourceDigest = skillEvaluationHash(JSON.parse(JSON.stringify(state)));
	const migration = await tx.doc(SkillContentMigrationDoc);
	if (migration.sourceDigest && migration.sourceDigest !== sourceDigest) throw new SkillContentMigrationError("Source changed after migration staging");
	await admit(tx, state.skills.reduce((sum, entry) => sum + entry.versions.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.package)), 0), 256));
	const hashes = new Set<string>();
	for (const entry of state.skills) {
		for (const item of entry.versions) {
			if (item.package.name !== entry.name || skillPackageHash(item.package) !== item.version) throw new SkillContentMigrationError("Corrupt source package");
			const content = await tx.doc(RetainedSkillContentDoc, item.version, null);
			if (content.package && skillPackageHash(content.package) !== item.version) throw new SkillContentMigrationError("Corrupt staged content");
			if (!content.package) content.package = retainedPackageCopy(item.package);
			hashes.add(item.version);
		}
	}
	migration.sourceDigest = sourceDigest;
	migration.packageCount = hashes.size;
	migration.phase = "staged";
	await verifySkillContentMigration(tx);
	return { sourceDigest, packageCount: hashes.size, phase: "staged" };
}
/** Verify the full metadata/receipt graph and byte-for-byte package roundtrip.
 * Parent must stop writes and implement BOTH reader and writer cutover before
 * removing source payloads. "staged" never means migration or privacy deletion done.
 */
export async function verifySkillContentMigration(tx: Tx): Promise<void> {
	const state = await readSkillsState(tx);
	const migration = await tx.doc(SkillContentMigrationDoc);
	if (migration.phase !== "staged" || migration.sourceDigest !== skillEvaluationHash(JSON.parse(JSON.stringify(state)))) throw new SkillContentMigrationError("Migration source/head/generation/receipt graph mismatch");
	const hashes = new Set<string>();
	for (const entry of state.skills) {
		for (const item of entry.versions) {
			const content = await tx.doc(RetainedSkillContentDoc, item.version, null);
			if (!content.package || skillPackageHash(content.package) !== item.version || skillEvaluationHash(content.package) !== skillEvaluationHash(item.package)) throw new SkillContentMigrationError("Content migration roundtrip mismatch");
			hashes.add(item.version);
		}
	}
	if (hashes.size !== migration.packageCount) throw new SkillContentMigrationError("Migration package count mismatch");
}
