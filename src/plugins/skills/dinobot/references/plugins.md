# Plugins

Source: src/plugins/index.ts, src/plugins/types.ts, src/manifest.ts, src/plugins/<id>/index.ts, src/deps/index.ts,
src/cli/init.ts, openwiki/architecture/plugins.md, web-search.md, image-gen.md, github.md, google.md, mcp.md, computer-use.md, skills.md,
aside.md, browser.md, pm.md, calendar.md, openwiki/decisions/0018-opt-in-builtin-integrations.md, 0058-default-on-keyless-web-search.md, 0059-dinobot-init-and-computer-use.md,
0077-google-workspace-oauth.md, 0078-google-rest-apis.md, 0088-codex-login-image-generation.md, 0093-browser-plugin.md,
0105-pm-ledger-plugin.md, 0106-calendar-plugin-and-plugin-wake.md.

## Overview

A plugin is a bundle of tools, plus an optional prompt section, configured under `plugins.<id>` in `dinobot.yaml`.
The catalog is fixed when the binary is built (`src/plugins/index.ts`). There is no runtime plugin loading. If a service
has no built-in plugin, connect it through the `mcp` plugin or let the agent use a CLI from the shell.

| id | Default | Credentials | External program | Tools (exposed names) |
| --- | --- | --- | --- | --- |
| `web` | **on** (`enabledByDefault`) | none | none | `web_search` |
| `image_gen` | **on** (`enabledByDefault`) | none of its own; borrows the stored OpenAI Codex (ChatGPT) login | none | `image_gen_generate` |
| `aside` | off (opt-in) | none in the manifest; the Aside CLI is signed in to the user's Aside account | Aside app + Aside CLI (installed per the official guide, not by `dinobot init`) | `aside_repl`, `aside_exec`, `aside_memory_search` (whatever the CLI's MCP server lists) |
| `skills` | always loaded (cannot be turned off) | none | none | none of its own (the harness adds `skills_*`) |
| `github` | off (opt-in) | token in an env var (default `GITHUB_TOKEN`) | none | `github_list_issues`, `github_get_issue`, `github_list_comments`, `github_get_pull_request`, `github_get_pull_request_diff`, `github_get_checks`, `github_get_file`, plus `github_comment` and `github_create_issue` with `write: true` |
| `google` | off (opt-in) | none in the manifest; the user approves a Google link once (OAuth via the dinobot broker) | none | `google_connect`, `google_disconnect`, `google_gmail_*`, `google_calendar_*`, `google_drive_*`, `google_people_*` (write tools with `write: true`) |
| `mcp` | off (opt-in) | whatever each server needs, via `${VAR}` expansion | the MCP servers you configure | `mcp_<server>_<tool>` |
| `computer` | off (opt-in) | none | `cua-driver` 0.34.0 (installed by `dinobot init`) | `computer_use` |
| `browser` | off (opt-in) | none; dedicated mode keeps its own Chrome profile, attach mode uses the user's Chrome logins | an installed Chrome/Edge (not installed by dinobot); Patchright is a package dependency | `browser_use` |
| `pm` | off (opt-in) | none | `git` on PATH when a ledger names a repo | `pm_create_ledger`, `pm_list_ledgers`, `pm_add_items`, `pm_transition`, `pm_run_check`, `pm_record_decision`, `pm_set_status`, `pm_status`, `pm_verify`, `pm_export_markdown` |
| `calendar` | off (opt-in) | none (local SQLite store; Google/Apple sync is not implemented) | none | `calendar_create_event`, `calendar_list_events`, `calendar_get_event`, `calendar_update_event`, `calendar_delete_event`, `calendar_import_events` |

To see what actually loaded, run `/plugins` (TUI or http channel). Each line is `<id>: <tool names>`. The serve log
also prints a startup line `dinobot up: ... plugins=image_gen(1 tools),web(1 tools),skills(0 tools)`.

## Manifest rules (all plugins)

Source: src/manifest.ts (`parseManifest`), src/plugins/types.ts (`loadPlugin`).

- **Tool names are `<pluginId>_<toolName>`.** Plugin and tool names must match `^[a-z][a-z0-9_]*$`. Codemode uses the
  same name, for example `tools.web_search({...})` or `tools.github_get_issue({...})`.
- **Unknown ids are errors.** A key under `plugins:` that is not in the catalog fails boot with
  `plugins.<id>: unknown plugin (available: aside, browser, computer, github, google, image_gen, mcp, pm, skills, web)`. Only the catalog's own keys count,
  so a name like `toString` is also an unknown plugin.
- **Config is validated at boot.** Schema errors are reported as `plugins.<id>/<path>: <message>`. All manifest
  problems are collected and boot stops with `invalid manifest:` followed by the list.
- **`plugins.<id>: false` turns off a default-on plugin.** Today that means `web` and `image_gen`. For any other plugin, `false`
  is a config error. `true` is always an error, because it is not a config object. An empty value (`web:`, which YAML
  reads as `null`) means "default config", the same as `{}`.
