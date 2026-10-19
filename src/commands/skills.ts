import { withAbortSignal } from "@earendil-works/chord/context";
import { randomUUID } from "node:crypto";
import { SkillObservationDoc } from "../core/skills/observation.ts";
import { SkillObservationDriverDoc } from "../core/skills/observation-driver.ts";
import { EvolutionJobError } from "../core/skills/evolution-jobs.ts";
import type { Bot } from "../core/bot.ts";
import type { Context } from "@earendil-works/chord";
import type { CurationReport, SkillCurationStatus, SkillProvenance } from "../core/skills/curation.ts";
import type { CommandArgument, CommandChecklistPrompt, CommandIO, SlashCommand } from "./types.ts";

const USAGE = "[list | on <name> | off <name> | pending | diff <id> | history <name> | publish <id> | reject <id> | legacy | close-legacy <conversation> | evolution [status|pause|kill|resume] | curator [status|run|dry-run] | archived | archive <name> | restore <name> | pin <name> | unpin <name>]";
const DAY = 86_400_000;
const days = (ms: number) => `${(ms / DAY).toFixed(1)}d`;
const at = (ms: number | null) => ms === null ? "never" : new Date(ms).toISOString();

function renderReport(report: CurationReport): string[] {
	return [
		`Curator ${report.dryRun ? "dry run" : `run ${report.run}`} at ${at(report.at)}: archive after ${report.threshold} unused root exposures and ${days(report.minIdleMs)} idle (alpha ${report.alpha}, pMax ${report.pMax})`,
		...report.skills.map((skill) => `  ${skill.name}  ${skill.provenance}  ${skill.state}  run ${skill.run}/${report.threshold}  exposures ${skill.exposures}  uses ${skill.uses}  idle ${days(skill.idleMs)}  ${skill.action}${skill.reason ? ` (${skill.reason})` : ""}`),
	];
}
function renderStatus(status: SkillCurationStatus): string[] {
	const { config } = status;
	return [
		`Skill curator: ${config.enabled ? "enabled" : "disabled"} | archive after ${config.threshold} unused root exposures and ${days(config.minIdleMs)} idle | every ${(config.intervalMs / 3_600_000).toFixed(1)}h`,
		`Runs: ${status.runs} | last run ${at(status.lastRunAt)}`,
		...status.skills.map((skill) => `  ${skill.name}  ${skill.provenance}  ${skill.state}${skill.pinned ? "  pinned" : ""}${skill.lastRun ? `  exposures ${skill.lastRun.exposures}  uses ${skill.lastRun.uses}  idle ${days(skill.lastRun.idleMs)}` : ""}`),
		`Archived: ${status.archived.length ? status.archived.join(", ") : "none"}`,
	];
}

/** Catalog entry exactly as the default skill catalog exposes it to a model. */
export type CatalogEntry = { readonly name: string; readonly description: string; readonly generation: number; readonly version: string };
/**
 * Rough prompt cost of one catalog entry: its JSON form, ASCII at ~4 characters per token and every
 * non-ASCII character (Korean, CJK, emoji) as one token. Pure; an estimate, not a tokenizer.
 */
export function estimateCatalogTokens(entry: CatalogEntry): number {
	const text = JSON.stringify({ name: entry.name, description: entry.description, generation: entry.generation, version: entry.version });
	let ascii = 0;
	let other = 0;
	for (const char of text) {
		if (char.codePointAt(0)! < 128) ascii++;
		else other++;
	}
	return Math.ceil(ascii / 4) + other;
}

type SkillRow = {
	readonly name: string; readonly provenance: SkillProvenance; readonly enabled: boolean;
	/** Bundled skills are locked: always shown, never toggleable. */
	readonly locked: boolean; readonly tokens: number; readonly description: string;
};
const PROVENANCE_ORDER: readonly SkillProvenance[] = ["bundled", "agent", "review", "evolution", "user"];
const OWNER = "local-owner";

