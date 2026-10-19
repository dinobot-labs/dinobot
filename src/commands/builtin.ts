import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import { AgentDoc } from "@earendil-works/pi-durable";
import type { AccountInfo, AuthService, LoginProvider, LoginResult, ProviderAccounts } from "../auth/types.ts";
import type { Bot } from "../core/bot.ts";
import { selectModel } from "../core/threads.ts";
import type { LoadedPlugin } from "../plugins/types.ts";
import type { CommandArgument, CommandInfo, CommandInvocation, CommandIO, SlashCommand, Surface } from "./types.ts";

const NO_TRANSPORT = "no model transport in this build";
const CHAT_GROUP = "Chat providers";
const LOGIN_ONLY_GROUP = "Login only (no chat transport yet)";

/** The thread conversation's configured model as `provider/modelId`. */
export async function currentModel(bot: Bot, channel: string, threadKey: string, context: Context): Promise<string | undefined> {
	const conversation = await bot.conversation(channel, threadKey, context);
	const agent = await bot.harness.snapshot(AgentDoc, conversation.id, context);
	return agent?.model ? `${agent.model.provider}/${agent.model.modelId}` : undefined;
}

export function helpCommand(list: (surface: Surface) => readonly CommandInfo[]): SlashCommand {
	return {
		name: "help",
		description: "List the available commands",
		surfaces: ["tui", "channel"],
		run: async (_args, { surface, io }) => {
			const lines = list(surface).map((info) => `/${info.name}${info.usage ? ` ${info.usage}` : ""}  ${info.description}`);
			io.print(lines.join("\n"));
		},
	};
}

function providerLine(provider: LoginProvider): string {
	return `${provider.id}  ${provider.name}${provider.modelProvider ? "" : ` (${NO_TRANSPORT})`}`;
}

/** Login providers as picker rows: chat providers first, then login-only ones, each badged when a credential is stored. */
async function loginArguments(auth: AuthService): Promise<CommandArgument[]> {
	const providers = await auth.providers();
	const stored = new Set((await auth.status()).map((entry) => entry.key));
	const row = (provider: LoginProvider): CommandArgument => ({
		value: provider.id,
		label: provider.name,
		group: provider.modelProvider ? CHAT_GROUP : LOGIN_ONLY_GROUP,
		...(provider.modelProvider ? {} : { description: NO_TRANSPORT }),
		...(stored.has(provider.modelProvider ?? provider.storeAs) ? { badge: "logged in" } : {}),
	});
	return [
		...providers.filter((provider) => provider.modelProvider).map(row),
		...providers.filter((provider) => !provider.modelProvider).map(row),
	];
}

export function loginCommand(auth: AuthService): SlashCommand {
	return {
		name: "login",
		description: "Log in to a model provider",
		usage: "[provider]",
		surfaces: ["tui"],
		arguments: () => loginArguments(auth),
		run: async (args, { io }) => {
			if (args.trim() === "" && !io.interactive) {
				io.print(["providers:", ...(await auth.providers()).map(providerLine)].join("\n"));
				return;
			}
			await runLogin(auth, io, args.trim());
		},
	};
}

/**
 * One provider login: prompts for the provider when `providerId` is empty (interactive surfaces only), runs its flow and
 * prints the outcome as a success line. Shared by `/login` and `/setup`; rejects when the flow fails or is cancelled.
 */