- **Default-on plugins load even with `plugins: {}`.** They load with `{}` after the plugins the manifest lists. A
  plugin may be default-on only if it needs no credentials, opens nothing in `load`, accepts `{}` and has only
  read-only tools (ADR 0058), or, instead of read-only tools, only borrows declared model logins (`providerLogins`)
  and fails without them before any request (ADR 0088).
- **`skills` is always present.** If the manifest does not list it, it is added with `{}` (`withDefaultSkills`).
  `skills: false` is an error.
- **Changes need a daemon restart.** Plugins load once at boot.
- **Secrets never go in the manifest.** Plugins take environment variable *names* (`tokenEnv`) or `${VAR}`
  references (mcp).

## External dependencies and `dinobot init`

Source: src/deps/index.ts, src/cli/init.ts, src/plugins/computer/driver.ts.

A plugin can declare external programs that it runs as child processes. `dinobot init` installs **every** dependency
declared in the catalog, whether or not the plugin is enabled. Each one is a pinned version, verified by exact byte
count and SHA-256 and a `--version` smoke check. `init` also creates the default manifest if there is none.

```
dinobot init [--check] [--config <path>] [<dependency>...]
  --check        report what is installed without downloading anything
  <dependency>   limit to these ids (today only: cua-driver)
```

- Install root: `$DINOBOT_DEPS_DIR` (only if it is an absolute path), else `$XDG_DATA_HOME/dinobot/deps`, else
  `~/.local/share/dinobot/deps`. Layout: `<root>/<id>/<version>-<platform>/`.
- Exit codes: 0 ok; 1 a failed install, or a missing dependency with `--check`; 2 usage error or unknown dependency id.
- If the manifest does not enable a plugin that uses a dependency, `init` prints a hint to add `<id>: {}`.
- At run time a plugin only *resolves* what is installed. It never downloads anything.
- Today the only dependency is `cua-driver` 0.34.0, for `computer`. Pinned platforms: `darwin-arm64`, `darwin-x64`,
  `linux-x64`, `linux-arm64`, `win32-x64`, `win32-arm64`.
- On macOS, `dinobot init` verifies the notarized `CuaDriver.app` (team `YCK386LBJ7`) and installs it to
  `/Applications/CuaDriver.app`, replacing another version there (needs an administrator account). Then grant
  Accessibility and Screen Recording once: `/Applications/CuaDriver.app/Contents/MacOS/cua-driver permissions grant`.

## `web`: keyless web search (on by default)

Source: src/plugins/web/index.ts, src/plugins/web/types.ts, openwiki/architecture/web-search.md, ADR 0058.

Searches the public web through Startpage, then DuckDuckGo, falling back in order. It needs no API keys and makes no
network calls at boot.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `engines` | array of `startpage` \| `duckduckgo` | no | `[startpage, duckduckgo]` | fallback order; at least 1 item, unique |
| `timeoutSeconds` | integer | no | `60` | per engine attempt; 1 to 300 |
| `endpoints.startpage` | string | no | built-in | base URL override (mirrors/tests) |
| `endpoints.duckduckgo` | string | no | built-in | base URL override (mirrors/tests) |

Unknown keys are rejected (`additionalProperties: false`).

Tool `web_search` (read-only): `query` (required; supports `site:`, `-site:`, `after:`, `before:`, `inurl:`,
`intitle:`, `filetype:`, `"phrases"`, `-exclusions`, `OR`), `recency` (`day|week|month|year`), `limit` (1 to 20,
default 10). Output is numbered sources with URLs and 240-character snippets. Constraints the engine cannot honor
are relaxed and reported in a `Note` line. A result starting with `Error:` means every engine failed. Shared or
datacenter IPs may get a 429 bot challenge, which moves on to the next engine.

```yaml
plugins:
  web: false                 # turn off: no tool, no prompt section, no queries sent to third parties
  # or tune it:
  # web:
  #   engines: [duckduckgo, startpage]
  #   timeoutSeconds: 30
```

Privacy note: when `web` is on, the model can send queries drawn from the conversation to Startpage and DuckDuckGo.
A deployment that must not send data outside should set `web: false`.

## `image_gen`: image generation with the ChatGPT (Codex) login (on by default)

Source: src/plugins/image_gen/index.ts, src/plugins/image_gen/codex.ts, src/core/provider-login.ts,
openwiki/architecture/image-gen.md, ADR 0088.

Creates and edits images the way Codex's `imagegen` tool does: it posts to the ChatGPT backend
(`https://chatgpt.com/backend-api/codex/images/generations` or `/edits`, model `gpt-image-2`) with the deployment's
stored **OpenAI Codex** login. It has no secret of its own. Log in once with `/login` → OpenAI Codex (ChatGPT
Plus/Pro); without that login every call fails with that instruction and sends nothing. The plan's image limit applies
(a 429 reports when it resets). Free ChatGPT plans may be refused by the backend.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `model` | string | no | `gpt-image-2` | image model the backend runs |
| `outputDir` | string | no | `generated_images` | relative to the conversation's working directory (absolute allowed) |
| `baseUrl` | string | no | the `openai-codex` provider's | `http(s)://` override for tests and proxies |
| `timeoutMs` | integer | no | `300000` | upper bound of one request; 1000 to 900000 |

