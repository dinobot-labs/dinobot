import type { Context } from "@earendil-works/chord";
import type { AuthEvent, AuthPrompt, ModelThinkingLevel } from "@earendil-works/pi-ai";

/**
 * Slash commands run inside the daemon, so the TUI (over the client API) and every
 * channel (Slack, Teams, HTTP) execute the same implementation.
 *
 *   tui      the local owner's terminal over the loopback client API; interactive
 *   channel  a messenger thread; output is collected into one reply, no prompts
 */
export type Surface = "tui" | "channel";

/** Authoritative model, effective reasoning and effective fast-tier configuration for a thread. */
export type ThreadModelState = {
	readonly model: string;
	readonly thinkingLevel: ModelThinkingLevel;
	readonly supportedThinkingLevels: readonly ModelThinkingLevel[];
	readonly fast: boolean;
	readonly fastSupported: boolean;
	/** False when the model's provider has no credential yet (fresh install); the TUI then opens /login. Absent from older daemons. */
	readonly signedIn?: boolean;
	/** The model's catalog context window in tokens (what the context meter divides by). Absent for models outside the catalog and from older daemons. */
	readonly contextWindow?: number;
	/** The model's catalog output-token limit. Absent for models outside the catalog and from older daemons. */
	readonly maxTokens?: number;
};

/**
 * One completion value for a command's first argument (a provider id, a model ref, ...). Arguments keep their
 * order; rows sharing a `group` are contiguous.
 */
export type CommandArgument = {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
	/** Section heading the picker groups the row under, e.g. a provider name. */
	readonly group?: string;
	/** The row is the thread's current value. */
	readonly current?: boolean;
	/** Short right-edge tag such as "logged in". */
	readonly badge?: string;
	/** Shown but not choosable right now; `description` says why. */
	readonly disabled?: boolean;
};

/** One row of a select prompt; same extras as `CommandArgument`. */
export type CommandSelectOption = {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly group?: string;
	readonly current?: boolean;
	readonly badge?: string;
	/** A gray metadata tag drawn right-aligned like `current` (e.g. an ask's `default` choice); the label is clipped before it. */
	readonly tag?: string;
	readonly disabled?: boolean;
};

/** A select prompt a command raises itself; pi-ai's own `select` prompts are a subset of it. */
export type CommandSelectPrompt = {
	readonly type: "select";
	readonly message: string;
	readonly options: readonly CommandSelectOption[];
	/** Choosing a row starts a provider login: the TUI follows the rest of the flow on its login card. */
	readonly login?: boolean;
	readonly signal?: AbortSignal;
};

/** One row of a checklist prompt; `disabled` means locked: shown with its checked state, never toggleable. */
export type CommandChecklistOption = CommandSelectOption & { readonly checked: boolean };

/** A multi-select prompt; it resolves with a JSON string array of the checked option ids. */
export type CommandChecklistPrompt = {
	readonly type: "checklist";
	readonly message: string;
	readonly options: readonly CommandChecklistOption[];
	readonly signal?: AbortSignal;
};

/**
 * A manifest change `/setup` asks the local front end to apply. The TUI owns the whole transaction (validate, compare-and-swap
 * write with a `.bak`, safe daemon restart, rollback) because the daemon cannot restart itself and observe the result.
 */
export type ManifestApplyRequest = {
	/** Absolute path of the manifest the daemon booted from. */
	readonly manifestPath: string;
	/** sha256 of the manifest text the candidate was derived from; the write is refused when the file changed since. */
	readonly baseSha256: string;
	readonly candidate: string;
	/** One line per changed entry, e.g. `+ channels.telegram`. */
	readonly changes: readonly string[];
	/** Shown after a successful restart. */
	readonly summary: readonly string[];
	/** Locale the copy of the outcome should use. */
	readonly locale: string;
};

/** What a command may show while it runs. Login flows reuse pi-ai's auth events and prompts as-is. */
export type CommandEvent =
	| { readonly type: "apply"; readonly request: ManifestApplyRequest }
	| { readonly type: "started"; readonly runId: string }
	| { readonly type: "output"; readonly text: string; readonly level: "info" | "success" | "error" }
	| { readonly type: "auth"; readonly event: AuthEvent }
	| { readonly type: "prompt"; readonly id: string; readonly prompt: CommandPromptSpec }
	/** The thread's state changed in a way the front end shows, e.g. `/model` switched the model. */
	| ({ readonly type: "state" } & Partial<ThreadModelState>)
	| { readonly type: "done" }
	| { readonly type: "error"; readonly message: string };

/** A pi-ai `AuthPrompt` without its per-prompt signal, which does not cross the wire. */
export type CommandPromptSpec =
	| { readonly type: "text" | "secret" | "manual_code"; readonly message: string; readonly placeholder?: string }
	| {
			readonly type: "select";
			readonly message: string;
			readonly options: readonly CommandSelectOption[];
			readonly login?: boolean;
	  }
	| {
			readonly type: "checklist";
			readonly message: string;
			readonly options: readonly CommandChecklistOption[];
	  };

export interface CommandIO {
	readonly signal: AbortSignal;
	/** False on channels: `prompt` rejects there, so commands that need input must check this first. */
	readonly interactive: boolean;
	print(text: string, level?: "info" | "success" | "error"): void;
	notify(event: AuthEvent): void;
	/**
	 * Resolves with the answer (`select` resolves the option id, `checklist` a JSON string array of checked ids);
	 * rejects on cancel, abort, or a non-interactive surface.
	 */
	prompt(prompt: AuthPrompt | CommandSelectPrompt | CommandChecklistPrompt): Promise<string>;
	state(change: Partial<ThreadModelState>): void;
	/** Hand a manifest change to the front end after the run ends; absent where no front end can apply one (channels, tests). */
	apply?(request: ManifestApplyRequest): void;
}

export type CommandInvocation = {
	readonly surface: Surface;
	readonly channel: string;
	readonly threadKey: string;
	readonly userId: string;
	/** The front end's locale (`ko_KR.UTF-8`, `en_US`, ...) when it sent one. */
	readonly locale?: string;
	readonly context: Context;
	readonly io: CommandIO;
};

export interface SlashCommand {
	/** Lowercase, no leading slash. */
	readonly name: string;
	readonly description: string;
	/** Argument hint shown after the name, e.g. "[provider]". */
	readonly usage?: string;
	/** Surfaces the command exists on. A command never appears, in any listing, on a surface not named here. */
	readonly surfaces: readonly Surface[];
	arguments?(context: Context, scope: { readonly channel: string; readonly threadKey: string }): Promise<readonly CommandArgument[]>;
	run(args: string, invocation: CommandInvocation): Promise<void>;
}

/** Public description of a command, as `GET /v1/commands` returns it. */
export type CommandInfo = { readonly name: string; readonly description: string; readonly usage?: string };