/** Current skills joined with their lifecycle and provenance: bundled first, then by name. */
async function skillRows(bot: Bot, context: Context): Promise<SkillRow[]> {
	const summaries = new Map((await bot.skills.list(context)).map((summary) => [summary.name, summary]));
	const rows: SkillRow[] = [];
	for (const skill of (await bot.curation.status(context)).skills) {
		const summary = summaries.get(skill.name);
		rows.push({
			name: skill.name, provenance: skill.provenance, enabled: skill.lifecycle === "active", locked: skill.provenance === "bundled",
			tokens: summary ? estimateCatalogTokens(summary) : 0, description: summary?.description ?? "",
		});
	}
	return rows.sort((a, b) => Number(b.locked) - Number(a.locked) || a.name.localeCompare(b.name));
}
function totals(rows: readonly SkillRow[]): { enabled: number; total: number; tokens: number } {
	const enabled = rows.filter((row) => row.enabled);
	return { enabled: enabled.length, total: rows.length, tokens: enabled.reduce((sum, row) => sum + row.tokens, 0) };
}
function shorten(text: string, limit = 60): string {
	const chars = [...text.replace(/\s+/g, " ").trim()];
	return chars.length <= limit ? chars.join("") : `${chars.slice(0, limit - 1).join("")}…`;
}
function renderList(rows: readonly SkillRow[]): string {
	if (rows.length === 0) return "no skills loaded";
	const sum = totals(rows);
	return [
		"skills:",
		...rows.map((row) => `${row.enabled ? "[x]" : "[ ]"} ${row.name}  ${row.provenance}${row.locked ? "  locked" : ""}  ~${row.tokens} tok  ${shorten(row.description)}`),
		`enabled ${sum.enabled}/${sum.total}, catalog ~${sum.tokens} tok; changes apply to new conversations (/new)`,
	].join("\n");
}
function checklistPrompt(rows: readonly SkillRow[], signal: AbortSignal): CommandChecklistPrompt {
	const sum = totals(rows);
	const ordered = [...rows].sort((a, b) => PROVENANCE_ORDER.indexOf(a.provenance) - PROVENANCE_ORDER.indexOf(b.provenance) || a.name.localeCompare(b.name));
	return {
		type: "checklist",
		message: `Skills · ${sum.enabled}/${sum.total} enabled · ~${sum.tokens} tok · applies to /new`,
		options: ordered.map((row) => ({
			id: row.name, label: row.name, description: shorten(row.description), group: row.provenance,
			badge: row.locked ? "default" : `~${row.tokens} tok`, checked: row.enabled,
			...(row.locked ? { disabled: true } : {}),
		})),
		signal,
	};
}
/** Parses a checklist answer: a JSON array of strings. Throws before any mutation otherwise. */
function checkedIds(answer: string): Set<string> {
	let value: unknown;
	try { value = JSON.parse(answer); } catch { value = undefined; }
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error("malformed checklist answer: expected a JSON array of skill names; nothing changed");
	}
	return new Set(value);
}
async function setEnabled(bot: Bot, name: string, enabled: boolean, context: Context): Promise<void> {
	if (enabled) await bot.curation.restore(name, { actor: OWNER, requestId: `command:enable:${randomUUID()}`, reason: "enabled by local owner" }, context);
	else await bot.curation.archive(name, { actor: OWNER, requestId: `command:disable:${randomUUID()}`, reason: "disabled by local owner" }, context);
}
/** Applies a checklist answer against the current state: only non-bundled skills whose state differs change. */
async function applyChecklist(bot: Bot, answer: string, context: Context, io: CommandIO): Promise<void> {
	const wanted = checkedIds(answer);
	io.signal.throwIfAborted();
	const rows = await skillRows(bot, context);
	const known = new Set(rows.map((row) => row.name));
	const unknown = [...wanted].filter((name) => !known.has(name));
	if (unknown.length) throw new Error(`unknown skill ${unknown.join(", ")}; nothing changed`);
	const changes = rows.filter((row) => !row.locked && wanted.has(row.name) !== row.enabled);
	const enabled: string[] = [];
	const disabled: string[] = [];
	for (const row of changes) {
		io.signal.throwIfAborted();
		try {
			await setEnabled(bot, row.name, !row.enabled, context);
		} catch (error) {
			const done = [...(enabled.length ? [`enabled ${enabled.join(", ")}`] : []), ...(disabled.length ? [`disabled ${disabled.join(", ")}`] : [])];
			throw new Error(`could not ${row.enabled ? "disable" : "enable"} skill ${row.name}: ${error instanceof Error ? error.message : String(error)}${done.length ? ` (already applied: ${done.join("; ")})` : ""}`);
		}
		(row.enabled ? disabled : enabled).push(row.name);
	}
	if (changes.length === 0) {
		io.print("No changes.");
		return;
	}
	io.print([
		...(enabled.length ? [`Enabled: ${enabled.join(", ")}`] : []),
		...(disabled.length ? [`Disabled: ${disabled.join(", ")}`] : []),
		"Changes apply to new conversations (/new); this conversation keeps its skills.",
	].join("\n"), "success");
}

