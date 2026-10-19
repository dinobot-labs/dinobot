# dinobot.yaml — customer manifest reference

The manifest is one YAML file that configures a whole deployment: model, tool mode, channels,
plugins, skills, memory and LSP. The schema and validation live in `src/manifest.ts`. An annotated
example is in `dinobot.example.yaml`.

## 1. Where it is read from, and when

Source: `src/main.ts` (`resolveManifestPath`, `USAGE`), `src/cli/default-manifest.ts`, `src/tui/daemon.ts`

The first match wins:

1. `--config <path>` (short `-c`)
2. `$DINOBOT_CONFIG`
3. `./dinobot.yaml` in the current directory
4. `~/.config/dinobot/dinobot.yaml`. If the file does not exist, dinobot creates it with the defaults below. It never overwrites an existing file.

`dinobot serve` prints `dinobot: created <path>; sign in to a model with /login` when it creates the file. The TUI says nothing, because it offers `/login` itself.

First-run default (`defaultManifest`):

```yaml
bot:
  enabled: true
  dataDir: "<home>/.local/share/dinobot"
  model:
    provider: anthropic
    modelId: claude-sonnet-4-6
  toolMode: codemode-only
api:                # loopback client API for `dinobot tui`
  port: 8786
channels: {}
plugins: {}         # web search is on by default; `web: false` turns it off
```

`dinobot init` can also create this file. `dinobot update` and `dinobot telegram …` run without loading a manifest.

**When changes take effect.** The manifest is parsed once, when the process starts (`loadManifest` in `src/main.ts`):

- `dinobot serve` (the daemon) uses it to open storage, channels, plugins and the client API.
- `dinobot tui` also parses and validates it, so a bad manifest makes the TUI fail too. The TUI then connects to `http://127.0.0.1:<api.port>`. If something healthy already answers there, the TUI uses that daemon unchanged. Only when nothing answers does it start `dinobot serve --config <same path>` in the background. The daemon log is `<dataDir>/dinobot.log`. The TUI waits up to 15 s for the daemon to come up.
- **So, to apply a manifest edit, stop the running daemon and start it again.** Restarting only the TUI is not enough while the old daemon is still up. The TUI's own hint for this is `pkill -f 'dinobot serve'`, then open dinobot again (`src/tui/app.ts`).
- The TUI requires an `api` section. Without one it fails with `… has no api section; add api: { port: 8786 } to use the TUI`.
- With no subcommand, dinobot runs `tui` when stdin and stdout are a TTY, and `serve` otherwise.

## 2. Top-level keys

Source: `src/manifest.ts` (`ManifestShape`)

| Key | Type | Required | Notes |
|---|---|---|---|
| `bot` | object | yes | Core settings (§2.1) |
| `api` | object | no | Loopback client API. Without it, no local front end (TUI) can attach |
| `providers` | map | no | Provider id → user-defined OpenAI-compatible model provider (§2.12) |
| `channels` | map | **yes** (may be `{}`) | Channel id → config (§2.3) |
| `plugins` | map | **yes** (may be `{}`) | Plugin id → config (§2.4) |
| `skillEvolution` | object | no | Opt-in skill research and background review (§2.5) |
| `curation` | object | no | Archiving of unused agent-created skills; on by default (§2.6) |
| `memory` | object | no | Project memory extraction and recall; on by default (§2.7) |
| `research` | object | no | `codeProfiles` for code experiments (§2.8) |
| `agents` | object | no | Directories with subagent definitions (§2.9) |
| `lsp` | object | no | Language-server timeout and server list (§2.10) |
| `commands` | object | no | `disabled` slash commands (§2.11) |

### 2.1 `bot` (required)

