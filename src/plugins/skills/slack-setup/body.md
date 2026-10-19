# Slack setup

Connect dinobot to Slack end to end: the user only does what needs their Slack account, you do the rest and prove it works. Use this when someone asks to connect, set up or fix Slack ("슬랙 연동", "Slack에서 쓰고 싶어", "봇이 Slack에서 답을 안 해").

The user has exactly three manual jobs: create and install the app from the bundled manifest, copy two tokens, copy their member ID. Never hand them config edits, env commands or a restart command; you do those with your tools. For every `channels.slack` field, load the dinobot skill and read its channels reference.

## Companion files

Read them with skills_read_file (same version as skills_load), write them to a private working directory, and run the scripts with `bun`.

| File | Use |
|---|---|
| `slack-app-manifest.json` | Paste-in Slack app manifest: scopes, events, Socket Mode, Messages tab, interactivity. |
| `scripts/slack-check.mjs` | Verifies both tokens and prints `teamId`, `botUserId`, `appId` (confirmed by the Socket Mode hello frame) and a ready `channels.slack` block. Optional test DM, thread view, inbox view. |
| `scripts/restart-when-idle.mjs` | Waits until no thread is busy, stops the TUI-owned daemon through its API, starts it again with credentials from files, checks the boot line, rolls back on failure, reports to a file and Slack. |
| `scripts/detach-windows.ps1` | Starts the restart script outside the daemon's process tree on Windows. |
| `references/troubleshooting.md` | Symptom → cause → fix, including "first mention works, thread replies do not". |

## Rules

- Secrets: tokens live in files, never in chat output, argv, the manifest or git. If a user pastes one, write it to a file right away and do not repeat it. Restrict access: POSIX `chmod 600` inside a `chmod 700` directory; Windows `icacls <file> /inheritance:r /grant:r "<DOMAIN\user>:F"` (take the name from `whoami`). Strip copy residue such as a trailing comma.
- Check the actual state before acting: `GET http://127.0.0.1:<api.port>/v1/daemon` (pid, version, manifestPath, owner, busy), the manifest it names, and the last `dinobot up:` line of `<dataDir>/dinobot.log`. Back up the manifest before editing.
- Default to `allowedChannelIds: ["*"]`: inviting the bot to a channel is enough, DMs need no `D...` ID, and `allowedUserIds` still decides who may talk. List channel IDs only when the user wants to restrict where it answers.
- Verify each step with real evidence (script output, boot line, inbox job, Slack reply). A step that only "ran" is not done.

## Workflow

### 1. Inspect

Read the daemon info and manifest. If `channels.slack` already exists, go to troubleshooting instead of starting over. Socket Mode is the default: it needs no public URL. Use `transport: http` only if the user already runs an HTTPS reverse proxy (dinobot skill, channels reference).

### 2. The user creates the app

Write `slack-app-manifest.json` to a file the user can open, show its path, and give these steps (change `name`/`display_name` first if the user wants another bot name):

1. Open https://api.slack.com/apps → **Create New App** → **From a manifest** → pick the workspace → paste the JSON → **Next** → **Create**.
2. **Install to Workspace** → **Allow**. Copy the **Bot User OAuth Token** (`xoxb-...`, under OAuth & Permissions).
3. **Basic Information → App-Level Tokens → Generate Token and Scopes**, any name, scope `connections:write` → copy the `xapp-...` token.
4. In Slack: own profile → **⋮** → **Copy member ID** (`U...`).

Ask for the two tokens as files (for example `<config dir>/slack/bot-token` and `app-token`, one token each) and the member ID in chat. If the app was made by hand, compare it with the manifest: missing `message.channels`/`message.groups` events or the Messages tab are the usual gaps.

### 3. Verify tokens and derive IDs

```bash
bun slack-check.mjs --bot-token-file <bot-token> --app-token-file <app-token> --member U... --test-dm U...
```

