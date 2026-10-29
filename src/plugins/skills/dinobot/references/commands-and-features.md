# Slash commands and features

Source: src/commands/names.ts, src/commands/index.ts, src/commands/builtin.ts, src/commands/skills.ts,
src/commands/sessions.ts, src/commands/report.ts, src/commands/fast.ts, src/commands/reasoning.ts, src/commands/types.ts, src/tui/slash.ts,
src/tui/app.ts, src/core/channel-handler.ts, src/core/native-model-commands.ts, src/manifest.ts,
openwiki/architecture/slash-commands.md.

## Where slash commands run

The daemon implements slash commands, so every surface that uses the command registry runs the same code.

| Surface | What it gets |
| --- | --- |
| TUI (`dinobot`, over the loopback client API) | Every daemon command with surface `tui`, plus the TUI-local commands below. Interactive pickers and prompts |
| `http` channel | Daemon commands with surface `channel`. Output comes back as one text reply, with no prompts. A command that needs input answers "needs input; run it from the TUI" |
| Slack, Telegram, Discord (native messaging channels) | **Not** the daemon registry. Only the native controls `/model`, `/models` and `/new` are intercepted (src/core/native-model-commands.ts). Any other `/text` goes to the model as an ordinary message |

On the `http` channel, an unknown, disabled or TUI-only command answers `unknown command /x; try /help`. There,
`/model` is the daemon command, so it also saves the global default. The native `/model` on Slack, Telegram and Discord
changes only that thread or topic and saves no global default (see models.md).

## Daemon commands

`COMMAND_NAMES` (src/commands/names.ts): `accounts`, `fast`, `help`, `login`, `logout`, `model`, `plugins`,
`reasoning`, `report`, `search`, `sessions`, `skills`.

| Command | Args | Surfaces | What it does |
| --- | --- | --- | --- |
| `/help` | — | tui, channel | Lists the commands enabled on that surface |
| `/login` | `[provider]` | tui | Runs a provider login (OAuth, device code or key paste) and stores the credential in `<dataDir>/auth.json`. Logging in again with another account adds it to the rotation pool. With no argument, opens a provider picker |
| `/logout` | `[provider] [account]` | tui | Removes a stored credential, or one account of a pool (picker in the TUI; "All accounts" removes all) |
| `/accounts` | `[use <provider> <account>]` | tui | Lists account pools and their state (active, rate limited, usage limit, auth failed). `use` switches the active account |
| `/model` | `[provider/modelId]` | tui, channel | Switches this thread's model and saves it as the default for new conversations. With no argument, the TUI shows a picker and a channel gets a text list. Errors: `unknown model`, `not available; log in to <provider> first` |
| `/reasoning` | `[level\|cycle]` | tui, channel | Sets the reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, limited to what the model supports) and saves it as the default. Applies from the next model request |
| `/fast` | `[on\|off\|toggle]` | tui, channel | Fast (priority) service tier on or off, saved as the default. Applies from the next model request. Unavailable on models without it |
| `/plugins` | — | tui, channel | Enabled plugins and their tool names |
| `/search` | `<words>` | tui, channel | Full-text search over every thread's history (top 10 hits) |
| `/sessions` | — | tui, channel | What every thread is doing now and the work it has claimed. In the TUI the local `/sessions` browser takes this name |
| `/skills` | see below | tui, channel (partly) | Skill catalog and lifecycle |
| `/report` | `[note]` or a subcommand (below) | tui, channel | Sends this session to the dinobot developer for harness improvement, only after consent |

Model, reasoning, fast tier and accounts are covered in depth in models.md.

### `/report`: session reports

Source: src/commands/report.ts, src/report/, ADR 0073. Privacy policy: https://report.dinobot.workers.dev/privacy.
Nothing is sent without a consent receipt recorded by `/report setup`. The YAML config cannot turn reporting on.
`commands: { disabled: [report] }` removes the feature entirely.

