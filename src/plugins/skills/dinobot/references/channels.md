# Channels

Channels connect messengers to the daemon. Each is enabled by a key under `channels:` in the manifest; an unknown key fails boot. Channel changes take effect only after a daemon restart (see `cli-and-daemon.md`).

Source: `src/channels/index.ts`, `src/channels/types.ts`, `src/manifest.ts`

| Channel id | Transport | Credentials | Status in code |
|---|---|---|---|
| `http` | Loopback HTTP server (`127.0.0.1`) | none | implemented |
| `slack` | Events API webhook (`transport: http`) or Socket Mode WebSocket (`transport: socket`) | env vars | implemented |
| `telegram` | Webhook (default) or long polling (`mode: polling`) | env var or private file | implemented |
| `discord` | Signed interactions webhook (application commands only) | public key in manifest; no secret | implemented |

Teams is not implemented. `openwiki/architecture/channels.md` still lists Slack as planned; the code catalog is authoritative.

All native channels (`slack`, `telegram`, `discord`) bind only to `127.0.0.1`. Webhook modes need your own HTTPS reverse proxy that forwards the **unmodified** body and signature headers to `POST /webhook` on the configured port. Never expose `/healthz`, the `http` channel, or the client API publicly.

## `http`

Source: `src/channels/http.ts`, `openwiki/contracts/channel-contract.md`

| Field | Type | Required | Range |
|---|---|---|---|
| `port` | integer | yes | 1–65535 |

- Routes: `GET /healthz` → `ok`; `POST /v1/messages`; `POST /v1/native/messages` (only exact `/model`, `/models`, `/new` for `channel` `telegram`/`discord`/`slack`; used by the Telegram sidecar).
- Body: `threadKey`, `messageId`, `userId`, `text` (non-empty strings; `text` may be empty if `images` present), optional `channel` (default `http`; no `:`), optional `images: [{mimeType, data}]`, optional `files: [{name, mimeType, data}]` (one file, canonical base64, ≤20 MiB), optional `whenBusy: "steer"`. Text may also be empty when a file is present. Generic files are stored by core under its trusted workspace; model input contains metadata/absolute path, not base64. The sidecar checks `GET /v1/capabilities` (`files.version=1`) before submitting files to avoid silent loss with old cores.
- Reply: `BotReply` JSON (`{status:"answered",text}` or `{status:"unanswered",reason}`). With `Accept: application/x-ndjson` the reply streams progress lines, a heartbeat every 10 s, then one `reply` or `error` line.
- Limits: 40 MiB request, 65,536 UTF-16 text units, 32 concurrent handlers (then 503 + `Retry-After: 1`).
- Unauthenticated: the request names the channel and user. Daemon slash commands with the `channel` surface (e.g. `/help`, `/model`, `/plugins`) are run for this channel (`src/core/channel-handler.ts`).

Example: `curl -s localhost:8787/v1/messages -H 'content-type: application/json' -d '{"threadKey":"demo","messageId":"m1","userId":"me","text":"hello"}'`

## Shared fields of native channels

Source: `src/channels/messaging.ts`

Every native channel has a private SQLite inbox (durable admission, retry, delivery). Use a separate file per adapter in a mode 0700 directory, never the main bot DB; create the parent directory first.

| Field | Type | Required | Default | Range |
|---|---|---|---|---|
| `port` | integer | see channel | — | 0–65535 (0 = any free local port) |
| `databasePath` | string | yes | — | non-empty |
| `allowedUserIds` | string[] | see channel | — | 1–1000 unique |
| `maxRows` | integer | no | 10000 | 1–100000 |
| `retentionSeconds` | integer | no | 604800 | 600–2592000 |
| `requestTimeoutMs` | integer | no | 10000 (Telegram polling requests: 30000) | 50–30000 |
| `maxAttempts` | integer | no | 5 (Slack: 3) | 1–10 |
| `maxResponseBytes` | integer | no | 65536 | 1–262144 |
| `handlerTimeoutMs` | integer | no | — | deprecated, accepted and **ignored** |