export async function runLogin(auth: AuthService, io: CommandIO, providerId: string, message = "Log in to a provider"): Promise<LoginResult> {
	let id = providerId;
	if (id === "") {
		id = await io.prompt({
			type: "select",
			message,
			login: true,
			options: (await loginArguments(auth)).map(({ value, ...rest }) => ({ id: value, ...rest })),
		});
	}
	const result = await auth.login(id, {
		signal: io.signal,
		prompt: (prompt) => io.prompt(prompt),
		notify: (event) => io.notify(event),
	});
	const who = result.identity ? ` as ${result.identity}` : "";
	const pool =
		result.account && result.account.total > 1
			? `; account #${result.account.id} of ${result.account.total}, ${result.account.added ? "added" : "updated"}, rotates on rate/usage limits`
			: "";
	const stored = `${result.type}, stored as ${result.provider.modelProvider ?? result.provider.storeAs}${pool}`;
	io.print(
		result.provider.modelProvider
			? `logged in to ${result.provider.name}${who} (${stored})`
			: `${result.provider.name}${who}: logged in; ${NO_TRANSPORT} (${stored})`,
		"success",
	);
	return result;
}

const ALL_ACCOUNTS = "*";

function accountRow(account: AccountInfo): string {
	return `#${account.id}  ${account.label ?? account.type}${accountState(account) ? `  ${accountState(account)}` : ""}`;
}

/** "active", "rate limited for 12m", ...; empty for an idle healthy account. */
export function accountState(account: AccountInfo, now = Date.now()): string {
	if (account.blockedUntil !== undefined && account.blockedUntil > now) {
		const reason = account.lastFailure === "quota" ? "usage limit" : account.lastFailure === "auth" ? "auth failed" : "rate limited";
		return `${account.active ? "active, " : ""}${reason} for ${formatDuration(account.blockedUntil - now)}`;
	}
	return account.active ? "active" : "";
}