| Subcommand | Surfaces | Effect |
| --- | --- | --- |
| *(none)* or `<note>` | tui: consent checklist if needed, then a preview (entry count, what was redacted, path of the exact file) and a send/cancel prompt. channel: builds a draft and shows `/report send <id>` | Manual report of the whole thread including subagents. Other participants' messages are removed on channels |
| `setup` | tui | Consent checklist. Required: collection, overseas transfer (Cloudflare), age 14+. Optional: automatic reports |
| `consent` / `agree <version>` | channel | Shows the notice. Records this person's consent when they type the exact version |
| `send <id>` / `cancel <id>` | channel | Send or drop a draft |
| `list` | tui, channel | Own reports and their status (pending, sent, failed, deleted) |
| `undo <id>` | tui, channel | Cancels a pending report, or deletes a sent one on the server |
| `withdraw` | tui (confirm prompt), channel (`withdraw confirm`) | Withdraws consent. TUI: every report of this install is erased on the server. Channel: that person's reports |
| `auto on\|off` | tui only | Automatic reports: when a TUI message contains profanity or strong frustration, a bounded report is scheduled. Scope: the last 10 turns, tool output capped at 2 KB. It is sent 30 s later and can be undone first. At most 1 per thread per 30 min and 10 per day. The TUI shows a notice with the id |
| `status` | tui, channel | Consent version and auto state |

Local state lives in `<dataDir>/report/` (`state.json`, mode 0600, and `outbox/`). Redaction runs on the client
before sending (`src/report/redact.ts`: secrets, Korean resident and card numbers, phones, emails, IPs, home paths)
and again on the server. `DINOBOT_REPORT_URL` points the daemon at another ingest endpoint (tests).

Problem reports with diagnostics (ADR 0103): the TUI's `/report` and the one-step `dinobot report send` add diagnostic
sections (system, runtime, install, config with secrets masked and file permissions, daemon probe, log tails, data
folder listing, channels, network checks, live daemon state, client context). `dinobot report` works without a running
daemon: `dinobot report consent`, `dinobot report agree <version> [--auto]`, `dinobot report send [--note <text>]
[--trigger button|cli|setup-failed|daemon-down|daemon-start-failed|crash] [--client cli|tui|desktop] [--context-file <path>]
[--thread <channel>:<thread>] [--offline] [--json]`, `dinobot report status`. Exit codes: 0 sent or pending, 1 failed,
2 usage or consent version mismatch, 3 consent required. The desktop app's "문제 보고" button runs the same command.

### `/skills` subcommands

Source: src/commands/skills.ts.

| Subcommand | Surfaces | Effect |
| --- | --- | --- |
| *(none)* | TUI: checklist to enable or disable skills. Channel: text list | Bundled skills are locked (always on) |
| `list` | tui, channel | Each skill with enabled state, provenance and estimated catalog tokens |
| `on <name>` / `off <name>` | tui only | Enable or disable for **new** conversations. Bundled skills cannot be turned off |
| `pending` | tui, channel | Unpublished proposals |
| `diff <id>` | tui, channel | A proposal's before and after |
| `history <name>` | tui, channel | Publication history |
| `publish <id>` / `reject <id>` | tui only | Manual publish or reject of a proposal |
| `archived` | tui, channel | Archived (disabled) skills |
| `archive <name>` / `restore <name>` | tui only | Reversible archive or restore |
| `pin <name>` / `unpin <name>` | tui only | Exempt from, or return to, automatic archive |
| `curator [status\|run\|dry-run]` | status and dry-run: both. run: tui only | Usage-based curator |
| `evolution [status\|pause\|kill\|resume]` | status: both. Others: tui only | Background skill research and review |
| `legacy` / `close-legacy <conversation>` | legacy: both. close-legacy: tui only | Unpinned legacy conversations |

Skill changes apply to **new conversations** (`/new`). The current conversation keeps its fixed skill set.

## TUI-local commands

These are handled by the TUI itself and never reach the daemon. They appear in the TUI dropdown and in the TUI's
`/help` (src/tui/slash.ts `LOCAL_COMMANDS`).

| Command | Args | What it does |
| --- | --- | --- |
| `/new` | `[name]` | Start a new thread |
| `/thread` | `<name>` | Switch to a thread |
| `/sessions` | — | Browse live sessions and attach to a conversation (`/threads` still works as a hidden alias) |
| `/agents` | `[id]` | Open a subagent's conversation |
| `/dag` | — | Show the DAG run's nodes (and research mission entries, when there is a mission) |
| `/theme` | `[rex\|ptero\|brachio\|tricera]` | Pick a dinosaur theme: the mascot species and brand colors (T-rex Signal, Pterodactyl Dusk, Brachiosaurus Fern, Triceratops Canyon). Saved to `~/.config/dinobot/tui.json`; `DINOBOT_THEME` overrides it for one run |
| `/choose` | — | Open the picker for an open question to a person that has 2-4 choices (it also opens once on its own after the turn ends) |
| `/quit` | — | Quit the TUI (`/exit` also works). The daemon keeps running |