- Turns have no lifetime deadline (ADR 0055). A failed turn sends a visible failure notice asking the user to resend.
- Native channels bypass the daemon's slash-command middleware: only `/model`, `/models` and `/new` work there (manifest `commands.disabled: [model]` blocks the model controls). `/login` etc. are TUI-only.
- Credential env-var values are read at daemon start; a missing one fails boot ("Missing native channel credential environment variable").

## `slack`

Source: `src/channels/slack.ts`, `src/channels/slack-socket.ts`, `openwiki/runbooks/slack.md`, `openwiki/decisions/0061-slack-hermes-features.md`

| Field | Type | Required | Default / values |
|---|---|---|---|
| `transport` | `http` \| `socket` | no | `http` |
| `botTokenEnv` | env var name | exactly one of these two | value must be `xoxb-...` |
| `botTokenFile` | path | exactly one of these two | same value rules; private file (POSIX 0600 / Windows owner DACL), ≤ 1024 bytes |
| `signingSecretEnv` | env var name | yes for `http` | value: 32 hex chars |
| `appTokenEnv` | env var name | exactly one of these two, for `socket` | value: `xapp-...` (App-Level Token, `connections:write`) |
| `appTokenFile` | path | exactly one of these two, for `socket` | same value rules; private file like `botTokenFile` |
| `appId` | string | yes | `A[A-Z0-9]+` |
| `teamId` | string | yes | `T[A-Z0-9]+` |
| `botUserId` | string | yes | `U...` or `W...` |
| `allowedUserIds` | string[] | yes | `U...`/`W...`, 1–1000 |
| `allowedChannelIds` | string[] | yes | `C...`/`D...`/`G...`, 1–1000 (list DM `D...` ids explicitly), or `["*"]` alone for every channel/DM the bot receives events from |
| `port` | integer | no | 0 (random local port); fix it for `http` |
| `toolProgress` | `native` \| `text` \| `off` | no | `native` (plan task cards; falls back to editable text) |
| `deliveryRecovery` | boolean | no | `true` (uncertain replies retried with a visible "possible duplicate" marker) |
| `fileReplies` | boolean | no | `true` (replies over 12000 chars sent as a UTF-8 `.txt`; needs `files:write`) |

Env var names are your choice; the example manifest uses `DINOBOT_SLACK_APP_TOKEN` and `DINOBOT_SLACK_BOT_TOKEN`.

Guided setup: `/setup` → channels → Slack runs the whole connection in the TUI: it prints a manifest-prefilled app-creation link, verifies both pasted tokens live (deriving `appId`/`teamId`/`botUserId`), stores them in protected files via `botTokenFile`/`appTokenFile`, and applies with a safe restart. When the user asks in chat instead, load the `slack-setup` skill: it ships a paste-in Slack app manifest (scopes, events, Socket Mode, Messages tab), a token check that derives `appId`/`teamId`/`botUserId`, and a restart script; the user only creates the app and copies two tokens and their member ID.

Setup:
1. Create and install the Slack app. Bot scopes: `chat:write`, `app_mentions:read`, `im:history`; add `channels:history`/`groups:history` for thread follow-ups without a mention, `files:read` for attachments, `files:write` for file replies.
2. Subscribe to `app_mention`, `message.im` (plus `message.channels`/`message.groups` for thread follow-ups) and invite the bot to the channels.
3. Socket Mode (no public URL): enable Socket Mode, create the `xapp-` token, set `transport: socket`, `appTokenEnv`. HTTP: disable Socket Mode, set `signingSecretEnv`, a fixed `port`, and point the Request URL through your HTTPS proxy to `/webhook`. Do not run both for one app.
4. Put the secrets in the daemon's environment, add the block, restart the daemon.

Wildcard channels: `allowedChannelIds: ["*"]` (alone; mixing it with IDs fails validation) admits any canonical `C`/`D`/`G` conversation that Slack delivers, so inviting the bot to a channel is enough and DMs need no `D...` id. Slack still only delivers events from channels the bot was invited to (and DMs). `allowedUserIds` is unchanged and still decides who may talk; there is no user wildcard. With `message.channels`/`message.groups` subscribed, thread replies by allowed users in any channel the bot is in are admitted, exactly as if that channel were listed.