Tool `image_gen_generate` (not read-only; it writes a new file): `prompt` (required), `transparent_background`
(default false), `referenced_image_paths` (edit mode, at most 5 local PNG/JPEG/WebP/GIF files; relative paths resolve
against the working directory), `size` (`auto|1024x1024|1536x1024|1024x1536`), `quality` (`auto|low|medium|high`).
The image is saved as `<cwd>/generated_images/image-<UTC time>-<random>.png` (never overwriting) and returned to the
model with the saved path. A request usually takes 20 to 60 seconds; a codemode cell that calls it waits up to
`timeoutMs` (default 5 minutes) instead of the usual 60-second cell limit. The image is not posted to a chat channel by itself.

```yaml
plugins:
  image_gen: false           # turn off: no tool, no prompt section
  # or tune it:
  # image_gen:
  #   outputDir: art
```

Privacy note: when `image_gen` is on and an OpenAI Codex login is stored, the model can send prompts and the
referenced images to OpenAI under that ChatGPT account.

## `github`: GitHub REST (opt-in, read-only by default)

Source: src/plugins/github/index.ts, openwiki/architecture/github.md, ADR 0018.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `tokenEnv` | string matching `^[A-Za-z_][A-Za-z0-9_]*$` | no | `GITHUB_TOKEN` | **name** of the env var that holds the token |
| `apiUrl` | string | no | `https://api.github.com` | GitHub Enterprise Server: `https://<host>/api/v3` |
| `repositories` | array of `owner/name` or `owner/*` | no | all repos the token can reach | at least 1 item when given |
| `write` | boolean | no | `false` | registers `github_comment` and `github_create_issue` |

Unknown keys are rejected. Boot fails with `environment variable <tokenEnv> is not set` if the variable is missing
or empty. The token itself is not checked at boot (no network), so a bad token shows up as a `GitHub 401` error on
the first call.

| Tool | Arguments (summary) |
| --- | --- |
| `github_list_issues` | `repo`, `state` (open/closed/all), `kind` (issue/pull_request/all), `labels`, `assignee`, `limit` 1 to 100 |
| `github_get_issue` | `repo`, `number` |
| `github_list_comments` | `repo`, `number`, `limit` 1 to 100 (most recent, oldest first) |
| `github_get_pull_request` | `repo`, `number`, `fileLimit` 0 to 3000 |
| `github_get_pull_request_diff` | `repo`, `number`, `maxChars` 1 to 1,000,000 |
| `github_get_checks` | `repo`, `ref` or `number`; verdict is `success` only when every check was seen and passed |
| `github_get_file` | `repo`, `path` (empty for root), `ref`, `maxChars` |
| `github_comment` (write) | `repo`, `number`, `body`; idempotent for identical requests within 24h |
| `github_create_issue` (write) | `repo`, `title`, `body`, `labels`, `assignees`; idempotent within 24h |

`repo` is always `owner/name`. A repo outside `repositories` is refused before any request is made.

```yaml
plugins:
  github:
    tokenEnv: GITHUB_TOKEN          # export GITHUB_TOKEN=... in the daemon's environment
    repositories: [acme/api, acme/*]
    write: false
```

## `google`: Google Workspace (opt-in)