| Field | Type | Req. | Allowed values | Effect |
|---|---|---|---|---|
| `enabled` | boolean | yes | | `false`: the process prints `dinobot disabled by <path>` and exits with code 0; nothing starts |
| `dataDir` | string, min length 1 | yes | | Directory for durable state (§4). Created with `mkdir -p` at daemon start |
| `workspaceRoot` | string, min length 1 | no | | Default working directory for file and shell tools. If omitted, new local TUI threads use the TUI's start directory and other channels use the daemon's start directory. Resumed threads keep their original directory. This is not a permission boundary |
| `model.provider` | string, min length 1 | yes | example: `anthropic`, `openai` | Default model for new conversations |
| `model.modelId` | string, min length 1 | yes | e.g. `claude-sonnet-4-6` | |
| `toolMode` | enum | yes | `direct`, `hybrid`, `codemode-only` | How tools are exposed to the model (table below) |
| `promptProfile` | enum | no | `full` (default), `task` | System prompt profile. `task` is for headless single-task runs (HTTP/CLI automation, benchmarks): it drops the messaging, memory, skills, collaboration, ask, DAG, goal and todo guidance, uses a short autonomous-task preamble and ends with a completion checklist. Tools are unchanged |

`bot.model` is only the default for new conversations. Once a model is picked with `/model`, that
persisted choice wins, and it survives restarts. Existing conversations keep their own model.
Source: `openwiki/contracts/customer-manifest.md`.

`toolMode` (source: `src/core/toolmode.ts`, `openwiki/architecture/tool-modes.md`):

| Mode | What the model sees | codemode |
|---|---|---|
| `direct` | Built-in tools and plugin tools | Not installed |
| `hybrid` | Built-in tools, plugin tools, and `codemode`/status | Has every tool this conversation is allowed |
| `codemode-only` | Built-in tools and `codemode`/status. Plugin, skills, skill-evolution and research tool declarations are hidden | Has every allowed tool. A direct call to one of the hidden tools is blocked with "Plugin and skill tools must be called through codemode" |

### 2.2 `api` (optional)

| Field | Type | Req. | Range | Effect |
|---|---|---|---|---|
| `port` | integer | yes (if `api` is present) | 1–65535 | Loopback client API port used by `dinobot tui` (the TUI connects to `127.0.0.1:<port>`) |

### 2.3 `channels` (required map)

Source: `src/manifest.ts`, `src/channels/index.ts`

- Each key is a channel id from this build's catalog: `slack`, `discord`, `telegram`, `http`. Any other key is an error: `channels.<key>: unknown channel (available: …)`.
- Each value is checked against that channel's own schema. Problems are reported as `channels.<key>/<path>: …`.
- A channel is on only if it is listed. Use `channels: {}` for a TUI-only setup.
- `http` has one field, `port` (integer 1–65535). It is loopback only.
- For the fields of each channel, see **channels-and-cli.md**.

### 2.4 `plugins` (required map)

Source: `src/manifest.ts`, `src/plugins/index.ts`, `src/plugins/skills/index.ts`, `src/plugins/web/index.ts`, `src/plugins/image_gen/index.ts`

- Catalog ids: `aside`, `computer`, `github`, `google`, `image_gen`, `mcp`, `skills`, `web`. An unknown id is an error: `plugins.<id>: unknown plugin (available: …)`. Only real own keys are matched, so a key like `toString` does not count as a plugin.
- Each listed plugin is loaded with its config at boot. Load failures (for example an MCP connection failure or a bad SKILL.md) become manifest problems.
- **Default-on plugins.** A plugin marked `enabledByDefault` is loaded with `{}` even when it is not listed. In this build that is `image_gen` and `web`. `image_gen: false` and `web: false` turn them off. `false` for any other plugin is a config error.
- **`skills`** is always added with `{}` when you do not list it, so the built-in skills are always present. List `skills:` only to add `dirs`.
- Every other plugin is off unless listed.
- For the fields of each plugin (`web`, `image_gen`, `github`, `google`, `mcp`, `skills`, `computer`), see **plugins.md**.

### 2.5 `skillEvolution` (optional)

Source: `src/core/skills/evolution-config.ts`. The object and each sub-object have `additionalProperties: false`.

| Field | Type | Default | Must also have |
|---|---|---|---|
| `sessionPinning` | boolean | `true` | Must stay on when `author`, `evaluate` or `autoPublish` is on |
| `observe` | boolean | `false` | When on, opens `<dataDir>/skill-observations.sqlite` |
| `author` | boolean | `true` while review is on by default, else `false` | `observe` **or** `review`, plus `budgets` |
| `evaluate` | boolean | `false` | `author`, `budgets`, `confirmation` |
| `autoPublish` | boolean | `false` | `evaluate`, `confirmation` |
| `deactivate` | boolean | `false` | `autoPublish` |
| `physicalGc` | boolean | `false` | `deactivate` |