Use: start with `@bot` in a channel and continue in the same thread; DMs work. Controls: `@bot /models`, `@bot /model provider/modelId`, `@bot /new` (Slack native slash commands are unsupported). Attachments: up to 4 per message, PNG/JPEG/GIF/WebP images (2 MiB each) and UTF-8 text files (64 KiB each).

## `telegram`

Source: `src/channels/telegram.ts`, `src/channels/telegram-polling.ts`, `src/cli/telegram-setup.ts`, `src/cli/telegram-run.ts`, `openwiki/runbooks/messaging-channels.md`, ADR 0043, 0048, 0057

| Field | Type | Required | Default / values |
|---|---|---|---|
| `mode` | `webhook` \| `polling` | no | `webhook` |
| `databasePath` | string | yes | — |
| `botTokenEnv` | env var name | exactly one of these two | — |
| `botTokenFile` | path | exactly one of these two | regular file, owner = daemon user, private permissions (POSIX 0600 / Windows owner + DACL), ≤ 1024 bytes |
| `port` | integer | yes for `webhook` | — |
| `webhookSecretEnv` | env var name | yes for `webhook` | value `[A-Za-z0-9_-]{1,256}` |
| `pairingPath` | path | either this, or both allow-lists | written by `telegram connect` |
| `allowedUserIds` | numeric string[] | see above | 1–1000 |
| `allowedChatIds` | string[] (`-?[0-9]+`) | see above | 1–1000 |
| `progress` | `detailed` \| `status` \| `off` | no | `detailed` |
| `steering` | `on` \| `off` | no | `on` |
| `schedulerMode` | `topic` \| `global` | no | `topic` |
| `concurrency` | integer | no | 12 (1–16; `global` allows only 1) |

The example manifest names the env vars `DINOBOT_TELEGRAM_TOKEN` (bot token) and `DINOBOT_TELEGRAM_SECRET` (webhook secret).

Webhook mode: call Bot API `setWebhook` yourself with your HTTPS URL, `secret_token` equal to the secret, `allowed_updates=["message"]`; the proxy forwards to `POST /webhook`. Requests are checked against `X-Telegram-Bot-Api-Secret-Token`.

Polling mode (no public address): outbound `getUpdates` only; no HTTP listener. Startup fails if a webhook is set ("webhook must be absent"); dinobot never deletes it. Run only one poller per bot, and never polling and webhook together.

### Easy setup: `dinobot telegram connect`

1. Save the BotFather token in a private file/directory (POSIX: file 0600, directory 0700; Windows: current-user owner and private DACL, not chmod). Never put it in argv, chat or YAML.
2. `dinobot telegram connect --token-file /abs/token --pairing-file /abs/pairing.json [--timeout-seconds 1..900]` (default 300). It refuses an existing pairing file (no owner reset) or a configured webhook.
3. Open the printed one-time link yourself and press Start (or send `/start <code>` in a private chat). Only that private human sender becomes owner.
4. It prints a manifest snippet (`mode: polling`, `botTokenFile`, `pairingPath`, `databasePath: <pairing>.sqlite`, `port: 0`); it does not edit the manifest. Add it and restart the daemon — or use the sidecar instead.

Private-file contract: see canonical `openwiki/runbooks/messaging-channels.md`, “Telegram private 파일”. On Windows x64/arm64, reads reject reparse points and validate the owner/DACL on the same native handle; allow ACEs may name only the current user, SYSTEM or Administrators. Unsafe existing files are refused, not repaired. `/setup` creates files with a protected current-user-only DACL before writing, and can replace a stale token on retry; `telegram connect` still never overwrites an existing pairing owner. New source guidance does not imply an installed/running bundle has been updated.

### Sidecar: `dinobot telegram run`

Runs polling in a separate process and forwards turns to an already running daemon's `http` channel, so the core need not restart.