## TUI @ context references

Typing `@` in the TUI prompt opens a dropdown of reference kinds and workspace files/folders (src/tui/context-refs.ts).
On send the TUI appends their content under `--- Attached Context ---`; channels never expand `@`.

| Reference | Attaches |
| --- | --- |
| `@file:path`, `@file:path:10-25` | File contents, or that line range |
| `@folder:path` | Directory tree with line counts (200 entries max) |
| `@diff`, `@staged` | `git diff`, `git diff --staged` |
| `@git:N` | Last N commits with patches (max 10) |

Over 25% of the model's context window warns; over 50% sends the message unexpanded. Paths outside the TUI's working
directory (symlinks included), `~/.ssh` and other credential files, `.env` files and the bot `dataDir` are refused with a
warning. Binary or oversized files are attached as an on-disk path pointer. `@url:` is not supported.

## Disabling commands

```yaml
commands:
  disabled: [login, logout, accounts]
```

- Only names from `COMMAND_NAMES` are allowed. Any other name fails boot with
  `commands.disabled: unknown command "<name>" (available: ...)`. TUI-local names such as `new` are not accepted.
- A disabled command disappears from every surface: the TUI dropdown, `/help`, the client API (list, run and
  arguments return 404) and channels.
- Disabling `reasoning` also disables the TUI's Shift+Tab reasoning cycle.
- Disabling `model` also blocks the native `/model` and `/models` on messaging channels (src/main.ts passes
  `enabled: commands.find("model", "channel") !== undefined`).
- When `login` is disabled, the daemon does not load the oh-my-pi login code, except to refresh existing OAuth
  credentials.

## Features

Each item is short. Follow the source pointer for details.

### Skills

Source: src/extensions/skills.ts, src/plugins/skills/, src/core/skills/, openwiki/architecture/skills.md, ADRs 0031,
0037 and 0038.

- **Sources:**
  - Bundled skills, always on: `programming`, `optimization`, `debugging`, `clarification`, `research`, `dinobot`.
  - Opt-in bundled formal verification skills with `plugins.skills.proofSkills: true` (see plugins.md).
  - External directories from `plugins.skills.dirs` (see plugins.md).
  - Agent-created skills.
- **Tools:** `skills_list`, `skills_load`, `skills_read_file`, `skills_inspect`, `skills_propose`, `skills_diff`,
  `skills_publish`, `skills_history`, `skills_restore`, `skills_archive`, `skills_unarchive`,
  `skills_curation_status`. In `codemode-only` they are called as `tools.skills_*` inside codemode.
- **Agent-created skills:** the agent proposes a full package with `skills_propose`. Proposals are approved
  automatically, and `skills_publish` installs one as the default for new conversations. Skills are immutable and
  versioned, and source files are never overwritten.
- **Curation:** unused agent-created skills are archived automatically. This is on by default and configured in the
  top-level `curation:` block:
  - `enabled` (default `true`), `alpha` (0.05), `pMax` (0.02), `minIdleMs` (14 days), `settleMs` (1 h), `intervalMs`
    (6 h), `includeUser` (false), `includeBundled` (false). Defaults are in src/core/skills/curation.ts.
  - Archive is reversible: use `/skills restore` or `skills_unarchive`.
- **Skill evolution:** the top-level `skillEvolution:` block controls background skill research and review. Most of
  the statistical path is off by default: `observe`, `evaluate`, `autoPublish`, `deactivate` and `physicalGc`
  default to false, and `sessionPinning` defaults to true. Background `review` is **on by default** (with
  `author: true` and finite default budgets, $2/day); turn it off with `skillEvolution: { review: false }`.
  See src/core/skills/evolution-config.ts. Status: `/skills evolution`.

### Memory

Source: src/extensions/memory.ts, src/core/memory/config.ts, src/core/memory/, openwiki/decisions/0050-project-memory.md,
openwiki/decisions/0076-work-retrospectives-and-working-agreements.md,
openwiki/decisions/0095-memory-supersede-provenance-merge.md.

- **Tools:** `memory_read`, `memory_write`, `memory_delete`, `memory_list`, `memory_search`; working agreements:
  `agreements_list`, `agreements_write`, `agreements_delete`.