`budgets` is optional, but when present all six fields are required:

| Field | Range |
|---|---|
| `maxPending` | 1–32 |
| `maxCalls` | 1–8 |
| `maxOutputTokens` | 1–32768 |
| `timeoutMs` | 1–300000 |
| `dailyMicroUsd` | integer ≥ 1 |
| `jobMicroUsd` | integer ≥ 1, and ≤ `dailyMicroUsd` |

`review` is the background review mode and is **on by default**: with no `skillEvolution` (or none of
`review`, `author: false`, `sessionPinning: false`, `observe`, `evaluate`, `autoPublish`), it resolves to
`review: {}` with `author: true` and `REVIEW_BUDGET_DEFAULTS` (`maxPending 2, maxCalls 4,
maxOutputTokens 8000, timeoutMs 120000, dailyMicroUsd 2000000, jobMicroUsd 400000`). Naming `review`
also defaults `author` and `budgets`; configured values win. `review: false` (or `author: false`) turns
it off. In review mode, `dailyMicroUsd` refills in fixed 24 h windows (`REVIEW_BUDGET_WINDOW_MS`).

| Field | Type | Default | Range |
|---|---|---|---|
| `publish` | boolean | `true` | Installs authored candidates (reversible, unverified) |
| `intervalMs` | integer | `21600000` (6 h) | 60000–2147483647 |
| `minConversations` | integer | `5` | 1–1000 |
| `maxConversations` | integer | `20` | 1–200, and ≥ `minConversations` |
| `maxPublishesPerDay` | integer | `3` | 0–100 |

`confirmation` is optional; when present all four fields are required: `contractId` (non-empty),
`anchorManifest` (64 lowercase hex characters), `environmentRevision` (non-empty) and `sloEvidenceId`
(non-empty). The parsed config is not the whole story: the referenced evidence is also checked when
work is admitted.

### 2.6 `curation` (optional; on by default)

Source: `src/core/skills/curation.ts` (`CURATION_DEFAULTS`, `skillCurationConfig`). `additionalProperties: false`.

| Field | Type | Default | Range | Effect |
|---|---|---|---|---|
| `enabled` | boolean | `true` | | Runs the curator once at startup, then every `intervalMs` |
| `alpha` | number | `0.05` | (0, 1), exclusive | Bound on the chance of wrongly archiving a skill that is used with probability ≥ `pMax` |
| `pMax` | number | `0.02` | (0, 1), exclusive | |
| `minIdleMs` | integer | `1209600000` (14 d) | ≥ 0 | Minimum idle time before a skill can be archived |
| `settleMs` | integer | `3600000` (1 h) | ≥ 0 | A root conversation counts as an exposure only after this age |
| `intervalMs` | integer | `21600000` (6 h) | 60000–2147483647 | Time between curator runs |
| `includeUser` | boolean | `false` | | Also curate owner- or user-created skills |
| `includeBundled` | boolean | `false` | | Also curate bundled skills |

A skill is archived after **L\* = ceil(ln(alpha)/ln(1−pMax))** use-free root exposures (149 with the
defaults) **and** at least `minIdleMs` idle. Pinned skills are exempt. Archiving is reversible: packages
and history are kept.

### 2.7 `memory` (optional; both loops on by default)

Source: `src/core/memory/config.ts`. The object, `auto` and `recall` all have `additionalProperties: false`.

`auto` extracts project facts in the background:

| Field | Type | Default | Range | Effect |
|---|---|---|---|---|
| `enabled` | boolean | `true` | | Extraction runs once every `everyTurns` user turns of a thread |
| `everyTurns` | integer | `6` | 1–1000 | |
| `model` | string | `inherit` | `inherit` or `provider/modelId` | Model used for extraction. `inherit` means the conversation's own model. Any other form is an error |
| `maxRetries` | integer | `2` | 0–10 | |
| `leaseMs` | integer | `300000` | ≥ 10000 | **Must be greater than 2 × `timeoutMs`** |
| `timeoutMs` | integer | `120000` | ≥ 1000 | |
| `maxPerProject` | integer | `200` | 1–800 | |