| Flag | Required | Default |
|---|---|---|
| `--token-file <path>` | yes | — |
| `--pairing-file <path>` | yes | — |
| `--database <path>` | yes | — |
| `--core-url http://127.0.0.1[:port]` | no | `http://127.0.0.1:8787` (loopback only; the `http` channel port, not `api.port`) |
| `--port <1-65535>` | no | 8791 |
| `--scheduler-mode topic\|global` | no | `topic` |
| `--concurrency 1..16` | no | 12 (`global`: 1 only) |
| `--progress detailed\|status\|off` | no | `detailed` |
| `--steering on\|off` | no | `on` |

Each flag may appear once. Errors print only `dinobot: Telegram command failed; ...` (exit 1) so the token never leaks. The sidecar exits when polling fails; a turn fails if the core sends no heartbeat for 60 s. Ordinary text is prefixed so it can't trigger local slash commands; `/model`, `/models`, `/new` go to `/v1/native/messages` (an older core answers with an upgrade notice).

### Topics, groups, controls

- Conversation key: `botId:chatId:topicId:userId` — separate context per user and per topic.
- Groups: add the bot, then the paired owner sends `/enable` in the group (forwarded commands are rejected). Other group members are not authorized. With privacy mode on, plain group messages may not reach the bot.
- Private-chat topics require enabling the bot's topic feature in BotFather.
- `topic` scheduler: FIFO within a bot/chat/topic lane; up to `concurrency` lanes at once. All API calls share a rate gate (per chat ~1 msg/s, 20/min).
- Controls: `/models`, `/models <provider> <page>`, `/model`, `/model provider/modelId`, `/new` (bare form; `/cmd@botname` is unsupported).
- Progress card: typing indicator, then a silent status message updated at most every ~3 s with tools, todos and an answer draft tail; `status` uses fixed safe wording, `off` sends only the answer.

## `discord`

Source: `src/channels/discord.ts`, `openwiki/runbooks/messaging-channels.md`

| Field | Type | Required | Notes |
|---|---|---|---|
| `port` | integer | yes | loopback `/webhook` listener |
| `databasePath` | string | yes | — |
| `applicationId` | numeric string | yes | — |
| `publicKey` | 64 hex chars | yes | not a secret |
| `allowedUserIds` | numeric string[] | yes | 1–1000 |
| `allowedChannelIds` | numeric string[] | at least one of these two | thread/channel ids |
| `allowedParentChannelIds` | numeric string[] | at least one of these two | admits only signed child threads (types 10/11/12) of these parents |

No bot token or env var is used; replies go through the interaction token (expires ~15 min after the interaction; a later answer ends as `token_expired`, no public fallback).

Setup: register application commands yourself (dinobot does not): `/ask` with required STRING option `prompt`; optional `/model` (STRING `model`), `/models` (STRING `provider`, INTEGER `page`), `/new` (no options). Set the Portal's Interactions Endpoint URL to your HTTPS proxy → `/webhook`. Gateway/message-content intent is not needed; plain messages are not ingested.

Use: `/ask prompt:<text>` in an allowed channel or thread for every turn. Replies are ephemeral (only the invoker sees them); answers over 2000 chars (or with unsafe links) arrive as `answer.txt`. Key: `applicationId:channelId:userId`.

## Per-thread behavior

Source: `src/channels/messaging.ts`, `src/channels/telegram.ts`, `src/tui/app.ts`, ADR 0046, 0048, 0057

- **One key = one durable conversation.** Redelivered native messages are deduplicated by message id.
- **Steering** (a message joins the running turn instead of waiting): Telegram (same bot/chat/topic/user, at most 4 extra messages per running turn; card shows `📨 추가 메시지 N건 반영`; one answer for all; `steering: off` restores FIFO), the TUI (sending while an answer runs), and `http` clients sending `whenBusy: "steer"`. Slack and Discord have no steering and use a single global FIFO lane (one turn at a time across the channel).
- **`/new`** (Telegram, Slack `@bot /new`, Discord `/new`): the same key points to a fresh conversation; the old one stays readable as `<key>#<n>`. Model, reasoning, working directory and fast setting carry over. Refused while a turn is running/queued or a subagent runs; an empty conversation is not rotated. In the TUI, `/new [name]` simply opens a new thread.
- **`/model`** in a messenger changes only that user's thread/topic; it is refused while the conversation is busy. Only signed-in providers are listed; logins cannot be done from messengers.
