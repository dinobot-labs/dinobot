import { createHash } from "node:crypto";

export const RELEASE_METADATA_URL = "https://releases.dinobot.workers.dev/core/latest.json";
const RELEASE_BASE = "https://releases.dinobot.workers.dev/core/releases/";
export type ReleaseMetadata = { name: "dinobot"; version: string; dist: { tarball: string; integrity: string } };

/** Exact equality forbids credentials, redirects, alternate origins, queries and path normalization tricks. */
export function validateReleaseMetadata(value: unknown, stable: (value: unknown) => boolean): ReleaseMetadata {
	if (!value || typeof value !== "object" || !("name" in value) || value.name !== "dinobot"
		|| !("version" in value) || typeof value.version !== "string" || !stable(value.version)
		|| !("dist" in value) || !value.dist || typeof value.dist !== "object") throw new Error("Invalid release metadata");
	const dist = value.dist;
	if (!("tarball" in dist) || dist.tarball !== RELEASE_BASE + value.version + "/dinobot-" + value.version + ".tgz"
		|| !("integrity" in dist) || typeof dist.integrity !== "string"
		|| !/^sha512-[A-Za-z0-9+/]{86}==$/.test(dist.integrity)
		|| "sha512-" + Buffer.from(dist.integrity.slice(7), "base64").toString("base64") !== dist.integrity) throw new Error("Invalid release distribution");
	return { name: "dinobot", version: value.version, dist: { tarball: dist.tarball, integrity: dist.integrity } };
}

/** Download and authenticate all bytes before any package-manager side effect. */
export async function downloadRelease(release: ReleaseMetadata, fetcher: typeof fetch): Promise<Buffer> {
	const controller = new AbortController();
	let rejectTimeout!: (reason: Error) => void;
	const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
	const timer = setTimeout(() => { controller.abort(); rejectTimeout(new Error("Release download timed out")); }, 120_000);
	try {
		return await Promise.race([timeout, (async () => {
			const response = await fetcher(release.dist.tarball, { redirect: "error", signal: controller.signal });
			if (!response.ok || response.redirected) throw new Error("Release download failed");
			const bytes = Buffer.from(await response.arrayBuffer());
			if ("sha512-" + createHash("sha512").update(bytes).digest("base64") !== release.dist.integrity) throw new Error("Release integrity mismatch");
			return bytes;
		})()]);
	} finally { clearTimeout(timer); }
}