`recall` adds relevant memory to a thread as a `[dinobot memory]` note:

| Field | Type | Default | Range |
|---|---|---|---|
| `enabled` | boolean | `true` | |
| `maxItems` | integer | `3` | 1–10 |
| `budgetChars` | integer | `1200` | 80–8000 |

### 2.8 `research.codeProfiles` (optional)

Source: `src/manifest.ts` (`ResearchCommandShape`). `research` and each profile have `additionalProperties: false`.

`codeProfiles` is a map. Each key must match `^[a-z][a-z0-9-]{0,63}$`. Each value has these fields:

| Field | Type | Req. | Constraint |
|---|---|---|---|
| `executable` | string | yes | Length 1–4096 |
| `argv` | string[] | yes | At most 64 items, each ≤ 4096 characters |
| `cwdPolicy` | literal | yes | `candidate` |
| `environmentAllowlist` | string[] | yes | Environment variable names (`^[A-Za-z_][A-Za-z0-9_]*$`), at most 32, unique |
| `timeoutMs` | integer | yes | 1–3600000 |
| `resultSchema` | literal | yes | `research-numeric-v1` or `research-numeric-v2` |
| `readiness` | object | no | `{preflight, canary}`. Each has `argv` (1–64 items) and `checkIds` (1–32 unique strings, each 1–128 characters) |
| `baseCommit` | string | yes | 40 lowercase hex characters |
| `permittedPaths` | string[] | yes | 1–32 unique items, each 1–1024 characters |

Every command stage (the main command, preflight and canary) is also checked by `validateCodeExperiment`
(see `src/core/research-experiments.ts`). Failures are reported as `research.codeProfiles.<id>: …`.

### 2.9 `agents.dirs` (optional)

Source: `src/extensions/subagents.ts` (`loadAgents`, `parseAgent`)