Source: src/plugins/google/*.ts, services/oauth-broker, openwiki/architecture/google.md, ADR 0077, 0078.

Calls Google's GA REST APIs (Gmail, Calendar, Drive, People). Nothing goes in the manifest or the environment: the
first Google tool call (or `google_connect`) returns a login link. The user opens it on any device and allows access.
The daemon stores the grant in `<dataDir>/google-oauth.json` (mode 0600; agent file tools cannot touch it).
To turn it on, add `google: {}` under `plugins:` or tick "Google" in `/setup plugins` (the onboarding's Features
step), which adds the same read-only `google: {}` and restarts the daemon; `write`/`services` are edited in the YAML.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `services` | array of `gmail` \| `calendar` \| `drive` \| `people` | no | all four | at least 1, unique |
| `write` | boolean | no | `false` | registers the write tools below and asks for write scopes |
| `broker` | `https://<host>` | no | `https://oauth.dinobot.workers.dev` | OAuth broker that receives the redirect and holds the client secret |

Unknown keys are rejected. `load` makes no network calls.

| Tool | Read-only | Arguments (summary) |
| --- | --- | --- |
| `google_connect` | yes | none. Returns `{status: "connected"}` or `{status: "authorization_required", url}` (link valid 10 minutes) |
| `google_disconnect` | no | none. Revokes the grant at Google and deletes the token file |
| `google_gmail_search` | yes | `query` (Gmail syntax), `maxResults` 1 to 50, `pageToken`, `includeSpamTrash` |
| `google_gmail_read_message` / `google_gmail_read_thread` | yes | `id`, `maxChars`. Plain-text body (HTML stripped) and attachment names |
| `google_gmail_list_labels` | yes | none |
| `google_calendar_list_calendars` | yes | none |
| `google_calendar_list_events` | yes | `calendarId` (default primary), `timeMin`, `timeMax` (RFC 3339), `query`, `maxResults`, `pageToken` |
| `google_calendar_get_event` | yes | `calendarId`, `eventId` |
| `google_calendar_freebusy` | yes | `timeMin`, `timeMax`, `calendarIds`, `timeZone` |
| `google_drive_search` | yes | `text` (name and content), `query` (Drive query syntax), `includeTrashed`, `maxResults`, `pageToken` |
| `google_drive_get_file` | yes | `fileId` |
| `google_drive_read_file` | yes | `fileId`, `maxChars`. Docs as Markdown, Sheets as CSV, Slides as text, text files as is; binary refused; 10 MiB cap |
| `google_people_me` / `google_people_search_contacts` | yes | none / `query`, `maxResults` |
| `google_gmail_create_draft` (write) | no | `to`, `cc`, `bcc`, `subject`, `body`, `replyToMessageId` (keeps the thread) |
| `google_gmail_send_draft` (write) | no | `draftId` |
| `google_gmail_modify_labels` / `google_gmail_trash_message` (write) | no | `id`, `add`, `remove` / `id` |
| `google_calendar_create_event` (write) | no | `summary`, `start`, `end` (RFC 3339 or `YYYY-MM-DD`), `timeZone`, `description`, `location`, `attendees`, `sendUpdates` (default `none`). Identical repeats return the existing event |
| `google_calendar_update_event` / `google_calendar_delete_event` (write) | no | `eventId` plus changed fields / `eventId`, `sendUpdates` |
| `google_drive_create_text_file` (write) | no | `name`, `content`, `mimeType`, `asGoogleDoc`, `parentId` |

- Scopes. Read: `gmail.readonly`, `calendar.readonly`, `drive.readonly`, `userinfo.profile`, `userinfo.email`, `contacts.readonly`.
  With `write: true`: `gmail.modify` instead of `gmail.readonly`, plus `calendar.events` and `drive.file`.
  A stored grant with broader scopes covers narrower ones. Enabling a service or `write` later makes the next call
  return a link for the new permissions.
- A call without a usable grant fails with `Google authorization required. ... <link>`. Access tokens refresh
  automatically. A refused refresh (revoked, or the 7-day refresh-token limit of a Google app in testing mode)
  deletes the grant, and the next call returns a new link. Other API failures read `Google <status>: <message>`.
- While the Google app is unverified, only its test users can log in, and they see an "unverified app" warning.

```yaml
plugins:
  google: {}
  # google:
  #   services: [gmail, calendar]
  #   write: true
```

## `aside`: browser control through the Aside browser (opt-in)

Source: src/plugins/aside/index.ts, openwiki/architecture/aside.md. Official guide: https://docs.aside.com/help/developers

Lets the agent drive the user's own [Aside](https://aside.com) browser, signed in to their real accounts. The plugin runs
`<aside CLI> mcp` over stdio (the same MCP client as `mcp`) and exposes the CLI's tools as `aside_<tool>`. With Aside
CLI 1.26 these are `aside_repl` (Playwright-style JavaScript in the browser: tabs, snapshot, click, fill, screenshot,
downloads with the user's cookies), `aside_exec` (hands a whole task to Aside's own browser agent; spends Aside credits)
and `aside_memory_search` (Aside's notes about the user). The list is whatever the installed CLI reports at boot.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `command` | string | no | `aside` on PATH, then the installer location | the Aside CLI executable |

Without `command` the plugin looks on the daemon's PATH, then where the official installers put the CLI:
Windows `%LOCALAPPDATA%\Aside\CLI\current\aside.exe`; macOS `~/.local/bin/aside` or
`~/.aside/cli/Aside CLI.app/Contents/MacOS/aside`; Linux `~/.local/bin/aside` or `~/.aside/cli/aside`. So a daemon
started before the install still finds it. Not found, or `aside mcp` fails to start: boot stops with
`plugins.aside: Aside CLI not found ...` / `could not start ...`, both naming the guide URL.

### Connecting Aside when the user asks (browser control, "use Aside", "connect my browser")

The plugin is never on by default. When the user wants the agent to operate a browser, offer Aside and do the setup
yourself; only signing in is theirs.

1. **Read the current guide first:** fetch https://docs.aside.com/help/developers and follow the tab for the user's OS
   (macOS or Windows). Install steps change; do not rely on this summary when the page says otherwise.
2. **Check what is there:** `aside --version` (also try the installer locations above). The Aside app itself is a
   separate install (https://aside.com/download); if it is missing, ask the user to install it.
3. **Install the CLI exactly as the guide says.** macOS: `curl -fsSL https://releases.aside.com/install.sh | bash`.
   Windows: download `install.ps1`, verify its Authenticode signature (status `Valid`, publisher
   `CN=AT YOUR SIDE INC, ...`, timestamped) before running it, as the guide's PowerShell block does. Never skip the
   signature check.
4. **Check sign-in:** `aside account status` must show an account `signed in`. If not, the user signs in from
   Aside Settings > Account (or `aside login`, confirmed in Settings > Account > Devices).
5. **Smoke test:** `aside repl "const p = await openTab('https://example.com'); console.log(await p.title()); await closeTab(p)"`.
6. **Enable:** show the diff, add `aside: {}` under `plugins:` (add `command:` only for a non-standard install), then
   restart the daemon when no other conversation is running (see troubleshooting.md). After the restart, `/plugins`
   shows `aside: aside_repl, ...`.

An older manifest may connect Aside through `plugins.mcp.servers.aside` (`mcp_aside_*` tools). Replace that entry with
`aside: {}` rather than keeping both.

```yaml
plugins:
  aside: {}
```

## `browser`: real Chrome through Patchright (opt-in)

Source: src/plugins/browser/index.ts, host.ts, shared.ts, openwiki/architecture/browser.md, ADR 0093.

One tool, `browser_use`, drives a real installed Chrome with Patchright 1.63.0 (patched Playwright: on this project's
measurement a bot-detection page saw `isBot: false`, `isAutomatedWithCDP: false`, while agent-browser was flagged).
It runs in one crash-isolated Bun child process (`host.ts`) that starts on the first allowed call and restarts after
a crash. It works from source (`bun`) and from the npm package, which ships the child as `browser-host.js` next to
`main.js` and installs `patchright` as a pinned dependency. A standalone `bun build --compile` binary does not ship
the child and fails with
`browser host script is not available in this build; run dinobot from source (bun) or set plugins.browser.hostCommand`.
dinobot installs no browser; it uses the one on the machine.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `mode` | `dedicated` \| `attach` | no | `dedicated` | dedicated: a bot-only Chrome profile; attach: the user's running Chrome |
| `channels` | array of strings (`*` or `^[a-z][a-z0-9_-]*$`) | no | `[tui]` | same gate as `computer` |
| `browser` | `chrome` \| `msedge` \| `chromium` | no | `chrome` | Patchright channel; `chromium` needs Patchright's own Chromium |
| `profile` | string | no | `<dataDir>/browser/profile` | dedicated user-data-dir (logins made there persist) |
| `executablePath` | string | no | the channel's installed browser | dedicated mode only |
| `userDataDir` | string | no | per OS: Windows `%LOCALAPPDATA%\Google\Chrome\User Data`, macOS `~/Library/Application Support/Google/Chrome`, Linux `~/.config/google-chrome` | attach: where Chrome writes `DevToolsActivePort` |
| `humanize` | boolean | no | `true` | 25 to 70 ms per typed character, 150 to 600 ms before click, fill, select |
| `hostCommand` | string[] | no | this runtime running `host.ts` | replace the child command (tests, overrides) |

Unknown keys are rejected. `load` starts nothing.

Tool `browser_use`: `{ action, args? }`. Flow: `open {url}` → `snapshot` (title, URL and an accessibility tree
with `[ref=eN]`, cut at 30,000 characters) → `click`/`fill`/`type`/`select`/`hover`/`upload` with
`{ref: "e12"}` (`"@e12"` also works) or a CSS/Playwright `selector` → `snapshot` again. Other actions: `status`,
`press {key}`, `scroll {dy?, dx?, ref?}`, `screenshot {fullPage?}` (JPEG image), `tabs`, `tab {index}`,
`close_tab {index?}`, `back`, `forward`, `reload`, `wait {ms|text|url}`, `text {ref|selector?}`, `eval {js}`,
`dialog {accept, promptText?}`, `window` (page title and the expected OS window title for computer_use), `close`.
Exact argument names are in `ACTION_SPECS` in `shared.ts`; a wrong one fails with
`InvalidArguments: <action>: ...; valid arguments: ...` before the child starts.

- The channel gate and argument checks run before the child starts. `status` and `close` do not start it.
- A ref no longer on the page fails at once with `StaleRef`: take a new snapshot.
- When Patchright cannot act (timeout, not visible, intercepted, detached, ...), the error ends with
  `Fallback: computer_use with window "<page title>" (Chrome) — observe it and act by element or pixels.`
  Continue with `computer_use` on that window.
- Attach mode, first use: if `DevToolsActivePort` is missing, the error `RemoteDebuggingOff` says to open
  `chrome://inspect/#remote-debugging` in the user's Chrome and tick "Allow remote debugging for this browser
  instance" (with computer_use: observe window "Chrome", `hotkey ctrl+t`, type the URL, `press_key return`, click the
  checkbox). Then Chrome shows "원격 디버깅을 허용하시겠습니까?" / "Allow remote debugging?" on every new connection;
  after 4 s the tool returns `PermissionPending` (not an error). Click 허용/Allow with computer_use
  (`windows {filter: "remote debugging"}` or `"원격 디버깅"`), then call `browser_use` again; the pending connection
  is kept.
- Attach mode works in its own new tab, closes only tabs the agent opened (`NotOwnTab` otherwise), and `close`
  only disconnects; the user's tabs stay.
- The child gets desktop-session variables only, never provider tokens.

```yaml
plugins:
  browser: {}                      # bot-only Chrome, TUI only
  # browser:
  #   mode: attach                 # the user's own Chrome; also enable computer: {}
  #   channels: [tui, telegram]
```

Setup: `/setup plugins` → "Browser" asks "Which Chrome should the agent use?". "Start with a Chrome just for the bot"
adds `browser: {}`. "Use my own Chrome as it is" adds `browser: {mode: attach}` and, if computer use is off, installs
cua-driver and adds `computer: {}` too (if that install fails, nothing is added). Or edit the YAML and restart.
The detection result is from one test page; it does not make account bans impossible. Ask the user before posting,
sending, buying, deleting or changing account settings unless they already asked for that exact action.

## `mcp`: Model Context Protocol servers (opt-in)

Source: src/plugins/mcp/index.ts, openwiki/architecture/mcp.md.

`servers` is **required**, so `mcp: {}` is a config error. It is a map from server name to entry, in the same shape
as a Claude Code `.mcp.json` entry.

| Entry kind | Fields |
| --- | --- |
| stdio (default) | `type: stdio` (optional), `command` (required, non-empty), `args` (string[]), `env` (map), `cwd` |
| HTTP | `type: http` (required), `url` (required), `headers` (map). Uses the Streamable HTTP transport |

- `${VAR}` and `${VAR:-default}` in `command`, `args`, `env` values, `cwd`, `url` and `headers` values are expanded
  from the daemon's environment. A variable that is unset and has no default fails that server with
  `server "<name>": environment variable <VAR> is not set`.
- Tool names are `mcp_` + `<server>_<tool>`, lowercased, with characters outside `a-z0-9_` replaced by `_`. For
  example, `get-issue` on server `jira` becomes `mcp_jira_get_issue`.
- Servers connect **at boot**. If any server fails to connect or list its tools, the whole plugin fails and boot
  stops (`plugins.mcp: server "<name>": ...`). The tool list is fixed at boot.
- Not supported: MCP resources, prompts and sampling, the legacy SSE transport, and OAuth flows (use `headers`).
  Google Workspace has its own plugin with OAuth (`google`).

```yaml
plugins:
  mcp:
    servers:
      local:
        command: npx
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/docs"]
      jira:
        type: http
        url: https://mcp.example.com/mcp
        headers:
          Authorization: "Bearer ${JIRA_TOKEN}"
```

## `computer`: desktop computer use via cua-driver (opt-in)

Source: src/plugins/computer/index.ts, actions.ts, driver.ts, windows.ts, openwiki/architecture/computer-use.md, ADR 0059, 0093.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `channels` | array of strings (`*` or `^[a-z][a-z0-9_-]*$`) | no | `[tui]` | channels whose conversations may use the tool; `*` = all. At least 1 item, unique |
| `command` | string | no | the cua-driver that `dinobot init` installed | a custom driver executable (manual override) |
| `args` | string[] | no | `["mcp"]` | arguments for the driver |
| `env` | map of string | no | none | extra child env; wins over the defaults |
| `takeover` | `auto` \| `never` | no | `auto` | auto: an input action refused with `background_unavailable` is retried once in the foreground |

Unknown keys are rejected. `load` starts nothing. The driver starts on the first allowed call and is shared, and it
restarts after a crash. If no driver is installed, the call fails with
``cua-driver 0.34.0 is not installed. Run `dinobot init` on this machine, or set plugins.computer.command.``

Tool `computer_use`: `{ action, args? }`. `action` is one of a fixed allowlist (observe: `list_apps`,
`list_windows`, `get_window_state`, ...; pointer; keyboard; clipboard; browser page; sessions) or `describe`. Use
`describe` with no args to list the actions the running driver serves, or with `{action}` to get one action's exact
argument schema. The full list is in `src/plugins/computer/actions.ts`.

Friendlier layer on top (raw `pid`, `window_id`, `element_token`, `delivery_mode` still work):

- `windows {filter?}`: one line per window, `app (pid) "title" [window_id]`.
- `observe {window, screenshot?, query?}`: `get_window_state` with a screenshot and up to 400 elements; the tree has
  `[N]` indexes. `screenshot: false` re-indexes without the image.
- Any window action takes `window`: a case-insensitive app/title substring (`"Chrome"`) or `{app?, title?, id?}`,
  instead of `pid` + `window_id`. And `element: N`, the `[N]` index of the latest observe of that window, instead of
  `element_token`. Example: `click {window: "Chrome", element: 12}`.
- Pixel `x`,`y` on a window are refused until this plugin has a screenshot of that window (observe first).
- `takeover: true` sends input in the foreground. With `takeover: auto` (default) a `background_unavailable` refusal
  (nothing delivered) is retried once in the foreground and the result says "(briefly brought the window to the
  foreground)". No other failure is retried.
- Errors start with a stable code: `WindowNotFound` (lists open windows), `AmbiguousWindow` (lists ids),
  `NoSnapshot` (observe first), `StaleRef` (observe again), `BackgroundUnavailable`, `InvalidArguments` (lists the
  valid argument names), `InvalidCoordinateFrame`.

- The channel gate runs before the driver starts. For example, a Telegram conversation is refused unless `telegram`
  or `*` is listed. The gate is a usage guardrail, not a security boundary (ADR 0059 §7).
- The child environment is an allowlist: desktop-session variables (`DISPLAY`, `WAYLAND_DISPLAY`,
  `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, ...) plus `CUA_*`. The plugin also sets `DO_NOT_TRACK=1` and
  `CUA_DRIVER_RS_UPDATE_CHECK=0`, and sets `CUA_DRIVER_RS_ENABLE_WAYLAND=1` under Wayland. Model or provider tokens are
  not passed to the driver.
- An allowed conversation can read and operate every window on the desktop.

```yaml
plugins:
  computer: {}                     # TUI only
  # computer:
  #   channels: [tui, telegram]
  #   command: /opt/cua-driver/cua-driver
  #   env: { CUA_DRIVER_RS_ENABLE_WAYLAND: "0" }
  #   takeover: never
```

Setup: run `dinobot init` (or `dinobot init --check` to verify), add `computer: {}`, then restart the daemon.

## `pm`: mechanically checked project ledger for long multi-worker work (opt-in)

Source: src/plugins/pm/, src/extensions/plugin-hooks.ts, docs/wiki/architecture/pm.md, docs/wiki/decisions/0105-pm-ledger-plugin.md.

```yaml
plugins:
  pm: {}              # ledgers live in <dataDir>/pm
  # pm: { root: /srv/dinobot/pm }
```

- `root` (optional): directory of the ledger files. Default `<dataDir>/pm`, outside every workspace. Each ledger is a
  hash-chained event list; a hand edit is detected on load (the chain is unkeyed, so it does not stop deliberate forgery).
- The conversation that calls `pm_create_ledger` owns the ledger. Only it may change items; workers (subagents) report and
  the PM conversation records.
- Rules checked by code, not by the model: `doing` needs a running subagent `taskId` as worker, finished dependencies and a
  free WIP slot; `review`/`done` need a commit that exists in the ledger's `repo` and a settled worker; `done` also needs
  the commit reachable from `integrationRef` and a passing `pm_run_check` of every required check on exactly that commit.
  `pm_run_check` refuses a work tree that is not at the commit or has tracked changes, and fails a run if the tree changes.
  A check runs for at most its `timeoutSec` (default and maximum 900 s, so it fits one codemode cell); a codemode cell
  that calls `pm_run_check` waits for it instead of the usual 60 s.
- Turn-end hook: when the owner conversation ends a turn, the host continues it (at most 3 times per human input, never
  after a continued turn without a tool call) while a finished worker is unrecorded, a `doing` item has no live worker,
  ready items wait with WIP capacity free, or every item is final but the ledger is still active. `pm_set_status paused`
  with a reason stops the dispatch rule on purpose.
- `pm_status` gives counts, the ready frontier, the critical path and an ETA from recorded timestamps. `pm_export_markdown`
  writes a read-only Markdown view for people.

## `calendar`: local calendar with reminders delivered to the conversation (opt-in)

Source: src/plugins/calendar/, src/core/bot.ts (plugin wake), openwiki/architecture/calendar.md,
openwiki/decisions/0106-calendar-plugin-and-plugin-wake.md.

```yaml
plugins:
  calendar: {}        # events in <dataDir>/calendar.sqlite, reminders checked every 5 minutes
  # calendar:
  #   timeZone: Asia/Seoul
  #   checkIntervalMinutes: 5
  #   quietHours: { start: "22:00", end: "08:00" }   # or false
  #   databasePath: /srv/dinobot/calendar.sqlite
```

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `timeZone` | IANA zone name | no | the process zone | local times, quiet hours and display; an unknown zone fails the load |
| `checkIntervalMinutes` | integer | no | `5` | 1 to 60; the engine also wakes exactly at the next due reminder |
| `quietHours` | `{start, end}` (`HH:MM`) or `false` | no | `{start: "22:00", end: "08:00"}` | reminders 3 h or more ahead that fall inside move out of it; `false` turns it off |
| `databasePath` | string | no | `<dataDir>/calendar.sqlite` | host-owned storage (agent file tools cannot touch it); without a data dir it is required |

| Tool | Read-only | Arguments (summary) |
| --- | --- | --- |
| `calendar_create_event` | no | `title`, `start` (RFC 3339, local `YYYY-MM-DDTHH:mm` in `timeZone`, or a date for all-day), `end`, `timeZone`, `location`, `description`, `category` (meeting/presentation/deadline/task/travel/personal/other), `importance` (low/normal/high), `preparation`, `reminders` (`[{minutes, action: notify\|prepare, note}]`, replaces the automatic plan; `[]` none), `key`. Same key (or title + start) in the same conversation returns the existing event |
| `calendar_list_events` | yes | `from`, `to` (default now to +14 days), `query`, `includeCancelled`; at most 200, `truncated` flag |
| `calendar_get_event` | yes | `id`; every reminder with its state (pending, fired, skipped + reason) |
| `calendar_update_event` | no | `id` plus any create field; `null` clears an optional field. Pending reminders are replanned, fired ones never fire again |
| `calendar_delete_event` | no | `id`; cancels the event and skips its pending reminders |
| `calendar_import_events` | no | `items` (1 to 200 create-shaped items, give each a stable `key` such as a WBS id), `defaults` (`category`, `importance`, `timeZone`); per-item created/updated/unchanged/error |

- Reminders go to the conversation that registered the event: when one comes due the host starts a turn there (input
  framed `<from host="plugin:calendar"/>`) and posts its answer to that Slack/Telegram/Discord thread once.
- `prepare` reminders ask the agent to research and draft the material named in `preparation` (files in the
  workspace); `notify` reminders are a short heads-up. Without explicit `reminders` the plan depends on category and
  importance (presentations and deadlines days ahead, meetings minutes ahead).
- A new or moved event that is already over is refused with the current time (models misjudge "today"); read
  `now` from `calendar_list_events` when unsure.
- The check loop calls no model; only a due reminder starts a turn. One reminder starts at most one turn, also across
  restarts.

## `skills`: skill source importer (always on)

Source: src/plugins/skills/index.ts, src/plugins/skills/bundled.ts, openwiki/architecture/skills.md.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `dirs` | array of non-empty strings | no | `[]` (bundled skills only) | parent directories of extra Agent Skills |
| `proofSkills` | boolean | no | `false` | adds the bundled formal verification skills `formal-verify`, `tlaplus-model`, `lean-model`, `proof-simplify` (opum-ai/proof-skills, MIT) |

- Bundled skills are always imported: `programming`, `optimization`, `debugging`, `clarification`, `research`, `delivery`, `dinobot`.
- Each **direct subdirectory** of a dir that contains `SKILL.md` is one skill. Other entries are ignored. Rules:
  - YAML frontmatter is required.
  - `name` is 1 to 64 characters of lowercase `a-z0-9` and single hyphens, and must equal the directory name.
  - `description` is 1 to 1024 characters.
  - Optional `compatibility` (at most 500 characters) and `metadata` (a map of strings).
  - The body must not be empty.
- Package limits:
  - Each file is at most 256 KiB, and the whole package at most 1 MiB with at most 128 companion files.
  - Files must be valid UTF-8 regular files. Symlinks are refused.
- A duplicate name (with a bundled skill or another dir) is an error. Any invalid skill fails boot
  (`invalid skills: ...`). A missing directory also fails boot.
- Sources are snapshotted into the versioned skill store at boot. Edits that the agent makes never overwrite source
  files. Edited source files are picked up on the next boot.
- The plugin exposes no tools itself. The `skills_*` tools come from the harness (see commands-and-features.md).

```yaml
plugins:
  skills:
    dirs: [/srv/dinobot/skills, ./team-skills]
    proofSkills: true
```

- `proofSkills: true` turns on TLA+/Lean 4 bug hunting. The skills install their own tools (Java TLC, elan) under
  `~/.cache/proof-skills` on first use. Do not also point `dirs` at a proof-skills checkout: the names would collide.

## Common answers

- "Is web search on?" Yes, unless the manifest says `web: false`. Check with `/plugins`.
- "Can dinobot make images?" Yes, with `image_gen_generate`, once an OpenAI Codex (ChatGPT Plus/Pro) login is stored
  (`/login`), unless the manifest says `image_gen: false`. Images are saved under `generated_images/` in the working directory.
- "Enable GitHub" means three steps: export the token in the daemon's environment, add a `plugins.github` block, and
  restart.
- "Connect Gmail/Calendar/Drive": add `google: {}` (`write: true` to send mail and edit events), restart, then ask for
  anything Google; the bot sends a login link.
- "Let the agent use a browser": offer the built-in `browser` plugin first (nothing to install; `/setup plugins` →
  Browser, or `browser: {}` / `browser: {mode: attach}` plus `computer: {}`, then restart). "Connect Aside" or a user
  who already uses Aside: follow the `aside` procedure above (read the guide for the OS, install and verify the CLI,
  check sign-in, add `aside: {}`, restart).
- "Will a site ban my account for CDP automation?": `browser` uses Patchright, which a bot-detection page did not flag
  (`isBot: false`) while agent-browser was flagged. That is one measurement, not a guarantee; pacing, behavior and
  account history still count.
- "Add Jira/Linear/Sentry": there is no built-in plugin. Use `plugins.mcp.servers` with that service's MCP server.
- "Boot fails after I added a plugin": read the `invalid manifest:` list. Typical causes are `unknown plugin`, a
  missing env var, an MCP server that failed to connect, or `false` on a plugin that is not default-on.
