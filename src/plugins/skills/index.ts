import { lstat, readdir, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { SkillPackage } from "../../core/skills/store.ts";
import { definePlugin, loadPlugin, type LoadedPlugin } from "../types.ts";
import { bundledSkills } from "./bundled.ts";
import { proofSkills } from "./proof-skills/index.ts";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_PACKAGE_BYTES = 1024 * 1024;

function parseSkill(path: string, dirName: string, text: string): Pick<SkillPackage, "name" | "description" | "body"> {
	const match = FRONTMATTER.exec(text);
	if (!match) throw new Error(`${path}: must start with YAML frontmatter between --- lines`);
	const meta: unknown = Bun.YAML.parse(match[1]!);
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) throw new Error(`${path}: frontmatter must be a YAML mapping`);
	const { name, description, compatibility, metadata } = meta as Record<string, unknown>;
	if (typeof name !== "string" || name.length < 1 || name.length > 64) throw new Error(`${path}: name is required and must be 1-64 characters`);
	if (!NAME.test(name)) throw new Error(`${path}: name must use lowercase a-z, digits and hyphens, without leading, trailing or consecutive hyphens`);
	if (name !== dirName) throw new Error(`${path}: name must equal its directory name`);
	if (typeof description !== "string" || !description.trim() || description.length > 1024) throw new Error(`${path}: description is required and must be 1-1024 characters`);
	if (compatibility !== undefined && (typeof compatibility !== "string" || compatibility.length > 500)) throw new Error(`${path}: compatibility must be a string of at most 500 characters`);
	if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata) || Object.values(metadata).some((value) => typeof value !== "string"))) throw new Error(`${path}: metadata must be a map of strings`);
	const body = match[2]!.trim();
	if (!body) throw new Error(`${path}: skill body must not be empty`);
	return { name, description, body };
}

/** Read-only import: reject links, special files, invalid UTF-8 and oversized trees. */
async function readPackage(root: string): Promise<Record<string, string>> {
	const entries: [string, string][] = [];
	let bytes = 0;
	async function walk(relative: string): Promise<void> {
		for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.includes("\\") || entry.name.includes(":")) throw new Error("Skill paths must be portable relative paths");
			const path = relative ? `${relative}/${entry.name}` : entry.name;
			const full = join(root, path);
			const info = await lstat(full);
			if (info.isSymbolicLink()) throw new Error(`Skill source symlink is not allowed: ${path}`);
			if (!(await realpath(full)).startsWith(root + sep)) throw new Error(`Skill path is outside the skill directory: ${path}`);
			if (info.isDirectory()) { await walk(path); continue; }
			if (!info.isFile()) throw new Error(`Skill source must contain regular files: ${path}`);
			if (info.size > MAX_FILE_BYTES) throw new Error(`Skill file exceeds 256 KiB: ${path}`);
			if (entries.length >= 129 || bytes + info.size > MAX_PACKAGE_BYTES) throw new Error("Skill package exceeds 128 companion files or 1 MiB");
			const data = await Bun.file(full).bytes();
			bytes += data.byteLength;
			if (data.byteLength > MAX_FILE_BYTES || bytes > MAX_PACKAGE_BYTES) throw new Error("Skill package grew beyond size limits while importing");
			entries.push([path, new TextDecoder("utf-8", { fatal: true }).decode(data)]);
		}
	}
	await walk("");
	return Object.fromEntries(entries);
}

/** Configuration/source importer only. The harness owns all versioned skills_* tools. */
export const skillsPlugin = definePlugin({
	id: "skills",
	config: Type.Object({
		dirs: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		/** Opt-in bundled formal verification skills (opum-ai/proof-skills): their catalog lines and ~230 KB of companion files would otherwise burden every deployment. */
		proofSkills: Type.Optional(Type.Boolean()),
	}),
	load: async ({ dirs = [], proofSkills: proof = false }) => {
		const skills = new Map<string, SkillPackage>([...bundledSkills, ...(proof ? proofSkills : [])].map((skill) => [skill.name, { files: {}, ...skill, source: `bundled:${skill.name}` }]));
		const errors: string[] = [];
		for (const parent of dirs) {
			for (const entry of await readdir(parent, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const root = await realpath(join(parent, entry.name));
				const path = join(root, "SKILL.md");
				if (!(await Bun.file(path).exists())) continue;
				try {
					const files = await readPackage(root);
					if (JSON.stringify(files) !== JSON.stringify(await readPackage(root))) throw new Error("Skill source changed during import; retry with a stable source");
					const originalSkillMd = files["SKILL.md"]!;
					const parsed = parseSkill(path, entry.name, originalSkillMd);
					if (skills.has(parsed.name)) throw new Error(`duplicate skill name "${parsed.name}" (also in ${skills.get(parsed.name)!.source})`);
					delete files["SKILL.md"];
					skills.set(parsed.name, { ...parsed, files, originalSkillMd, source: `external:${root}` });
				} catch (error) {
					errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
		if (errors.length) throw new Error(`invalid skills:\n${errors.join("\n")}`);
		return {
			tools: [],
			catalog: [...skills.values()].map(({ name, description }) => ({ name, description })),
			skillPackages: [...skills.values()],
		};
	},
});

export async function withDefaultSkills(plugins: readonly LoadedPlugin[]): Promise<readonly LoadedPlugin[]> {
	if (plugins.some((plugin) => plugin.id === skillsPlugin.id)) return plugins;
	const skills = await loadPlugin(skillsPlugin, {});
	if (Array.isArray(skills)) throw new Error(skills.join("\n"));
	return [...plugins, skills];
}
