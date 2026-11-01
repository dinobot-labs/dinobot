/**
 * Pages plugin (BRIEF 10): renders the root HTML entries from src/pages/*.html and the locale dictionaries
 * src/content/{en,ko}.ts, writes them to the project root (gitignored) at config time, and registers them as
 * `environments.client.build.rollupOptions.input`. The top-level `build.rollupOptions.input` is never touched:
 * it would leak into the Worker build.
 *
 * Routes: ROUTES (vite/routes.ts) maps a template name to its output file per locale. Any other src/pages/<name>.html
 * becomes <name>/index.html (en) and ko/<name>/index.html (ko). Files starting with "_" and src/pages/partials/
 * are not pages. Until the page node adds src/pages/home.html, a minimal placeholder keeps / and /ko/ building.
 *
 * Template data: the locale dictionary plus `$`:
 *   $.lang      "en" | "ko"
 *   $.path      URL path of this page ("/", "/ko/privacy/", "/404")
 *   $.page      template name without .html ("home")
 *   $.alt.en / $.alt.ko   URL path of the same page in each locale that the page has
 *   $.other.lang / $.other.path   the other locale of this page (only when the page exists in both)
 *   $.site      production origin ("https://www.dinobot.workers.dev"); $.url = $.site + $.path
 * Syntax: vite/template.ts. Missing keys fail the build.
 *
 * Vite bundles every <link href> in an HTML entry, so a page link such as <link rel="alternate" href="/ko/">
 * would fail the build (EISDIR). Rendered pages therefore get `vite-ignore` on <link> tags whose rel only names
 * pages (alternate, canonical, ...); Vite strips the attribute from the output.
 *
 * Dev: edits under src/pages or src/content regenerate the entries (and the Korean font subset, vite/fonts.ts)
 * and trigger a full reload. Preview mode does nothing.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runnerImport, type Plugin, type ViteDevServer } from "vite";
import { ensureKoreanSubset } from "./fonts.ts";
import { DEFAULT_SITE, type Locale, LOCALES, type Outputs, ROUTES, urlOf } from "./routes.ts";
import { renderTemplate, TemplateError } from "./template.ts";

export { DEFAULT_SITE, LOCALES, type Locale, type Outputs, ROUTES, urlOf } from "./routes.ts";

const defaultOutputs = (name: string): Outputs => ({ en: `${name}/index.html`, ko: `ko/${name}/index.html` });

/** <link rel> values that point at pages, not assets: Vite must not try to bundle their href. */
const PAGE_LINK_RELS = /^(?:alternate|canonical|prev|next|author|help|license|search|privacy-policy|terms-of-service|me)$/i;

/** Adds `vite-ignore` to <link> tags whose rel names a page (see the header comment). */
export function protectPageLinks(html: string): string {
	return html.replace(/<link\b[^>]*>/gi, (tag) => {
		if (/\svite-ignore\b/i.test(tag)) return tag;
		const rel = /\srel\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
		const rels = (rel?.[2] ?? rel?.[3] ?? rel?.[4] ?? "").split(/\s+/).filter(Boolean);
		if (!rels.length || !rels.every((r) => PAGE_LINK_RELS.test(r))) return tag;
		return tag.replace(/\s*(\/?)>$/, (_m, slash: string) => ` vite-ignore${slash ? " /" : ""}>`);
	});
}

/** Used only while src/pages/home.html does not exist yet (the page node owns it). */
const PLACEHOLDER_HOME = `<!doctype html>
<html lang="{{$.lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{#if meta.title}}{{meta.title}}{{else}}dinobot{{/if}}</title>
{{#if $.alt.en}}<link rel="alternate" hreflang="en" href="{{$.alt.en}}">{{/if}}
{{#if $.alt.ko}}<link rel="alternate" hreflang="ko" href="{{$.alt.ko}}">{{/if}}
</head>
<body>
<main><h1>{{#if hero.title}}{{hero.title}}{{else}}dinobot{{/if}}</h1></main>
<script type="module" src="/src/client/main.ts"></script>
</body>
</html>
`;

export interface GeneratedPage {
	template: string;
	locale: Locale;
	/** Output path relative to the root, with forward slashes. */
	file: string;
	url: string;
	placeholder: boolean;
}

export interface Generation {
	pages: GeneratedPage[];
	/** Rollup input map: entry name -> absolute HTML path. */
	inputs: Record<string, string>;
	/** Files the generation read (templates, partials, dictionaries and their imports). */
	dependencies: string[];
	written: number;
}

const posix = (p: string) => p.split(sep).join("/");

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadDictionary(root: string, locale: Locale): Promise<{ dict: Record<string, unknown>; deps: string[] }> {
	const file = join(root, "src", "content", `${locale}.ts`);
	if (!existsSync(file)) return { dict: {}, deps: [] };
	const { module, dependencies } = await runnerImport<Record<string, unknown>>(file, { root, logLevel: "silent" });
	const dict = module[locale] ?? module.default;
	if (!isPlainObject(dict)) throw new TemplateError(`src/content/${locale}.ts must export \`${locale}\` (or a default export) as an object`);
	return { dict, deps: [file, ...dependencies.filter((d): d is string => typeof d === "string")] };
}

