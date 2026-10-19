import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Progress of the first-run setup wizard, kept in `<dataDir>/setup.json`. */
export type SetupState = { readonly startedAt?: string; readonly completedAt?: string };

const FILE = "setup.json";

/** Missing, unreadable or invalid files read as `{}`; fields that are not strings are dropped. */
export async function readSetupState(dataDir: string): Promise<SetupState> {
	let raw: unknown;
	try { raw = JSON.parse(await readFile(join(dataDir, FILE), "utf8")); }
	catch { return {}; }
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const record = raw as Record<string, unknown>;
	return {
		...(typeof record.startedAt === "string" ? { startedAt: record.startedAt } : {}),
		...(typeof record.completedAt === "string" ? { completedAt: record.completedAt } : {}),
	};
}

/** Atomic: a temporary file in the same directory (mode 0600) renamed over `setup.json`. */
export async function writeSetupState(dataDir: string, state: SetupState): Promise<void> {
	await mkdir(dataDir, { recursive: true });
	const target = join(dataDir, FILE);
	const temporary = join(dataDir, `.${FILE}.${process.pid}.${randomUUID()}.tmp`);
	const body = {
		...(state.startedAt !== undefined ? { startedAt: state.startedAt } : {}),
		...(state.completedAt !== undefined ? { completedAt: state.completedAt } : {}),
	};
	try {
		await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		await rename(temporary, target);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}
