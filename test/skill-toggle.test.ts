import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { AuthService } from "../src/auth/types.ts";
import { createCommands } from "../src/commands/index.ts";
import { estimateCatalogTokens, skillsCommand } from "../src/commands/skills.ts";
import type { CommandChecklistPrompt, CommandEvent, CommandIO, CommandInvocation, Surface } from "../src/commands/types.ts";
import { openBot, type Bot } from "../src/core/bot.ts";
import { SkillDefaultDoc } from "../src/core/skills/manifests.ts";
import { SkillLifecycleError } from "../src/core/skills/retention.ts";

const bots: Bot[] = [];
afterEach(async () => {
	for (const bot of bots.splice(0)) await bot.close(context);
});

async function setup(): Promise<{ bot: Bot; bundled: string[] }> {
	const bot = await openBot({
		storage: new MemoryStorage(), models: createModels(), defaultModel: { provider: "faux", modelId: "one" },
		plugins: [], toolMode: "direct",
	}, context);
	bots.push(bot);
	await bot.curation.run({ dryRun: true }, context);
	// Non-bundled skills enter through the real store path (agent proposal + publication).
	for (const name of ["alpha-flow", "beta-flow"]) {
		const staged = await bot.skills.propose({
			name, description: `Agent workflow ${name}`, body: `Follow the ${name} workflow.`, files: {}, expectedGeneration: 0, requestId: `propose-${name}`,
		}, "agent:1", context);
		await bot.skills.publish({ proposalId: staged.proposalId, requestId: `publish-${name}` }, "agent:1", context);
	}
	const bundled = (await bot.curation.status(context)).skills.filter((skill) => skill.provenance === "bundled").map((skill) => skill.name);
	return { bot, bundled };
}

type Harness = { output: string[]; prompts: CommandChecklistPrompt[]; invocation: CommandInvocation; abort: AbortController };
function invoke(surface: Surface, interactive: boolean, answer?: (prompt: CommandChecklistPrompt) => Promise<string>): Harness {
	const output: string[] = [];
	const prompts: CommandChecklistPrompt[] = [];
	const abort = new AbortController();
	const io: CommandIO = {
		signal: abort.signal, interactive,
		print(text) { output.push(text); }, notify() {}, state() {},
		async prompt(prompt) {
			if (prompt.type !== "checklist") throw new Error(`unexpected ${prompt.type} prompt`);
			prompts.push(prompt);
			if (!answer) throw new Error("no answer");
			return answer(prompt);
		},
	};
	return { output, prompts, abort, invocation: { surface, channel: surface, threadKey: "main", userId: "local", context, io } };
}
async function names(bot: Bot, key: string): Promise<string[]> {
	return (await bot.skills.executionList((await bot.conversation("test", key, context)).id, context)).map((item) => item.name);
}
async function lifecycle(bot: Bot): Promise<Record<string, string>> {
	return Object.fromEntries((await bot.curation.status(context)).skills.map((skill) => [skill.name, skill.lifecycle]));
}
async function defaultGeneration(bot: Bot): Promise<number | undefined> {
	return (await bot.harness.snapshot(SkillDefaultDoc, context))?.publication?.generation;
}

test("token estimator counts ASCII at four characters per token and each non-ASCII character as one", () => {
	const ascii = { name: "a", description: "b", generation: 1, version: "v" };
	expect(JSON.stringify(ascii).length).toBe(59);
	expect(estimateCatalogTokens(ascii)).toBe(15);
	// "한국어" replaces one ASCII character with three non-ASCII ones: ceil(58 / 4) + 3.
	expect(estimateCatalogTokens({ ...ascii, description: "한국어" })).toBe(18);
	// Extra fields are not part of the catalog entry.
	expect(estimateCatalogTokens({ ...ascii, source: "x".repeat(400) } as typeof ascii)).toBe(15);
});