- **Scopes:** each entry has a `scope`:
  - `team` (default) is shared by the whole deployment.
  - `project` is per git repository (the main worktree root of the conversation's working directory).
  - `list` and `search` cover both by default.
- **Automatic extraction:** a background curator extracts project memories every N user turns into `auto/<hash>`
  keys. A deleted `auto/` key stays forgotten. A newer extraction may supersede automatic memories it contradicts, or
  merge overlapping ones when the project nears `maxPerProject`; superseded keys are forgotten too. Memories a person
  wrote are never superseded (a contradicting extraction is dropped).
- **Provenance:** entries carry `createdAt`/`updatedAt`, and automatic ones the `evidence` windows (conversation id,
  user turn) they came from; `memory_read` shows them and recall notes add `saved YYYY-MM-DD`. Entries stored before
  this lack the fields.
- **Recall:** relevant project memories are attached before a new input as a `[dinobot memory]` note. The TUI shows
  "Recalled N project memories".
- **Working agreements:** short standing instructions (`preference` or `lesson`, scope `project` or `team`) that
  every request of the project carries in its `working_agreements` section. A changed agreement reaches a running
  conversation at its next model request; the TUI shows "Working agreements: N in effect". A person's agreements
  (`agreements_write`) are never reworded or removed by a retrospective; a deleted one is not re-added.
- **Retrospectives:** a background review of a thread's recent turns and its Harness record (work plans, repairs,
  failed checks, outcomes), given as layered evidence (overview, findings citing `[eN]`/`[hN]` refs with short quotes, labelled raw
  lines; src/core/memory/evidence.ts; findings: tool_error, check_failed, repeated_failure, loop, truncated,
  skill_unavailable, skill_unapplied, harness; failing tests are check_failed, not tool errors), adds, reinforces (`violated`, flagged `needs-human` after the limit), retires
  or merges (`merge`: overlapping retro items of one scope into one, so a full scope can learn again; never a person's
  items) agreements. It runs when `work_finish` or a DAG run ends verified/blocked (at the end of that input), every
  `everyTurns` user turns, or after `idleMinutes` without input.
- **Config:** all three loops are **on** even without a `memory` block.
  - `memory.auto`: `enabled`, `everyTurns` (default 6, range 1 to 1000), `model` (`inherit` or `provider/modelId`),
    `maxRetries` (2), `leaseMs` (300000, must exceed 2 × `timeoutMs`), `timeoutMs` (120000), `maxPerProject` (200,
    max 800).
  - `memory.recall`: `enabled`, `maxItems` (3, range 1 to 10), `budgetChars` (1200, range 80 to 8000).
  - `memory.retro`: `enabled`, `everyTurns` (6), `idleMinutes` (15), `model`, `maxRetries` (2), `leaseMs` (300000,
    must exceed 2 × `timeoutMs`), `timeoutMs` (120000), `maxActivePerProject` (20), `maxActiveTeam` (10),
    `escalateAfterViolations` (3).
  - Turn a loop off with `memory: { auto: { enabled: false } }`, `memory: { recall: { enabled: false } }` or
    `memory: { retro: { enabled: false } }`. The agreement section and tools stay available.

### Subagents and custom agents

Source: src/extensions/subagents.ts, openwiki/architecture/subagents.md, ADR 0008.

- **Tools:** `task` (`description`, `prompt`, optional `subagent_type`, `model`, `run_in_background`),
  `task_output` and `kill_task`. They are available in every tool mode.
- **Built-in types:** `general-purpose` (the default) and `explore` (read-only investigation).
- **Custom agents:** set `agents: { dirs: [...] }` in the manifest. Every `**/*.md` file with frontmatter is read:
  - `name` (required; must not start with `-` or contain `:`) and `description` (required).
  - Optional `tools` (comma string or list) and `model` (`inherit`, `provider/modelId` or `modelId`).
  - The body becomes the subagent's instructions.
  - Files with no frontmatter or no `name` are skipped. Invalid definitions or duplicate names fail boot.
- Subagents cannot spawn subagents (`task`, `task_output`, `kill_task` and `answer` are always removed). In the TUI,
  `/agents` opens a subagent's conversation.

### DAG orchestration, ask and todo