const SUBCOMMANDS: readonly (readonly [string, string])[] = [
	["list", "List skills with enabled state and catalog cost"],
	["on", "Enable a skill for new conversations: on <name>"],
	["off", "Disable a non-bundled skill for new conversations: off <name>"],
	["pending", "Show unpublished skill proposals"],
	["diff", "Show a proposal diff: diff <id>"],
	["history", "Show a skill's publication history: history <name>"],
	["publish", "Publish a proposal: publish <id>"],
	["reject", "Reject a proposal: reject <id>"],
	["archived", "List archived (disabled) skills"],
	["archive", "Archive a non-bundled skill: archive <name>"],
	["restore", "Restore an archived skill: restore <name>"],
	["pin", "Exempt a skill from automatic archive: pin <name>"],
	["unpin", "Allow automatic archive again: unpin <name>"],
	["curator", "Skill curator: status | run | dry-run"],
	["evolution", "Skill research: status | pause | kill | resume"],
	["legacy", "List unpinned legacy conversations"],
];

/**
 * Proposals are automatically approved; local publication does not prompt.
 * Manual publication and rejection remain local TUI operations.
 */
export function skillsCommand(bot: Bot): SlashCommand {
	return {
		name: "skills",
		description: "Turn skills on or off for new conversations, list them and review proposed changes",
		usage: "[list|on <name>|off <name>|pending|diff|history|publish <id>|reject|legacy|evolution|curator|archived|archive|restore|pin|unpin <name>]",
		surfaces: ["tui", "channel"],
		arguments: async (): Promise<readonly CommandArgument[]> => SUBCOMMANDS.map(([value, description]) => ({ value, label: value, description })),
		run: async (args, { surface, context: parentContext, io }) => {
			const context = withAbortSignal(io.signal, parentContext);
			const words = args.trim() === "" ? [] : args.trim().split(/\s+/);
			const [action, id] = words;
			if (action === "evolution" && words.length <= 2) {
				const operation = id ?? "status";
				if (operation !== "status") {
					if (surface !== "tui") throw new Error("research administration requires the local TUI");
					const requestId = `command:evolution:${randomUUID()}`;
					switch (operation) {
						case "pause": await bot.skillEvolution.pause(requestId, context, "local-owner"); break;
						case "kill": await bot.skillEvolution.kill(requestId, context, "local-owner"); break;
						case "resume":
							try { await bot.skillEvolution.resume(requestId, context, "local-owner"); }
							catch (error) {
								if (!(error instanceof EvolutionJobError) || error.code !== "disabled") throw error;
								throw new EvolutionJobError("disabled", `Resume refused; research remains disabled: ${error.message}`);
							}
							break;
						default: throw new Error(`usage: /skills ${USAGE}`);
					}
				}
				const state = await bot.skillEvolution.status(context);
				const observations = await bot.skillObservations?.snapshot(SkillObservationDoc, context);
				const driver = await bot.harness.snapshot(SkillObservationDriverDoc, context);
				const review = await bot.skillReview?.status(context);
				io.print([
					`Skill research: ${state.mode}${operation === "status" ? "" : ` (${operation} applied)`}`,
					`Jobs: ${state.pending.length} pending | ${state.scheduled.filter((task) => task.status !== "terminal").length} scheduled`,
					`Budget: $${((state.spent?.costMicros ?? 0) / 1_000_000).toFixed(6)} spent | $${((state.reserved?.costMicros ?? 0) / 1_000_000).toFixed(6)} reserved`,
					state.budgetScope === "fixed-window"
						? `Budget scope: fixed ${((state.budgetWindowMs ?? 0) / 3_600_000).toFixed(1)}h window${state.budgetWindowStart === null ? "" : ` since ${at(state.budgetWindowStart)}`}, reservations carry over`
						: "Budget scope: fixed deployment cap, no automatic reset",
					...(review ? [
						`Background review: ${state.reviewPublicationEnabled ? "publishing (reversible, unverified)" : "drafts only"} | ${review.snapshots} snapshots, last ${at(review.lastSnapshotAt)} | published today ${review.publishedToday}/${review.config.maxPublishesPerDay}${review.job ? ` | job ${review.job.jobId.slice(0, 12)}` : ""}`,
						...(review.latest ? [`Last review: ${review.latest.status}${review.latest.operation ? ` ${review.latest.operation}` : ""}${review.latest.name ? ` ${review.latest.name}` : ""}${review.latest.reason ? ` (${review.latest.reason})` : ""}`] : []),
						...(review.lastSkip ? [`Review skipped: ${review.lastSkip.reason}`] : []),
					] : []),
					`Confirmation provider: ${state.automaticEvaluationImplemented ? "registered" : "absent"}`,
					...(state.finalization ? [`Last confirmation: ${state.finalization.status}${state.finalization.reason ? ` (${state.finalization.reason})` : ""}`] : []),
					`Observations: ${observations?.observations.length ?? 0} retained | ${observations?.bytes ?? 0} bytes`,
					...(driver?.error ? [`Observation error: ${driver.error}`] : []),
					...state.disabledReasons.map((reason) => `Disabled: ${reason}`),
					surface === "tui"
						? `Controls: /skills evolution pause | kill${state.canResume ? " | resume" : " (resume unavailable)"}`
						: "Research controls are available in the local TUI.",
				].join("\n"));
				return;
			}
			if (action === "list" && words.length === 1) {
				io.print(renderList(await skillRows(bot, context)));
				return;
			}
			if (words.length === 0) {
				// Channels and non-interactive surfaces get the text list; mutations stay in the TUI.
				if (surface !== "tui" || !io.interactive) {
					io.print(renderList(await skillRows(bot, context)));
					return;
				}
				const rows = await skillRows(bot, context);
				if (rows.length === 0) {
					io.print("no skills loaded");
					return;
				}
				let answer: string;
				try {
					answer = await io.prompt(checklistPrompt(rows, io.signal));
				} catch (error) {
					// Cancel or abort: nothing is applied.
					if (io.signal.aborted) throw error;
					io.print("No changes.");
					return;
				}
				await applyChecklist(bot, answer, context, io);
				return;
			}
			if ((action === "on" || action === "off") && words.length === 2 && id !== undefined) {
				if (surface !== "tui") throw new Error("skill on and off commands require the local TUI");
				io.signal.throwIfAborted();
				const row = (await skillRows(bot, context)).find((item) => item.name === id);
				if (!row) throw new Error(`unknown skill ${id}`);
				const enable = action === "on";
				if (!enable && row.locked) throw new Error(`bundled skill ${id} cannot be disabled`);
				if (row.enabled === enable) {
					io.print(`skill ${id} is already ${enable ? "enabled" : "disabled"}; nothing changed.`);
					return;
				}
				await setEnabled(bot, id, enable, context);
				io.print(`${enable ? "enabled" : "disabled"} skill ${id}; applies to new conversations (/new).`, "success");
				return;
			}
			if ((action === "publish" || action === "reject" || action === "close-legacy") && surface !== "tui") {
				throw new Error("skill publication and rejection commands require the local TUI");
			}
			if (action === "curator" && words.length <= 2) {
				const operation = id ?? "status";
				if (operation === "status") { io.print(renderStatus(await bot.curation.status(context)).join("\n")); return; }
				if (operation !== "run" && operation !== "dry-run") throw new Error(`usage: /skills ${USAGE}`);
				if (operation === "run" && surface !== "tui") throw new Error("skill curation runs require the local TUI");
				io.signal.throwIfAborted();
				io.print(renderReport(await bot.curation.run({ dryRun: operation === "dry-run" }, context)).join("\n"));
				return;
			}
			if (action === "archived" && words.length === 1) {
				const archived = (await bot.curation.status(context)).skills.filter((skill) => skill.lifecycle === "inactive");
				io.print(archived.length
					? ["archived skills (restore with /skills restore <name>):", ...archived.map((skill) => `  ${skill.name}  ${skill.provenance}  archived ${at(skill.archivedAt)}${skill.reason ? `  ${skill.reason}` : ""}`)].join("\n")
					: "No archived skills.");
				return;
			}
			if ((action === "archive" || action === "restore" || action === "pin" || action === "unpin") && words.length === 2 && id !== undefined) {
				if (surface !== "tui") throw new Error("skill archive, restore and pin commands require the local TUI");
				io.signal.throwIfAborted();
				switch (action) {
					case "archive": {
						const publication = await bot.curation.archive(id, { actor: "local-owner", requestId: `command:archive:${randomUUID()}`, reason: "archived by local owner" }, context);
						io.print(`archived skill ${id}; new conversations use default generation ${publication.generation}. Restore with /skills restore ${id}.`, "success");
						return;
					}
					case "restore": {
						const publication = await bot.curation.restore(id, { actor: "local-owner", requestId: `command:restore:${randomUUID()}`, reason: "restored by local owner" }, context);
						io.print(`restored skill ${id}; new conversations use default generation ${publication.generation}.`, "success");
						return;
					}
					default:
						await bot.curation.pin(id, action === "pin", context);
						io.print(action === "pin" ? `pinned skill ${id}: exempt from automatic archive` : `unpinned skill ${id}: automatic archive applies again`, "success");
						return;
				}
			}
			if (action === "legacy" && words.length === 1) {
				const ids = await bot.skills.legacyConversations(context);
				io.print(ids.length ? `Unpinned legacy conversations (they use the live catalog; publication is not blocked): ${ids.join(", ")}\nUse /skills close-legacy <conversation> to end one explicitly, then /new.` : "No resumable legacy conversations.");
				return;
			}
			if (action === "pending" && words.length === 1) {
				const pending = await bot.skills.pending(context);
				io.print(JSON.stringify(pending.map(({ proposalId, name, operation, status, expectedGeneration, version }) => ({
					proposalId, name, operation, status, expectedGeneration, version,
				})), null, 2));
				return;
			}
			if (words.length !== 2 || id === undefined) throw new Error(`usage: /skills ${USAGE}`);
			switch (action) {
				case "close-legacy":
					await bot.skills.closeLegacy(id, context);
					io.print(`Closed legacy conversation ${id}. Start a new conversation with /new.`, "success");
					return;
				case "diff":
					io.print(JSON.stringify(await bot.skills.diff(id, context), null, 2));
					return;
				case "history":
					io.print(JSON.stringify(await bot.skills.history(id, context), null, 2));
					return;
				case "reject":
					io.signal.throwIfAborted();
					await bot.skills.reject(id, "local-owner", context);
					io.print(`rejected skill proposal ${id}`, "success");
					return;
				case "publish": {
					io.signal.throwIfAborted();
					const diff = await bot.skills.diff(id, context);
					if (diff.status === "published") {
						io.print(`skill proposal ${id} already published; current active version unchanged`);
						return;
					}
					io.print(JSON.stringify(diff, null, 2));
					io.signal.throwIfAborted();
					const published = await bot.skills.publish(
						{ proposalId: id, requestId: `command:publish:${id}` },
						"local-owner",
						context,
					);
					io.print(`published skill ${published.name} (generation ${published.generation}, version ${published.version})`, "success");
					return;
				}
				default:
					throw new Error(`usage: /skills ${USAGE}`);
			}
		},
	};
}