test("list shows enabled markers, locked bundled skills first, token costs and the /new footer", async () => {
	const { bot, bundled } = await setup();
	expect(bundled.length).toBeGreaterThan(0);
	const h = invoke("tui", true);
	await skillsCommand(bot).run("list", h.invocation);
	const lines = h.output[0]!.split("\n");
	expect(lines[0]).toBe("skills:");
	const rows = lines.slice(1, -1);
	expect(rows.length).toBe(bundled.length + 2);
	for (const [index, name] of [...bundled].sort((a, b) => a.localeCompare(b)).entries()) {
		expect(rows[index]).toMatch(new RegExp(`^\\[x\\] ${name}  bundled  locked  ~\\d+ tok  `));
	}
	expect(rows.at(-2)).toMatch(/^\[x\] alpha-flow  agent  ~\d+ tok  Agent workflow alpha-flow$/);
	expect(rows.at(-1)).toMatch(/^\[x\] beta-flow  agent  ~\d+ tok  /);
	const total = rows.reduce((sum, row) => sum + Number(/~(\d+) tok/.exec(row)![1]), 0);
	expect(lines.at(-1)).toBe(`enabled ${bundled.length + 2}/${bundled.length + 2}, catalog ~${total} tok; changes apply to new conversations (/new)`);
	// Exactly the estimator over the real catalog summary.
	const alpha = (await bot.skills.list(context)).find((item) => item.name === "alpha-flow")!;
	expect(rows.at(-2)).toContain(`~${estimateCatalogTokens(alpha)} tok`);
	// The checklist is never opened for an explicit list.
	expect(h.prompts).toEqual([]);
});

test("off removes a skill from new conversations only; on brings it back for the next new conversation", async () => {
	const { bot } = await setup();
	const command = skillsCommand(bot);
	const before = await names(bot, "before-off");
	expect(before).toContain("alpha-flow");
	const h = invoke("tui", true);
	await command.run("off alpha-flow", h.invocation);
	expect(h.output.at(-1)).toBe("disabled skill alpha-flow; applies to new conversations (/new).");
	expect((await lifecycle(bot))["alpha-flow"]).toBe("inactive");
	// The default manifest excludes it: a conversation created after lacks it, the older one keeps its pin.
	expect(await names(bot, "after-off")).not.toContain("alpha-flow");
	expect(await names(bot, "before-off")).toEqual(before);
	await command.run("list", h.invocation);
	expect(h.output.at(-1)).toContain("[ ] alpha-flow  agent");
	await command.run("off alpha-flow", h.invocation);
	expect(h.output.at(-1)).toBe("skill alpha-flow is already disabled; nothing changed.");
	await command.run("on alpha-flow", h.invocation);
	expect(h.output.at(-1)).toBe("enabled skill alpha-flow; applies to new conversations (/new).");
	expect(await names(bot, "after-on")).toContain("alpha-flow");
	expect(await names(bot, "after-off")).not.toContain("alpha-flow");
	await command.run("on alpha-flow", h.invocation);
	expect(h.output.at(-1)).toBe("skill alpha-flow is already enabled; nothing changed.");
	await expect(command.run("on missing-flow", h.invocation)).rejects.toThrow("unknown skill missing-flow");
});

test("bundled skills can never be disabled by off, archive or the curation service", async () => {
	const { bot, bundled } = await setup();
	const command = skillsCommand(bot);
	const h = invoke("tui", true);
	const generation = await defaultGeneration(bot);
	for (const name of bundled) {
		await expect(command.run(`off ${name}`, h.invocation)).rejects.toThrow(`bundled skill ${name} cannot be disabled`);
		await expect(command.run(`archive ${name}`, h.invocation)).rejects.toThrow("Bundled skill cannot be disabled");
		const error = await bot.curation.archive(name, { actor: "agent:1", requestId: `direct-${name}`, reason: "test" }, context).catch((value: unknown) => value);
		expect(error).toBeInstanceOf(SkillLifecycleError);
		expect((error as SkillLifecycleError).code).toBe("guard");
		expect((error as SkillLifecycleError).message).toBe("Bundled skill cannot be disabled");
	}
	expect(await defaultGeneration(bot)).toBe(generation);
	const states = await lifecycle(bot);
	for (const name of bundled) expect(states[name]).toBe("active");
	const fresh = await names(bot, "after-refusals");
	for (const name of bundled) expect(fresh).toContain(name);
	// Non-bundled archive still works through the same guarded path.
	await command.run("archive beta-flow", h.invocation);
	expect((await lifecycle(bot))["beta-flow"]).toBe("inactive");
});