Source: src/extensions/dag.ts, src/core/plan.ts, src/core/dag.ts, src/extensions/ask.ts, src/extensions/todo.ts,
src/extensions/goal.ts, src/core/goal.ts, openwiki/architecture/goal.md,
openwiki/architecture/dag-and-ask.md, openwiki/architecture/todo-write.md, ADR 0030.

- `dag_run` compiles a finite plan, with structural checks such as acyclicity, coverage and race freedom (at most 256
  nodes). `dag_step` dispatches ready nodes as subagents or checks, and `dag_status` reads the run. Subagents raise
  questions with `ask`. The TUI shows runs in its DAG pane and through `/dag`.
- `todo_write` keeps one durable todo list per conversation (merged by id; `merge: false` replaces the list). The TUI
  shows it above the input; Ctrl+T focuses it. There is no manifest setting for it.
- `goal_set`, `goal_update` and `goal_read` keep one durable goal per conversation: an objective plus criteria that
  each carry a numeric, binary or rubric check. The goal is re-rendered into every request, so it survives context
  compaction and restarts, and subagents see their orchestrator's goal read-only. The bundled `clarification` skill
  asks only through `ask`, never for approval, and ends in `goal_set`. There is no manifest setting for it.

### Research missions

Source: src/extensions/research.ts, src/core/research*.ts, openwiki/decisions/0033-bounded-research-skill.md,
0034-durable-research-missions.md.

- The bundled `research` skill handles bounded, evidence-based investigation and writes its records in the target
  project's `.dinobot/research/`.
- Durable missions are started explicitly with `research_start` and controlled only with `research_status` and
  `research_cancel`. They run on the DAG executor, and the TUI's `/dag` lists mission entries.
- Code-experiment missions need a host profile in the manifest under `research.codeProfiles.<id>`. The fields are
  `executable`, `argv`, `cwdPolicy: candidate`, `environmentAllowlist`, `timeoutMs`, `resultSchema`, `baseCommit`,
  `permittedPaths`, plus optional `readiness`. See the `ResearchCommandShape` schema in src/manifest.ts.

### Session awareness

Source: src/extensions/sessions.ts, src/core/sessions.ts, src/core/search.ts, src/core/claims.ts,
openwiki/architecture/session-awareness.md.

- **Model tools:** `session_search` (past messages in every thread), `session_list` (live status of every thread),
  `session_read` (recent messages of one thread), `session_analyze` (diagnose a concrete problem in one session),
  and `work_claim` / `work_release` (claims on shared resources with a TTL).
- **For people:** `/search <words>` and `/sessions`.
- There is no manifest setting.

### LSP

Source: src/extensions/lsp.ts, src/core/lsp.ts, openwiki/architecture/lsp.md.

- The `lsp` tool is read-only. Operations: `status`, `hover`, `definition`, `references`, `document_symbols`,
  `workspace_symbols` and `diagnostics`.
- It is always registered. Servers start lazily from locally installed executables (project `node_modules/.bin`
  first, then `PATH`). Nothing is installed automatically.
- Positions you pass in are 1-based UTF-16; returned ranges are 0-based.
- Manifest `lsp:` block:
  - `timeoutMs` (100 to 30000).
  - `servers[]`, each with `name`, `command` (argv), `extensions` (e.g. `.ts`), and optional `languageId`,
    `rootMarkers`, `initializationOptions` and `settings`. Duplicate names are an error.
- The default server list is in src/core/lsp.ts.

### Tool modes and codemode

Source: src/core/toolmode.ts, src/extensions/codemode.ts, src/extensions/tool-search.ts,
openwiki/architecture/tool-modes.md, codemode-sandbox.md, ADRs 0012 and 0019.

`bot.toolMode` (required) selects one of:

| Mode | Model sees | Codemode |
| --- | --- | --- |
| `direct` | built-in tools and plugin tools | not installed |
| `hybrid` | built-in tools, plugin tools, and `codemode` / `codemode_status` | can call every allowed tool |
| `codemode-only` (default manifest) | built-in tools and `codemode` / `codemode_status`; plugin, skill and research tool declarations are hidden | the **only** way to call plugin and skill tools |

- Codemode runs JavaScript in a Bun Worker and calls tools as `await tools.NAME(args)`. Cells are limited to 60 s and
  256 calls, and each internal call is its own durable task.
- `tool_search` returns exact tool contracts.
- In `codemode-only`, a direct call to a plugin or skill tool is blocked with "Plugin and skill tools must be called
  through codemode".