- `dirs` is a string array with at least one entry. Every `**/*.md` file under each directory is scanned, in sorted order.
- A file without YAML frontmatter, or whose frontmatter has no `name`, is treated as documentation and skipped.
- Frontmatter fields:
  - `name` (required, non-empty; cannot start with `-` or contain `:`)
  - `description` (required, non-empty)
  - `tools` (optional; a comma-separated string or a string list, used as an allowlist)
  - `model` (optional string: `inherit`, `provider/modelId`, or a bare `modelId`, which inherits the parent's provider)
- The file body is the agent's prompt.
- Each name becomes a `subagent_type` of `task`, alongside the built-in `general-purpose` and `explore`.
- Malformed files and duplicate names are reported under `agents: …`.

### 2.10 `lsp` (optional)

Source: `src/manifest.ts`, `src/core/lsp.ts`

| Field | Type | Default | Range | Effect |
|---|---|---|---|---|
| `timeoutMs` | integer | `15000` | 100–30000 | Time limit for each LSP operation |
| `servers` | array | built-in list | | If omitted, the built-in list is used. An explicit list **replaces** the defaults. `[]` disables every server, but the `lsp` status tool stays |

Built-in list: `typescript`, `python`, `rust`, `go`, `clang`.

| Server | Command |
|---|---|
| `typescript` | `typescript-language-server --stdio`. With the default list only, a native TypeScript 7 `tsc --lsp --stdio` is used instead when one is found |
| `python` | `pyright-langserver --stdio` |
| `rust` | `rust-analyzer` |
| `go` | `gopls` |
| `clang` | `clangd` |

Nothing is ever downloaded.

Fields of each server entry:

| Field | Type | Req. | Constraint |
|---|---|---|---|
| `name` | string | yes | Non-empty and unique (a duplicate is a boot error) |
| `command` | string[] | yes | argv with at least one item. This is not a shell string; it runs with the daemon's privileges |
| `extensions` | string[] | yes | At least one, each matching `^\.[a-zA-Z0-9]+$` (for example `.ts`) |
| `languageId` | string | no | |
| `rootMarkers` | string[] | no | Relative paths only, no `..` (checked when the LSP manager is built) |
| `initializationOptions` | object | no | Free-form |
| `settings` | object | no | Free-form |

### 2.11 `commands.disabled` (optional)

Source: `src/manifest.ts`, `src/commands/names.ts`

`disabled` is a string array, required when `commands` is present. Valid names: `accounts`, `fast`,
`help`, `login`, `logout`, `model`, `plugins`, `reasoning`, `search`, `sessions`, `skills`.

An unknown name (for example a typo) is an error. A disabled command is hidden everywhere: the TUI
dropdown, `/help`, the client API and channels. Disabling `reasoning` also turns off its TUI shortcut.
Customer builds often use `[login, logout]`.

### 2.12 `providers` (optional): custom OpenAI-compatible model providers

Source: `src/auth/custom-providers.ts`, `src/auth/index.ts`, ADR 0098

Adds a model provider for any endpoint that speaks the OpenAI Chat Completions API (a router, gateway or
self-hosted server). The map key is the provider id: the `provider` half of `provider/modelId`.

```yaml
providers:
  axwith:
    name: AXwith Router                       # display name; default: the id
    baseUrl: https://router.axwith.com/api/v1 # requests go to <baseUrl>/chat/completions
    # apiKeyEnv: AXWITH_API_KEY               # default: <ID>_API_KEY
    models:
      - id: opencodex/google-antigravity/gemini-4-argon
        name: Gemini 4 Argon
        # contextWindow: 128000  maxTokens: 16384  reasoning: false  input: [text]
```

| Field | Type | Req. | Default | Notes |
|---|---|---|---|---|
| `name` | string | no | the id | Shown in `/login` and `/model` |
| `baseUrl` | string | yes | | Must start with `http://` or `https://`; a trailing `/` is dropped |
| `apiKeyEnv` | env var name | no | `<ID>_API_KEY` (non-alphanumerics → `_`) | Read in the daemon's environment when no key is stored |
| `headers` | map string → string | no | | Extra headers on every request. Not for secrets |
| `models` | array, ≥ 1 | yes | | Model ids may contain `/` |
| `models[].id` | string | yes | | Unique within the provider |
| `models[].name` | string | no | the id | |
| `models[].reasoning` | boolean | no | `false` | Turn on for models that accept a reasoning effort |
| `models[].input` | `[text]` or `[text, image]` | no | `[text]` | Add `image` only for vision models |
| `models[].contextWindow` | integer ≥ 1 | no | `128000` | |
| `models[].maxTokens` | integer ≥ 1 | no | `16384` | |
| `models[].compat` | object | no | auto-detected from `baseUrl` | pi-ai `OpenAICompletionsCompat` overrides (e.g. `maxTokensField`, `supportsDeveloperRole`) |

- **The key never goes in the manifest.** An `apiKey` field is a validation error. Run `/login <id>` (the
  provider is listed first under "Chat providers"; the key is checked with a one-token request to the first
  model before it is stored in `auth.json`), or set the `apiKeyEnv` variable in the daemon's environment. A
  stored key wins over the environment.
- Then `/model <id>/<modelId>` (for example `/model axwith/opencodex/google-antigravity/gemini-4-argon`), or set
  `bot.model.provider: <id>` and `bot.model.modelId`.
- Boot errors: an id that is a builtin provider (`openai`, `anthropic`, …), an id with characters other than
  lowercase letters, digits, `.`, `_`, `-`, and duplicate model ids. A custom id that equals an oh-my-pi login id
  (e.g. `ollama`) replaces that login in `/login`.
- Cost is reported as 0. Like any manifest change, adding or editing a provider needs a daemon restart.

## 3. Validation behavior

Source: `src/manifest.ts` (`parseManifest`, `ManifestError`)

- **Phase 1, schema.** If the shape check fails, every schema error is reported together as `<instancePath>: <message>` (`/` for the root), and validation stops there.
- **Phase 2, semantics.** Problems from all sections are collected, then thrown together as `invalid manifest:\n- …`:
  - skillEvolution (prefixed `skillEvolution: `), curation, memory, research profiles
  - custom provider ids and duplicate model ids (prefixed `providers.<id>`)
  - duplicate LSP server names, unknown `commands.disabled` names
  - agents, channels (unknown ids and per-channel schema), plugins (unknown ids and load errors)
- Because everything is checked up front, a bad config fails at boot instead of at first use.
- **An enabled bot needs at least one channel or the `api`.** This check is added only when no other problem was found: `channels: an enabled bot needs at least one channel or the api`. A disabled bot may have no channels.
- `additionalProperties: false` is set only on `skillEvolution` and its sub-objects, `curation`, `memory` (and `auto`/`recall`), `research` and each code profile (and `readiness` stages), and each `providers` entry and model. The schema for `bot`, `api`, `agents`, `lsp`, `commands` and the top level does not set it.
- Required fields must be written explicitly. Only the optional fields listed above have defaults.

## 4. Files under `dataDir`

Source: `src/main.ts` (`serve`), `src/tui/daemon.ts`, `src/auth/store.ts`

| Path | What it is |
|---|---|
| `dinobot.sqlite` (+`-wal`, `-shm`) | Main durable store (conversations, skills, memory, …). The daemon is its only writer |
| `session-index.sqlite` (+`-wal`, `-shm`) | Session search index |
| `skill-observations.sqlite` (+`-wal`, `-shm`) | Opened only when `skillEvolution.observe: true` |
| `auth.json` | Model credentials saved by `/login`, mode 0600 |
| `verification-evidence/` | Directory for verification evidence |
| `dinobot.log` | Daemon stdout/stderr when the TUI starts the daemon in the background |

Channels may add their own storage paths, such as the `databasePath` inbox files in the example.
Those are set per channel; see channels-and-cli.md.

## 5. Secrets policy

Source: `dinobot.example.yaml`, `openwiki/contracts/customer-manifest.md`, `src/auth/store.ts`, `src/channels/messaging.ts`

- Secrets never go in the manifest. API keys and channel credentials stay in the environment or in private credential files.
- Model credentials come from the environment, or from TUI `/login`, which stores them in `<dataDir>/auth.json` (0600).
- Channel and plugin settings name the environment variable instead of holding the value:
  - channels: `botTokenEnv`, `webhookSecretEnv`, `appTokenEnv`, … (read via `process.env[name]` in `src/channels/messaging.ts`)
  - `github`: `tokenEnv`
  - Telegram polling: `botTokenFile`
  - `mcp`: `${VAR}` references in config values
- `research.codeProfiles.*.environmentAllowlist` lists only environment variable *names*.

## 6. Worked examples

**Local TUI only** (the same as the first-run default, with a fixed workspace):

```yaml
bot:
  enabled: true
  dataDir: /srv/dinobot/data   # use an absolute path
  workspaceRoot: /srv/dinobot/project
  model: { provider: anthropic, modelId: claude-sonnet-4-6 }
  toolMode: codemode-only
api: { port: 8786 }
channels: {}
plugins: {}
```

`dataDir` is passed to `mkdir`/`join` unchanged; no code expands `~`. A relative path resolves against the process's start directory.

**Web search tuned, login commands hidden, memory recall off:**

```yaml
bot:
  enabled: true
  dataDir: .data
  model: { provider: anthropic, modelId: claude-sonnet-4-6 }
  toolMode: hybrid
api: { port: 8786 }
channels:
  http: { port: 8787 }
plugins:
  web:
    engines: [startpage, duckduckgo]
    timeoutSeconds: 30
commands:
  disabled: [login, logout]
memory:
  recall: { enabled: false }
```

To turn web search off instead, use `plugins: { web: false }`.

**Custom LSP server only** (this replaces the built-in list):

```yaml
bot:
  enabled: true
  dataDir: .data
  model: { provider: anthropic, modelId: claude-sonnet-4-6 }
  toolMode: codemode-only
api: { port: 8786 }
channels: {}
plugins: {}
lsp:
  timeoutMs: 20000
  servers:
    - name: typescript
      command: ["typescript-language-server", "--stdio"]
      extensions: [".ts", ".tsx", ".js", ".jsx"]
      rootMarkers: ["tsconfig.json", "package.json"]
```
