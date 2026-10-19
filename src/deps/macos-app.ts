import { constants } from "node:fs";
import { access, lstat, readFile, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { DependencyArtifact, ExternalDependency } from "../plugins/types.ts";
import { run } from "./run.ts";

/**
 * macOS app-bundle dependencies (ADR 0071). The OS keys Accessibility and Screen Recording grants on the signed
 * bundle identity, and drivers such as cua-driver relaunch their daemon through LaunchServices from the fixed
 * `/Applications/<Name>.app` path, so such a dependency is installed there instead of under the dependencies root.
 */
export const APPLICATIONS = "/Applications";
type MacosApp = NonNullable<DependencyArtifact["macosApp"]>;

const CODESIGN = "/usr/bin/codesign";
const DITTO = "/usr/bin/ditto";
const PKILL = "/usr/bin/pkill";
const TCCUTIL = "/usr/bin/tccutil";
const LSREGISTER = "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";
/** Privacy services the installer clears when a replacement no longer satisfies the previous app's requirement. */
const TCC_SERVICES = ["Accessibility", "ScreenCapture"];
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;

export function macosAppProblems(id: string, platform: string, artifact: DependencyArtifact): string[] {
	const app = artifact.macosApp;
	if (!app) return [];
	const problems: string[] = [];
	if (!app.bundle.endsWith(".app") || basename(app.bundle) === ".app") problems.push(`${id} ${platform}: macosApp.bundle must name a .app directory`);
	if (!artifact.entry.startsWith(`${app.bundle}/`)) problems.push(`${id} ${platform}: entry must lie inside macosApp.bundle`);
	if (!BUNDLE_ID.test(app.bundleId)) problems.push(`${id} ${platform}: macosApp.bundleId must be a reverse-DNS identifier`);
	if (!TEAM_ID.test(app.teamId)) problems.push(`${id} ${platform}: macosApp.teamId must be a 10-character Apple team id`);
	return problems;
}

/** Where the bundle is installed and the executable inside it. */
export function macosAppPaths(artifact: DependencyArtifact & { macosApp: MacosApp }, applications: string): { app: string; executable: string } {
	const app = join(applications, basename(artifact.macosApp.bundle));
	return { app, executable: join(app, artifact.entry.slice(artifact.macosApp.bundle.length + 1)) };
}

/**
 * The installed executable when the bundle at its fixed path has the pinned identifier and version. Reads only
 * `Info.plist` and the entry's metadata; the signature is checked by `dinobot init`, not on every resolution.
 */
export async function resolveMacosApp(
	dependency: ExternalDependency,
	artifact: DependencyArtifact & { macosApp: MacosApp },
	applications: string,
): Promise<string | undefined> {
	const { app, executable } = macosAppPaths(artifact, applications);
	const info = await readFile(join(app, "Contents", "Info.plist"), "utf8").catch(() => undefined);
	if (!info || plistString(info, "CFBundleIdentifier") !== artifact.macosApp.bundleId) return undefined;
	if (plistString(info, "CFBundleShortVersionString") !== dependency.version) return undefined;
	try {
		if (!(await lstat(executable)).isFile()) return undefined;
		await access(executable, constants.X_OK);
	} catch {
		return undefined;
	}
	return executable;
}

/** A top-level `<key>` string value of an XML property list. Binary plists yield undefined (treated as not installed). */
function plistString(xml: string, key: string): string | undefined {
	return new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(xml)?.[1];
}

/** Developer ID requirement for the pinned signer: Apple-anchored, this bundle id, this team. */
function pinnedRequirement(app: MacosApp): string {
	return `anchor apple generic and identifier "${app.bundleId}" and certificate leaf[subject.OU] = "${app.teamId}"`;
}

/** Exit 0 satisfied, 3 a valid signature that fails the requirement, anything else could not be evaluated. */
async function testRequirement(path: string, requirement: string, signal?: AbortSignal): Promise<"satisfied" | "unsatisfied" | "unknown"> {
	const result = await run([CODESIGN, "--verify", "--deep", "--strict", "-R", `=${requirement}`, path], { timeoutMs: 120_000, ...(signal ? { signal } : {}) })
		.catch(() => undefined);
	if (result?.code === 0) return "satisfied";
	return result?.code === 3 ? "unsatisfied" : "unknown";
}

/** Throws unless `path` is a valid, strictly verified bundle signed by the pinned team with the pinned id. */
export async function verifyMacosApp(path: string, app: MacosApp, signal?: AbortSignal): Promise<void> {
	if ((await testRequirement(path, pinnedRequirement(app), signal)) !== "satisfied") {
		throw new Error(`${basename(path)} is not a valid ${app.bundleId} bundle signed by team ${app.teamId}`);
	}
}

/** The designated requirement of a valid existing bundle, which macOS stored with its privacy grants. */
async function designatedRequirement(path: string, signal?: AbortSignal): Promise<string | undefined> {
	const result = await run([CODESIGN, "-d", "-r-", path], { timeoutMs: 60_000, ...(signal ? { signal } : {}) }).catch(() => undefined);
	if (result?.code !== 0) return undefined;
	return /^#?\s*designated => (.+)$/m.exec(result.stdout)?.[1]?.trim();
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace `<applications>/<Name>.app` with the verified staged bundle. Stops driver processes running from the old
 * bundle first, keeps the old bundle as a backup until the copy verifies and registers with LaunchServices, and
 * restores it on any failure. When the new bundle no longer satisfies the old one's designated requirement, the
 * old privacy grants would silently stop applying, so they are reset and must be granted again.
 */
export async function installMacosApp(
	staged: string,
	artifact: DependencyArtifact & { macosApp: MacosApp },
	options: { applications: string; signal?: AbortSignal; log?: (line: string) => void },
): Promise<string> {
	const { macosApp } = artifact;
	const { app, executable } = macosAppPaths(artifact, options.applications);
	const signal = options.signal;
	await verifyMacosApp(staged, macosApp, signal);
	try {
		await access(options.applications, constants.W_OK);
	} catch {
		throw new Error(`cannot write ${options.applications}; run \`dinobot init\` from an administrator account`);
	}

	const existing = await lstat(app).then(() => true, () => false);
	let previous: "satisfied" | "unsatisfied" | "unknown" = "unknown";
	if (existing) {
		const requirement = (await testRequirement(app, `identifier "${macosApp.bundleId}"`, signal)) === "satisfied"
			? await designatedRequirement(app, signal)
			: undefined;
		if (requirement) previous = await testRequirement(staged, requirement, signal);
		options.log?.(`replacing ${app}`);
		// A daemon left running from the old bundle would keep serving the old version.
		await run([PKILL, "-f", `^${escapeRegex(app)}/Contents/MacOS/`], { timeoutMs: 10_000, ...(signal ? { signal } : {}) }).catch(() => undefined);
	}

	const backup = `${app}.dinobot-backup-${process.pid}`;
	if (existing) await rename(app, backup);
	const restore = async () => {
		await rm(app, { recursive: true, force: true });
		if (existing) {
			await rename(backup, app);
			await run([LSREGISTER, "-f", app], { timeoutMs: 60_000 }).catch(() => undefined);
		}
	};
	try {
		const copied = await run([DITTO, staged, app], { timeoutMs: 300_000, ...(signal ? { signal } : {}) });
		if (copied.code !== 0) throw new Error(`cannot copy ${basename(app)}: ${copied.stderr.trim().slice(0, 300)}`);
		await verifyMacosApp(app, macosApp, signal);
		const registered = await run([LSREGISTER, "-f", app], { timeoutMs: 60_000, ...(signal ? { signal } : {}) });
		if (registered.code !== 0) throw new Error(`cannot register ${basename(app)} with LaunchServices: ${registered.stderr.trim().slice(0, 300)}`);
	} catch (error) {
		await restore().catch(() => {});
		throw error;
	}
	if (existing) await rm(backup, { recursive: true, force: true }).catch(() => {});

	if (previous === "unsatisfied") {
		const failed: string[] = [];
		for (const service of TCC_SERVICES) {
			const reset = await run([TCCUTIL, "reset", service, macosApp.bundleId], { timeoutMs: 30_000 }).catch(() => undefined);
			if (reset?.code !== 0) failed.push(service);
		}
		if (failed.length > 0) {
			throw new Error(`installed ${app}, but its signer changed and these permissions could not be reset: ${failed.join(", ")}; run \`tccutil reset <service> ${macosApp.bundleId}\``);
		}
		options.log?.("the app's signer changed; its Accessibility and Screen Recording permissions were reset");
	}
	return executable;
}