test("interactive TUI /skills opens a grouped checklist with locked bundled rows", async () => {
	const { bot, bundled } = await setup();
	await skillsCommand(bot).run("off beta-flow", invoke("tui", true).invocation);
	const h = invoke("tui", true, async () => { throw new Error("cancelled"); });
	await skillsCommand(bot).run("", h.invocation);
	expect(h.prompts.length).toBe(1);
	const prompt = h.prompts[0]!;
	expect(prompt.type).toBe("checklist");
	expect(prompt.signal).toBe(h.invocation.io.signal);
	const total = bundled.length + 2;
	expect(prompt.message).toMatch(new RegExp(`^Skills · ${total - 1}/${total} enabled · ~\\d+ tok · applies to /new$`));
	const groups = prompt.options.map((option) => option.group);
	expect(groups).toEqual([...bundled.map(() => "bundled"), "agent", "agent"]);
	for (const option of prompt.options.slice(0, bundled.length)) {
		expect(option).toMatchObject({ disabled: true, badge: "default", checked: true });
	}
	expect(prompt.options.slice(bundled.length)).toEqual([
		expect.objectContaining({ id: "alpha-flow", label: "alpha-flow", checked: true, badge: expect.stringMatching(/^~\d+ tok$/), description: "Agent workflow alpha-flow" }),
		expect.objectContaining({ id: "beta-flow", checked: false, badge: expect.stringMatching(/^~\d+ tok$/) }),
	]);
	expect(prompt.options.slice(bundled.length).some((option) => option.disabled)).toBe(false);
	// Cancel applies nothing.
	expect(h.output).toEqual(["No changes."]);
});

test("a checklist answer applies only the diff of non-bundled skills and ignores bundled ids", async () => {
	const { bot, bundled } = await setup();
	const command = skillsCommand(bot);
	await command.run("off beta-flow", invoke("tui", true).invocation);
	const before = await names(bot, "before-apply");
	// Omit one bundled id (would mean "uncheck") and uncheck alpha, check beta.
	const answer = JSON.stringify([...bundled.slice(1), "beta-flow"]);
	const h = invoke("tui", true, async () => answer);
	await command.run("", h.invocation);
	expect(h.output.at(-1)).toBe("Enabled: beta-flow\nDisabled: alpha-flow\nChanges apply to new conversations (/new); this conversation keeps its skills.");
	const states = await lifecycle(bot);
	expect(states["alpha-flow"]).toBe("inactive");
	expect(states["beta-flow"]).toBe("active");
	for (const name of bundled) expect(states[name]).toBe("active");
	const after = await names(bot, "after-apply");
	expect(after).toContain("beta-flow");
	expect(after).not.toContain("alpha-flow");
	expect(after).toContain(bundled[0]!);
	expect(await names(bot, "before-apply")).toEqual(before);
	// Applying the current state again is a no-op.
	const generation = await defaultGeneration(bot);
	const same = invoke("tui", true, async (prompt) => JSON.stringify(prompt.options.filter((option) => option.checked).map((option) => option.id)));
	await command.run("", same.invocation);
	expect(same.output).toEqual(["No changes."]);
	expect(await defaultGeneration(bot)).toBe(generation);
});

test("unknown ids, malformed answers, cancel and abort change nothing", async () => {
	const { bot, bundled } = await setup();
	const command = skillsCommand(bot);
	const states = await lifecycle(bot);
	const generation = await defaultGeneration(bot);
	const unchanged = async () => {
		expect(await lifecycle(bot)).toEqual(states);
		expect(await defaultGeneration(bot)).toBe(generation);
	};
	// alpha unchecked would be a change, but the unknown id rejects the whole answer first.
	await expect(command.run("", invoke("tui", true, async () => JSON.stringify([...bundled, "beta-flow", "ghost-flow"])).invocation)).rejects.toThrow("unknown skill ghost-flow; nothing changed");
	await unchanged();
	for (const answer of ["not json", "{\"alpha-flow\":true}", "[1,2]", "null"]) {
		await expect(command.run("", invoke("tui", true, async () => answer).invocation)).rejects.toThrow("malformed checklist answer");
		await unchanged();
	}
	const cancelled = invoke("tui", true, async () => { throw new Error("cancelled"); });
	await command.run("", cancelled.invocation);
	expect(cancelled.output).toEqual(["No changes."]);
	await unchanged();
	const aborted = invoke("tui", true, async () => {
		aborted.abort.abort();
		throw new Error("aborted");
	});
	await expect(command.run("", aborted.invocation)).rejects.toThrow();
	await unchanged();
	// Aborted after the answer arrived: still nothing applied.
	const late = invoke("tui", true, async () => {
		late.abort.abort();
		return JSON.stringify(bundled);
	});
	await expect(command.run("", late.invocation)).rejects.toThrow();
	await unchanged();
});

