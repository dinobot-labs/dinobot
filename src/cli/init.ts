import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { catalogDependencies, dependenciesRoot, installDependency, platformKey, resolveInstalled } from "../deps/index.ts";
import type { Plugin } from "../plugins/types.ts";
import { ensureDefaultManifest } from "./default-manifest.ts";

export const INIT_USAGE = `Usage: dinobot init [--check] [--config <path>] [<dependency>...]

Install the external programs dinobot's plugins run (pinned versions, checksum-verified) under
$DINOBOT_DEPS_DIR or ~/.local/share/dinobot/deps (signed macOS app bundles go to /Applications), and create
the default manifest when none exists.
Safe to run again: verified installs are kept, missing or outdated ones are installed.

  --check        report what is installed without downloading anything
  <dependency>   limit to these ids; an unsupported platform is then an error`;

export type InitOptions = {
	readonly catalog: Readonly<Record<string, Plugin>>;
	readonly root?: string;
	readonly platform?: string;
	/** Where macOS app-bundle dependencies are installed. Default `/Applications`. */
	readonly applications?: string;
	readonly fetch?: typeof fetch;
	readonly home?: string;
	readonly env?: Record<string, string | undefined>;
	readonly out?: (line: string) => void;
	readonly err?: (line: string) => void;
	readonly signal?: AbortSignal;
};

/** `dinobot init`. Returns the process exit code: 0 ok, 1 a failed or (with --check) missing dependency, 2 usage. */
export async function runInit(argv: readonly string[], options: InitOptions): Promise<number> {
	const out = options.out ?? ((line: string) => console.log(line));
	const err = options.err ?? ((line: string) => console.error(line));
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (error) {
		err(`dinobot init: ${error instanceof Error ? error.message : String(error)}\n\n${INIT_USAGE}`);
		return 2;
	}
	if (parsed.values.help) {
		out(INIT_USAGE);
		return 0;
	}
	let entries: ReturnType<typeof catalogDependencies>;
	try {
		entries = catalogDependencies(options.catalog);
	} catch (error) {
		err(`dinobot init: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	const requested = parsed.positionals;
	const unknown = requested.filter((id) => !entries.some(({ dependency }) => dependency.id === id));
	if (unknown.length > 0) {
		err(`dinobot init: unknown dependency ${unknown.join(", ")} (available: ${entries.map(({ dependency }) => dependency.id).join(", ") || "none"})`);
		return 2;
	}
	const selected = requested.length > 0 ? entries.filter(({ dependency }) => requested.includes(dependency.id)) : entries;
	const env = options.env ?? process.env;
	const home = options.home ?? homedir();
	const root = options.root ?? dependenciesRoot(env, home);
	const platform = options.platform ?? platformKey();
	const check = parsed.values.check === true;
	const applications = options.applications ? { applications: options.applications } : {};

	const manifestPath = await manifest(parsed.values.config ?? env.DINOBOT_CONFIG, home, check, out);
	const enabled = manifestPath ? await enabledPlugins(manifestPath) : new Set<string>();
	out(`dependencies: ${root} (${platform})`);

	let failed = false;
	for (const { dependency, plugins } of selected) {
		const label = `${dependency.id} ${dependency.version}`;
		if (!dependency.artifacts[platform]) {
			out(`  ${label}: not available for ${platform}${dependency.manualInstall ? `; ${dependency.manualInstall}` : ""}`);
			if (requested.includes(dependency.id)) failed = true;
			continue;
		}
		if (check) {
			const path = await resolveInstalled(dependency, { root, platform, ...applications });
			out(path ? `  ${label}: installed ${path}` : `  ${label}: missing; run \`dinobot init\``);
			if (!path) failed = true;
		} else {
			const outcome = await installDependency(dependency, {
				root, platform, ...applications,
				...(options.fetch ? { fetch: options.fetch } : {}),
				...(options.signal ? { signal: options.signal } : {}),
				log: (line) => out(`  ${line}`),
			});
			if (outcome.status === "installed") {
				out(`  ${label}: installed ${outcome.path}`);
				const grant = dependency.artifacts[platform]?.macosApp?.permissionArgs;
				if (grant) out(`  grant its macOS permissions once: ${[outcome.path, ...grant].join(" ")}`);
			}
			else if (outcome.status === "present") out(`  ${label}: already installed ${outcome.path}`);
			else if (outcome.status === "failed") {
				err(`  ${label}: failed: ${outcome.error}`);
				failed = true;
				continue;
			}
		}
		const disabled = plugins.filter((id) => !enabled.has(id));
		if (disabled.length > 0 && manifestPath) {
			out(`  used by plugin ${disabled.join(", ")}: add \`${disabled.map((id) => `${id}: {}`).join(", ")}\` under \`plugins:\` in ${manifestPath} to enable it`);
		}
	}
	if (selected.length === 0) out("  nothing to install");
	return failed ? 1 : 0;
}

function parse(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		allowPositionals: true,
		options: { check: { type: "boolean" }, config: { type: "string", short: "c" }, help: { type: "boolean", short: "h" } },
	});
}

/** The manifest the daemon would read; bootstrap creates the default one unless only checking. */
async function manifest(explicit: string | undefined, home: string, check: boolean, out: (line: string) => void): Promise<string | undefined> {
	if (explicit !== undefined) return explicit;
	if (existsSync("dinobot.yaml")) return "dinobot.yaml";
	if (check) {
		const { defaultManifestPath } = await import("./default-manifest.ts");
		const path = defaultManifestPath(home);
		return existsSync(path) ? path : undefined;
	}
	const { path, created } = await ensureDefaultManifest(home);
	out(created ? `manifest: created ${path}; sign in to a model with /login in \`dinobot tui\`` : `manifest: ${path}`);
	return path;
}

/** Plugin ids the manifest turns on. Unreadable or invalid YAML counts as none; the daemon reports the real error. */
async function enabledPlugins(path: string): Promise<Set<string>> {
	try {
		const raw = Bun.YAML.parse(await readFile(path, "utf8")) as { plugins?: unknown };
		if (typeof raw?.plugins !== "object" || raw.plugins === null) return new Set();
		return new Set(Object.entries(raw.plugins as Record<string, unknown>).filter(([, value]) => value !== false).map(([id]) => id));
	} catch {
		return new Set();
	}
}