function readPartial(root: string, name: string): string | undefined {
	const file = join(root, "src", "pages", "partials", `${name}.html`);
	return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/** Renders every page and writes the entry files that changed. */
export async function generatePages(root: string, site: string = DEFAULT_SITE): Promise<Generation> {
	const pagesDir = join(root, "src", "pages");
	const templates = existsSync(pagesDir)
		? readdirSync(pagesDir, { withFileTypes: true })
				.filter((e) => e.isFile() && e.name.endsWith(".html") && !e.name.startsWith("_"))
				.map((e) => e.name)
				.sort()
		: [];
	const plan = templates.map((file) => {
		const name = file.slice(0, -".html".length);
		return { name, file, source: readFileSync(join(pagesDir, file), "utf8"), outputs: ROUTES[name] ?? defaultOutputs(name), placeholder: false };
	});
	if (!templates.includes("home.html")) plan.unshift({ name: "home", file: "home.html", source: PLACEHOLDER_HOME, outputs: ROUTES.home ?? {}, placeholder: true });

	const dicts = {} as Record<Locale, Record<string, unknown>>;
	const dependencies = new Set<string>(templates.map((t) => join(pagesDir, t)));
	for (const locale of LOCALES) {
		const { dict, deps } = await loadDictionary(root, locale);
		dicts[locale] = dict;
		for (const d of deps) dependencies.add(d);
	}

	const seen = new Map<string, string>();
	const pages: GeneratedPage[] = [];
	const inputs: Record<string, string> = {};
	let written = 0;
	for (const page of plan) {
		const locales = LOCALES.filter((l) => page.outputs[l]);
		const alt = Object.fromEntries(locales.map((l) => [l, urlOf(page.outputs[l] as string)]));
		for (const locale of locales) {
			const file = page.outputs[locale] as string;
			const owner = seen.get(file);
			if (owner) throw new TemplateError(`${page.file} (${locale}) and ${owner} both write ${file}`);
			seen.set(file, `${page.file} (${locale})`);
			const url = urlOf(file);
			const other = locales.find((l) => l !== locale);
			const $ = { lang: locale, path: url, site, url: site + url, page: page.name, alt, ...(other ? { other: { lang: other, path: alt[other] } } : {}) };
			const rendered = renderTemplate(page.source, { ...dicts[locale], $ }, { name: page.file, locale, partial: (n) => readPartial(root, n) });
			const html = protectPageLinks(rendered.html);
			const partials = rendered.partials;
			for (const p of partials) dependencies.add(join(pagesDir, "partials", `${p}.html`));
			const abs = join(root, file);
			if (!existsSync(abs) || readFileSync(abs, "utf8") !== html) {
				mkdirSync(dirname(abs), { recursive: true });
				writeFileSync(abs, html);
				written++;
			}
			inputs[`${page.name}.${locale}`] = abs;
			pages.push({ template: page.file, locale, file: posix(file), url, placeholder: page.placeholder });
		}
	}
	return { pages, inputs, dependencies: [...dependencies], written };
}

function isInside(file: string, dir: string): boolean {
	const rel = relative(dir, file);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function sendReload(server: ViteDevServer, payload: { type: "full-reload"; path: string } | { type: "error"; err: { message: string; stack: string } }) {
	const hot = (server.environments?.client?.hot ?? server.hot) as { send(p: unknown): void } | undefined;
	hot?.send(payload);
}

export interface PagesOptions {
	/** Project root (services/landing). Defaults to Vite's root. */
	root?: string;
	/** Production origin for $.site and $.url (default DEFAULT_SITE). */
	site?: string;
	/** Subset the Korean font as part of generation (default true). */
	fonts?: boolean;
}

/**
 * One generation per build process: `vite build` resolves (and re-bundles) the config more than once, so the cache
 * lives on globalThis rather than in this module instance.
 */
const buildRuns: Map<string, Promise<Generation>> = ((globalThis as { __dinobotPagesBuildRuns?: Map<string, Promise<Generation>> }).__dinobotPagesBuildRuns ??= new Map());

export function pages(options: PagesOptions = {}): Plugin {
	let root = options.root ?? process.cwd();
	const fonts = options.fonts ?? true;
	const site = (options.site ?? DEFAULT_SITE).replace(/\/+$/, "");
	const run = async () => {
		const generation = await generatePages(root, site);
		if (fonts) await ensureKoreanSubset(root, { info: (m) => console.log(m), warn: (m) => console.warn(m) });
		const list = generation.pages.map((p) => p.url + (p.placeholder ? " (placeholder)" : "")).join(", ");
		console.log(`pages: ${generation.pages.length} entries (${generation.written} written): ${list}`);
		return generation;
	};
	return {
		name: "dinobot:pages",
		async config(config, env) {
			if (env.isPreview) return;
			root = resolve(options.root ?? config.root ?? process.cwd());
			let generation: Promise<Generation>;
			if (env.command === "build") {
				generation = buildRuns.get(root) ?? run();
				buildRuns.set(root, generation);
			} else generation = run();
			return { environments: { client: { build: { rollupOptions: { input: (await generation).inputs } } } } };
		},
		configureServer(server) {
			const watched = [join(root, "src", "pages"), join(root, "src", "content")];
			server.watcher.add(watched);
			let timer: ReturnType<typeof setTimeout> | undefined;
			let queue = Promise.resolve();
			const regenerate = () => {
				queue = queue.then(async () => {
					try {
						const generation = await generatePages(root, site);
						if (fonts) await ensureKoreanSubset(root, server.config.logger);
						server.config.logger.info(`pages: regenerated ${generation.pages.length} entries (${generation.written} changed)`, { timestamp: true });
						sendReload(server, { type: "full-reload", path: "*" });
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						server.config.logger.error(`pages: ${err.message}`, { timestamp: true });
						sendReload(server, { type: "error", err: { message: `pages: ${err.message}`, stack: err.stack ?? "" } });
					}
				});
			};
			const onFile = (file: string) => {
				if (!watched.some((dir) => isInside(file, dir))) return;
				clearTimeout(timer);
				timer = setTimeout(regenerate, 60);
			};
			server.watcher.on("add", onFile);
			server.watcher.on("change", onFile);
			server.watcher.on("unlink", onFile);
		},
	};
}