test("channels get the text list and cannot toggle skills", async () => {
	const { bot } = await setup();
	const command = skillsCommand(bot);
	const channel = invoke("channel", false, async () => "[]");
	await command.run("", channel.invocation);
	expect(channel.prompts).toEqual([]);
	const tuiList = invoke("tui", true);
	await command.run("list", tuiList.invocation);
	expect(channel.output).toEqual(tuiList.output);
	await command.run("list", channel.invocation);
	expect(channel.output[1]).toBe(tuiList.output[0]!);
	const states = await lifecycle(bot);
	for (const args of ["on alpha-flow", "off alpha-flow", "archive alpha-flow", "restore alpha-flow"]) {
		await expect(command.run(args, channel.invocation)).rejects.toThrow("local TUI");
	}
	expect(await lifecycle(bot)).toEqual(states);
	// A non-interactive TUI invocation also prints the list instead of prompting.
	const headless = invoke("tui", false, async () => "[]");
	await command.run("", headless.invocation);
	expect(headless.prompts).toEqual([]);
	expect(headless.output).toEqual(tuiList.output);
});

test("skills argument hints describe every subcommand", async () => {
	const { bot } = await setup();
	const command = skillsCommand(bot);
	const hints = await command.arguments!(context, { channel: "tui", threadKey: "main" });
	expect(hints.map((hint) => hint.value)).toEqual(["list", "on", "off", "pending", "diff", "history", "publish", "reject", "archived", "archive", "restore", "pin", "unpin", "curator", "evolution", "legacy"]);
	for (const hint of hints) expect(hint.description?.length ?? 0).toBeGreaterThan(0);
	expect(command.usage).toContain("on <name>");
	expect(command.usage).toContain("off <name>");
});

test("the command runner forwards the checklist prompt and applies the JSON answer", async () => {
	const { bot } = await setup();
	const commands = createCommands({ bot, models: createModels(), auth: {} as AuthService, plugins: [] });
	const command = commands.find("skills", "tui")!;
	const run = commands.run(command, "", { surface: "tui", channel: "tui", threadKey: "main", userId: "local", context });
	const events: CommandEvent[] = [];
	for await (const event of run.events) {
		events.push(event);
		if (event.type === "prompt") {
			expect(event.prompt.type).toBe("checklist");
			if (event.prompt.type !== "checklist") throw new Error("unexpected prompt");
			expect("signal" in event.prompt).toBe(false);
			const checked = event.prompt.options.filter((option) => option.checked && option.id !== "alpha-flow").map((option) => option.id);
			expect(commands.answer(run.runId, event.id, { value: JSON.stringify(checked) })).toBe(true);
		}
	}
	expect(events.at(-1)).toEqual({ type: "done" });
	expect(events).toContainEqual(expect.objectContaining({ type: "output", text: expect.stringContaining("Disabled: alpha-flow"), level: "success" }));
	expect((await lifecycle(bot))["alpha-flow"]).toBe("inactive");
	expect(await names(bot, "after-runner")).not.toContain("alpha-flow");
	// The channel runner prints the list instead of prompting.
	const channelCommand = commands.find("skills", "channel")!;
	const channelRun = commands.run(channelCommand, "", { surface: "channel", channel: "slack", threadKey: "t", userId: "u", context });
	const channelEvents: CommandEvent[] = [];
	for await (const event of channelRun.events) channelEvents.push(event);
	expect(channelEvents.some((event) => event.type === "prompt")).toBe(false);
	expect(channelEvents).toContainEqual(expect.objectContaining({ type: "output", text: expect.stringContaining("[ ] alpha-flow  agent") }));
});