Expect `ok: true`, `checks.botToken/appToken: ok`, an `appId` confirmed by the hello frame, and `testDm: ok` (the user now sees the bot's DM). The output includes the `channels.slack` block. Fix any failing check with the troubleshooting table before continuing.

### 4. Credentials for the daemon

dinobot reads `botTokenEnv`/`appTokenEnv` from the daemon's environment at start; use `DINOBOT_SLACK_BOT_TOKEN` and `DINOBOT_SLACK_APP_TOKEN`. Persist them for future starts, reading values from the token files (never typing them into a command line):

- Windows: in a PowerShell script, `[Environment]::SetEnvironmentVariable("DINOBOT_SLACK_BOT_TOKEN", (Get-Content -Raw <file>).Trim(), "User")`; use `$env:USERPROFILE` instead of literal non-ASCII paths. Applies to newly started processes only.
- Linux/macOS with a systemd unit: an `EnvironmentFile=` readable only by the user. Plain shell start: export them in the shell profile from the files.

The restart script also injects them explicitly, so the restart does not depend on which terminal started the TUI.

### 5. Write the manifest block

Create `<dataDir>/slack/` (owner-only) and add the block from step 3 with `databasePath: "<dataDir>/slack/slack.sqlite"`, the user's member ID in `allowedUserIds`, `allowedChannelIds: ["*"]`. Mind YAML quoting of Windows paths (`"C:\\Users\\..."`). Keep `toolProgress`, `deliveryRecovery`, `fileReplies` at their defaults unless asked.

### 6. Prove it boots before touching the live daemon

Copy the manifest, point `bot.dataDir` and `databasePath` to a temporary directory and `api.port` to a free port, then run the new channel with the credentials in the environment for about 20 seconds:

```bash
timeout 20 dinobot serve --config <copy> 2>&1 | grep -E "dinobot up:|error"
```

`dinobot up: ... channels=slack ...` proves the manifest, both tokens and the Socket Mode connection. Errors map to the troubleshooting table. Delete the temporary directory afterwards.

### 7. Restart the live daemon yourself

Restarting ends every running turn and disconnects the TUI, so it must wait for idle threads, and it must run outside the daemon's process tree:

```bash
bun restart-when-idle.mjs --env DINOBOT_SLACK_BOT_TOKEN=<bot-token> --env DINOBOT_SLACK_APP_TOKEN=<app-token> \
  --rollback <manifest backup> --notify-token-file <bot-token> --notify-channel <dmChannelId from step 3>
```

- Run `--dry-run` first from your own shell; it prints the discovered manifest, log, `dinobot` command and busy threads without acting.
- Windows: `powershell -NoProfile -ExecutionPolicy Bypass -File detach-windows.ps1 -Exe <bun.exe> -Arguments '"<restart-when-idle.mjs>" --env ...'` (bun path from `Get-Command bun`).
- Linux/macOS: `setsid nohup bun restart-when-idle.mjs ... >/dev/null 2>&1 </dev/null &`. If dinobot runs as a systemd unit, `GET /v1/daemon` reports a non-`tui` owner and the API refuses (`external`): restart with `systemctl --user restart <unit>` instead.
- Your own turn counts as busy, so tell the user the restart happens once all sessions are idle, that the TUI must be reopened afterwards, and that the outcome arrives as a Slack DM. Then end your turn.

The script writes `restart-result.json` and `restart-trace.log` next to the manifest. On the next turn, read them and the boot line; `ok: true` with `channels=slack` completes this step.

### 8. Prove a real round trip

Ask the user to `/invite @dinobot` in a channel and mention it, reply in that thread without a mention, and DM it. Each should get an answer. If not, run `slack-check.mjs --thread <channel> <ts> --inbox <databasePath>` and follow `references/troubleshooting.md`.

### 9. Tell the user how to use it

Mention `@dinobot` in any channel it was invited to and keep talking in the thread without mentions; DMs work too. Controls go through a mention in a thread: `@dinobot /models`, `@dinobot /model provider/modelId`, `@dinobot /new` (Slack slash commands are not registered). Up to 4 attachments per message (PNG/JPEG/GIF/WebP images up to 2 MiB, UTF-8 text up to 64 KiB). Answers over 12000 characters arrive as a `.txt` file.