function formatDuration(ms: number): string {
	const minutes = Math.ceil(ms / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return minutes % 60 === 0 ? `${hours}h` : `${hours}h${minutes % 60}m`;
}

function accountsText(pools: readonly ProviderAccounts[]): string {
	if (pools.length === 0) return "no stored credentials; /login adds accounts";
	return pools
		.map((pool) => {
			const header = pool.accounts.length > 1 ? `${pool.key}  ${pool.accounts.length} accounts, rotates on rate/usage limits` : pool.key;
			return [header, ...pool.accounts.map((account) => `  ${account.active ? "*" : " "} ${accountRow(account)}`)].join("\n");
		})
		.join("\n");
}

export function logoutCommand(auth: AuthService): SlashCommand {
	return {
		name: "logout",
		description: "Remove a stored credential, or one account of it",
		usage: "[provider] [account]",
		surfaces: ["tui"],
		arguments: async () => (await auth.status()).map((entry) => ({ value: entry.key, label: entry.key, description: entry.type })),
		run: async (args, { io }) => {
			let [key = "", ...rest] = args.trim().split(/\s+/).filter((part) => part !== "");
			let account: string | undefined = rest.length > 0 ? rest.join(" ") : undefined;
			if (key === "") {
				const stored = await auth.status();
				if (stored.length === 0) {
					io.print("no stored credentials");
					return;
				}
				if (!io.interactive) {
					io.print(["stored credentials:", ...stored.map((entry) => `${entry.key}  ${entry.type}`)].join("\n"));
					return;
				}
				key = await io.prompt({
					type: "select",
					message: "Log out of",
					options: stored.map((entry) => ({ id: entry.key, label: entry.key, description: entry.type, badge: entry.type })),
				});
			}
			const pool = (await auth.accounts()).find((entry) => entry.key === key);
			if (account === undefined && pool && pool.accounts.length > 1 && io.interactive) {
				account = await io.prompt({
					type: "select",
					message: `Log out of ${key}`,
					options: [
						...pool.accounts.map((entry) => ({
							id: entry.id,
							label: entry.label ?? `account #${entry.id}`,
							description: `#${entry.id}`,
							...(entry.active ? { current: true } : {}),
						})),
						{ id: ALL_ACCOUNTS, label: "All accounts", description: `remove every ${key} account` },
					],
				});
			}
			if (account === ALL_ACCOUNTS) account = undefined;
			if (await auth.logout(key, account)) io.print(account === undefined ? `logged out of ${key}` : `removed ${key} account ${account}`, "success");
			else io.print(account === undefined ? `nothing stored for ${key}` : `no account "${account}" for ${key}`);
		},
	};
}

/** `/accounts` lists pooled accounts; `/accounts use <provider> <account>` switches the active one. */
export function accountsCommand(auth: AuthService): SlashCommand {
	const useRows = async (): Promise<CommandArgument[]> =>
		(await auth.accounts())
			.filter((pool) => pool.accounts.length > 1)
			.flatMap((pool) =>
				pool.accounts.map((account) => {
					const state = accountState(account);
					return {
						value: `use ${pool.key} ${account.id}`,
						label: account.label ?? `account #${account.id}`,
						group: pool.key,
						...(state ? { description: state } : {}),
						...(account.active ? { current: true } : {}),
						badge: `#${account.id}`,
					};
				}),
			);
	return {
		name: "accounts",
		description: "List provider accounts or switch the active one (rotation pool)",
		usage: "[use <provider> <account>]",
		surfaces: ["tui"],
		arguments: useRows,
		run: async (args, { io }) => {
			const [action = "", key, ...rest] = args.trim().split(/\s+/).filter((part) => part !== "");
			if (action === "" || action === "list") {
				io.print(accountsText(await auth.accounts()));
				return;
			}
			if (action !== "use") {
				io.print("usage: /accounts [use <provider> <account>]", "error");
				return;
			}
			let target = key !== undefined && rest.length > 0 ? { key, account: rest.join(" ") } : undefined;
			if (!target) {
				const rows = (await useRows()).filter((row) => key === undefined || row.group === key);
				if (rows.length === 0) {
					io.print(key === undefined ? "no provider has more than one account; /login adds one" : `${key} has no other account; /login adds one`);
					return;
				}
				if (!io.interactive) {
					io.print("usage: /accounts use <provider> <account>", "error");
					return;
				}
				const chosen = await io.prompt({
					type: "select",
					message: "Use account",
					options: rows.map(({ value, ...rest }) => ({ id: value, ...rest })),
				});
				const [, chosenKey = "", chosenAccount = ""] = chosen.split(" ");
				target = { key: chosenKey, account: chosenAccount };
			}
			const info = await auth.useAccount(target.key, target.account);
			io.print(`${target.key}: now using ${info.label ?? `account #${info.id}`} (#${info.id})`, "success");
		},
	};
}

export function modelCommand(bot: Bot, models: Models): SlashCommand {
	return {
		name: "model",
		description: "Show or switch the model and save it as the default",
		usage: "[provider/modelId]",
		surfaces: ["tui", "channel"],
		arguments: async (context, { channel, threadKey }) => (await modelArguments(bot, models, channel, threadKey, context)).rows,
		run: async (args, invocation) => {
			await switchModel(bot, models, invocation, args.trim());
		},
	};
}

/**
 * `/model`'s body, shared with `/setup`: with an empty `ref` an interactive surface picks from the available models
 * (`message` heads the picker) and a channel gets the listing. Returns the switched `provider/modelId`, or undefined when
 * nothing was switched (listing, no models).
 */
export async function switchModel(bot: Bot, models: Models, { channel, threadKey, context, io }: CommandInvocation, requested: string, message = "Choose a model"): Promise<string | undefined> {
	let ref = requested;
	if (ref === "") {
		const { current, rows } = await modelArguments(bot, models, channel, threadKey, context);
		if (io.interactive) {
			if (!rows.some((row) => !row.disabled)) {
				io.print(NO_MODELS, "error");
				return undefined;
			}
			ref = await io.prompt({
				type: "select",
				message,
				options: rows.map(({ value, ...rest }) => ({ id: value, ...rest })),
			});
		} else {
			io.print(modelListing(current, rows));
			return undefined;
		}
	}
	io.signal.throwIfAborted();
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) throw new Error(`expected provider/modelId, got "${ref}"`);
	const provider = ref.slice(0, slash);
	const modelId = ref.slice(slash + 1);
	if (models.getModel(provider, modelId) === undefined) throw new Error(`unknown model ${ref}`);
	if (!(await models.getAvailable(provider)).some((model) => model.id === modelId)) {
		throw new Error(`model ${ref} is not available; log in to ${provider} first`);
	}
	const conversation = await bot.conversation(channel, threadKey, context);
	const { previousThinkingLevel, ...reasoning } = await selectModel(bot.harness, models, conversation.id, { provider, modelId }, context, io.signal);
	io.state({ model: ref, ...reasoning });
	io.print(`model switched to ${ref}`, "success");
	if (previousThinkingLevel !== reasoning.thinkingLevel) {
		io.print(`reasoning adjusted from ${previousThinkingLevel} to ${reasoning.thinkingLevel} for ${ref}`);
	}
	return ref;
}

const NO_MODELS = "No models available. Run /login to connect a provider.";

/**
 * Available models as picker rows grouped by provider display name: the current model's provider first, then the
 * rest alphabetically; models keep pi-ai's order inside a group. A current model that is no longer available (its
 * provider was logged out or removed) stays listed as a disabled row, so the thread's model is never hidden.
 */
async function modelArguments(
	bot: Bot,
	models: Models,
	channel: string,
	threadKey: string,
	context: Context,
): Promise<{ current: string | undefined; rows: CommandArgument[] }> {
	const current = await currentModel(bot, channel, threadKey, context);
	const groups = new Map<string, CommandArgument[]>();
	for (const model of await models.getAvailable()) {
		const value = `${model.provider}/${model.id}`;
		const group = models.getProvider(model.provider)?.name || model.provider;
		const rows = groups.get(group) ?? [];
		rows.push({ value, label: model.name || model.id, description: value, group, ...(value === current ? { current: true } : {}) });
		groups.set(group, rows);
	}
	if (current !== undefined && ![...groups.values()].some((rows) => rows.some((row) => row.current))) {
		const slash = current.indexOf("/");
		const provider = current.slice(0, slash);
		const modelId = current.slice(slash + 1);
		const group = models.getProvider(provider)?.name || provider;
		const label = models.getModel(provider, modelId)?.name || modelId;
		const row: CommandArgument = { value: current, label, description: `not available; log in to ${group} first`, group, current: true, disabled: true };
		groups.set(group, [row, ...(groups.get(group) ?? [])]);
	}
	const rank = (rows: readonly CommandArgument[]) => (rows.some((row) => row.current) ? 0 : 1);
	const ordered = [...groups].sort(([a, rowsA], [b, rowsB]) => rank(rowsA) - rank(rowsB) || a.localeCompare(b));
	return { current, rows: ordered.flatMap(([, rows]) => rows) };
}

/** Plain-text `/model` listing for channels, readable in Slack. */
function modelListing(current: string | undefined, rows: readonly CommandArgument[]): string {
	const lines = [`current model: ${current ?? "(none)"}`];
	if (!rows.some((row) => !row.disabled)) lines.push(NO_MODELS);
	let group: string | undefined;
	for (const row of rows) {
		if (row.group !== group) {
			group = row.group;
			lines.push(group ?? "");
		}
		lines.push(`${row.current ? "  \u25cf " : "    "}${row.value}  ${row.label}${row.disabled ? `  (${row.description})` : ""}`);
	}
	return lines.join("\n");
}

export function pluginsCommand(plugins: readonly LoadedPlugin[]): SlashCommand {
	return {
		name: "plugins",
		description: "List the enabled plugins and their tools",
		surfaces: ["tui", "channel"],
		run: async (_args, { io }) => {
			io.print(
				plugins.length === 0
					? "no plugins enabled"
					: [
							"plugins:",
							...plugins.map((plugin) => `${plugin.id}: ${plugin.tools.map((tool) => tool.name).join(", ") || "(no tools)"}`),
						].join("\n"),
			);
		},
	};
}
