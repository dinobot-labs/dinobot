# Slack troubleshooting

Work from evidence: the daemon boot line, the inbox jobs and what Slack itself shows. `scripts/slack-check.mjs` reads all three (`--thread <channel> <ts>` lists a thread as Slack sees it, `--inbox <databasePath>` lists dinobot's received jobs). A Slack message that is visible in the thread but has **no inbox job** never reached dinobot or was rejected before admission. A job that exists but has no reply failed in the turn or the delivery: check its `state` and `error`.

## Boot and connection

| Symptom | Cause | Fix |
|---|---|---|
| `error: Missing native channel credential environment variable` (exit 1) | An env var named by `botTokenEnv`/`appTokenEnv` is missing in the daemon process. A TUI-started daemon inherits the environment of the TUI that started it, so a variable set after that terminal opened is not there. | Restart with `scripts/restart-when-idle.mjs --env NAME=<file>` (injects the value), and persist the variable for future starts. |
| `error: Invalid Slack bot credential` / `Invalid Slack app credential` | The value is not one `xoxb-` / `xapp-` token (a stray comma, quote or newline copied from a web page). | Rewrite the token file with only the token. |
| `error: start channel slack failed` (exit 1) | Slack refused the Socket Mode connection: wrong or revoked app token, the token lacks `connections:write`, or Socket Mode is off. | `scripts/slack-check.mjs` → `checks.appToken`. Regenerate the App-Level Token or enable Socket Mode. |
| `invalid manifest: channels.slack/allowedChannelIds ...` | `"*"` mixed with IDs, an empty list, or an ID that is not `C`/`D`/`G` + uppercase letters/digits. | Use `["*"]` alone, or only canonical IDs. |
| Boot line says `channels=-` | The running daemon was started before `channels.slack` was added, or with another manifest (`GET /v1/daemon` shows `manifestPath`). | Restart; check the manifest path. |

## Messages that get no answer

| Symptom | Cause | Fix |
|---|---|---|
| `@dinobot` in a channel: no answer, no inbox job | The bot is not in the channel (`/invite @dinobot`), the app lacks `app_mention`, the channel is not allowed (not listed and no `["*"]`), or the sender is not in `allowedUserIds`. Rejections are silent by design. | Invite the bot; check the manifest events; add the member ID. |
| Every message is ignored although IDs look right | `appId` or `teamId` in dinobot.yaml does not match the events (403 before admission). | Take `appId` from the Socket Mode hello frame (`slack-check` prints it) and `teamId` from `auth.test`. |
| The first mention works, follow-ups in the same thread without a mention do not | The app is not subscribed to `message.channels` (public) / `message.groups` (private). Having the `channels:history` scope is not enough: Slack only sends subscribed events. | Add the events under Event Subscriptions → Subscribe to bot events → Save. Reinstall if Slack asks. No dinobot restart is needed. |
| DM to the bot: "Sending messages to this app has been turned off" | App Home → Messages Tab is off. | Turn on Messages Tab and "Allow users to send Slash commands and messages from the messages tab" (the bundled app manifest does this). |
| DM is silent | `message.im` not subscribed, the DM channel not allowed (list its `D...` ID or use `["*"]`), or the sender not in `allowedUserIds`. | Same checks as above. |
| Messages sent while dinobot was stopped never get an answer | Slack does not redeliver events a disconnected Socket Mode app missed. | Send them again. |
| Native `/model` slash command does nothing | dinobot does not register Slack slash commands. | Use `@dinobot /model provider/modelId`, `@dinobot /models`, `@dinobot /new` in a thread. |

## Replies and progress

| Symptom | Cause | Fix |
|---|---|---|
| Short answers arrive, answers over 12000 characters do not | They are uploaded as a `.txt` file, which needs `files:write`. | Add the scope and reinstall, or set `fileReplies: false` to split them into messages instead. |
| Attachments are not read | `files:read` is missing. | Add the scope and reinstall. |
| No live plan/task card, only a text progress message | The workspace or app does not allow native streaming; dinobot falls back to editable text by design (`toolProgress: native`). | Nothing to fix; `toolProgress: text` or `off` changes the style. |
| A reply carries "♻️ 복구된 응답" | Delivery was uncertain after a failure or restart and was retried (`deliveryRecovery: true`). Duplicates are possible. | Expected behaviour. |

## App changes

- Changing scopes or events: Slack shows a reinstall banner. Reinstalling normally keeps the same `xoxb-` token. If the token changed, rewrite the token file and restart.
- A token pasted into a chat is now in that chat's history. Move it into a file immediately and suggest regenerating it if the history leaves the machine.
- Rotating tokens: regenerate in Slack, rewrite the file, update the persisted env var, restart with `restart-when-idle.mjs`.
