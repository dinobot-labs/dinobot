# Slack assistant (opt-in, bot-only sending)

## Desktop integration contract

Use the existing daemon command protocol: start /setup channels in a **local tui conversation**, select checklist id **slack-personal**. This also reconnects an existing configuration. Do not send credentials as chat messages or add a secret-bearing HTTP endpoint.

Prompt sequence:
1. Text: separate Slack app name.
2. Select: **bot** (recommended, two tokens) or **personal** (optional read-only user-token access). All sending stays bot-only.
3. Print: official app-create URL with encoded manifest. Bot scopes cover message/file sending, channel/DM listing and history. Only personal includes read-only user scopes. Create the app, enable Socket Mode, install it, invite it to channels.
4. Secret: xoxb bot token; server auth.test + bots.info.
5. Secret: xapp app token with connections:write; server apps.connections.open and short hello probe, then close. Bot/app IDs must exist and match.
6. Bot mode: text Slack member ID (profile → Copy member ID), configured by the local operator as owner. This is configuration, not proof that the operator owns that Slack account; remote calls still require that authenticated Slack sender. Personal mode: secret xoxp token; auth.test derives owner, checks matching workspace and exactly approved read-only scopes (no write/unknown scopes).
7. Normal setup apply event stages paths, never token values. Existing CAS/apply/restart flow remains the only configuration endpoint.

Tokens render as secret fields and travel through existing command replies. SlackSetupError kinds: invalidAuth, revoked, inactive, missingScope, network, unexpected, badResponse, socketModeOff. App/team mismatch use unexpected details. Validation failure offers retry/skip; cancellation cannot overwrite active credentials.

New credentials are protected files in slack/<random-generation>/{bot,app,user}.token beside the manifest. Bot mode creates no user file. Reconnect does not delete old generations automatically because the running daemon may still hold them.

Staged configuration:

    channels.slack:
      transport: socket
      botTokenFile: <protected bot path>
      appTokenFile: <protected app path>
      databasePath: <data>/slack.sqlite
      port: 0
      appId: <verified app>
      teamId: <verified team>
      botUserId: <verified bot>
      allowedUserIds: [<owner>]
      allowedChannelIds: ["*"]
    plugins.slack_personal:
      botTokenFile: <same protected bot path>
      # userTokenFile: <optional protected read-only user path>
      ownerUserId: <owner>
      teamId: <verified team>
      databasePath: <data>/slack-personal.sqlite

Optional keys: transferDirectory (default sibling slack-transfers), pollIntervalSeconds (60..3600, default 300). Plugin is opt-in. Credentials revalidate on load. Existing channel remains the sole long-lived Socket Mode consumer. Changing workspace, owner, bot app or read mode discards old monitoring state.

## Deterministic local command contract (v1)

Desktop/TUI must use the existing command protocol, **not model tools or chat messages**, for these controls. Discover **slack** in GET /v1/commands; dispatch POST /v1/threads/tui/<local-thread>/commands with {"name":"slack","args":"status"}. Use an initialized local thread so notifications belong to the selected workspace. Both local surface and channel are checked; remote messenger commands (including the Slack owner DM) and local API requests selecting a remote thread are denied.

Arguments (no leading slash in the API's args):

- **status**: read disk configuration presence and the loaded plugin's actual monitor state. No Slack/network/model/tool call.
- **monitor <JSON>**: validate the entire object, resolve the local conversation, synchronously commit monitoring to the plugin's protected SQLite state, and return actual committed status. No manifest apply/restart needed.
- **disconnect**: fence and durably disable the loaded monitor immediately, then emit the existing **apply** request removing only channels.slack and setting plugins.slack_personal: false. It does not write the manifest, close the live bot channel, revoke/delete credentials, or restart a daemon. An already admitted notification cannot be recalled; subsequent in-flight poll effects and deliveries are fenced.

Monitor example (the UI sends this directly, never asks the user to copy a tool request):

    {"enabled":true,"channels":["C0123ABCD","D0123ABCD"],"intervalSeconds":300,"timeZone":"Asia/Seoul","quietStart":22,"quietEnd":8,"summaries":true}

Required: boolean enabled, channels (0..5 unique IDs matching ^[CDG][A-Z0-9]{2,}$; at least one when enabled), valid IANA timeZone (1..64 characters). Optional: integer intervalSeconds 60..3600 (retains prior durable interval, or manifest/default 300 initially), boolean summaries (false), integer quietStart/quietEnd 0..23 (22/8). Equal quiet endpoints mean no quiet hours. Unknown fields, coercions, invalid JSON and invalid time zones fail without modifying monitoring. To disable without disconnecting:

    monitor {"enabled":false,"channels":[],"timeZone":"Asia/Seoul"}

Channel IDs are syntax-validated, not membership-verified: polling reports Slack permission errors. Every successful configuration resets prior scans/candidates/outbox/deadlines, binds the notification destination to the invoking local conversation and persists interval/watch together. Reopening the same account restores them; changing account identity resets them.

### Output and schema

Successful stream: started, exactly one output whose text is a JSON object, then done. Disconnect additionally emits apply **before** that output. No prompts. Treat terminal error as failure; never parse prose or assume an apply event means activation. Versioned response schema: **SlackCommandStatusSchema** in src/commands/slack.ts; monitor input schema: **SlackMonitorConfigSchema** in src/plugins/slack_personal/control.ts (also used by the existing model tool). Full JSON schemas for downstream clients are pinned in **docs/slack-command-v1.schema.json** under statusResponse and monitorInput; a regression test checks exact equality with the executable schemas.

    {
      "kind":"slack.status",
      "version":1,
      "configured":{"source":"manifest-on-disk","channel":true,"personal":true},
      "runtime":{"loaded":true,"started":true,"connection":"unknown","teamId":"T0123ABCD","ownerUserId":"U0123ABCD","readIdentity":"bot"},
      "monitor":{"started":true,"enabled":false,"watch":null,"lastPollAt":null,"lastError":null,"intervalSeconds":300,"threadError":null,"trackedThreads":0,"delivery":"local only; ..."},
      "disconnect":{"configuration":"not-staged","connection":"unchanged","restartRequired":false}
    }

- **configured** describes entries currently on disk, not staged intent or proven connectivity. source: "unavailable" means an embedder supplied no manifest location (false booleans are not evidence of disconnection); unreadable/invalid manifests produce an error.
- **runtime.loaded** means the plugin service loaded and credentials validated at load; started means its host runtime was bound. connection: "unknown" is deliberate: neither proves current Socket Mode connectivity. Identity fields are null when unloaded. readIdentity is bot/user/null; all sending stays bot-only.
- **monitor** is null when the service is unavailable, otherwise the shared monitor's snapshot. watch is null when disabled, otherwise {conversationId, channels, timeZone, quietStart, quietEnd, summaries}. lastPollAt is epoch milliseconds or null; it and sanitized lastError/threadError are process-local diagnostics, not persisted health guarantees. trackedThreads is the durable root count. delivery explains bounded polling; it is informational, not a parse target.
- After disconnect handoff, **disconnect.configuration: "staged", connection: "unchanged", restartRequired: true**. Do not show “Slack disconnected” yet. Show “Monitoring stopped; connection disable awaiting apply/restart.” With no loaded monitor, show its state as unavailable rather than claiming it stopped. Staged is remembered by this command registry until restart, not a durable apply receipt. Re-enabling via command or tool is refused by the loaded service until restart. The disabled watch itself is durable, including if the client cancels/loses the apply.

Handle apply through the existing front-end manifest transaction (validation, baseSha256 CAS, daemon identity/ownership, idle check, journal/restart). On **applied**, reconnect and query status again. On **saved_external**, configuration was saved but the external owner's restart is still required; do not stop its daemon. Conflict/busy/invalid/failure must remain visible, not reported as disconnection. Preserve tokens and unrelated configuration. Like setup, apply is a sensitive full-manifest transport payload: never render/log its candidate as a chat reply (unrelated pre-existing inline secrets can be present). The new JSON status/error replies contain no token contents or token-file paths and do not read credential files.

## Tools and permissions

Prefix: slack_personal_. Tools: status, list, history, replies, search, download, send, upload, monitor, deadline. Schemas are in the plugin catalog; the status tool is separate from the deterministic local /slack command above. Neither adds an HTTP route.

Status includes teamId, ownerUserId, access=local-or-owner-private-dm, readIdentity=bot or user, transferDirectory, enabled, watch, lastPollAt, lastError, threadError, trackedThreads, intervalSeconds and delivery explanation. Config presence is not live connectivity evidence.

Bot-only mode reads conversations/files the bot can access and sends messages/files as that bot. Optional user token extends reads to user-accessible channels/DMs and enables search. It never enables user-identity sending. Search without a user token gives an explicit unsupported-mode error, not an empty successful result. All reads obey Slack permissions, membership, retention and API limits; neither credential grants administrator access.

Cursor tools return messages/channels, nextCursor, complete and pages. Pages are 15 records, 1..5 pages/call. Continue nextCursor until complete to enumerate accessible history. Search: page 1..100, count 50 with Slack native paging. No full-archive claim without exhausting continuation.

Only fixed read methods use the optional user token. Only bot token calls write methods. Files use files.info and HTTPS files.slack.com, redirects denied; signed upload URLs receive no bearer. Max 10 MiB. Dedicated flat transfer directory: no overwrite, traversal, alternate streams, device names, links or hardlinks. Copy upload files there first.

Slack replies reference (retrieved during implementation; lists bot and user history scopes):
https://docs.slack.dev/reference/methods/conversations.replies

## Trusted owner / private disclosure boundary

Slack admission verifies transport credentials, app/team, sender allowlist and canonical destination, then constructs a host thread key [app, team, channel, rootTimestamp, sender]. Host PluginToolCall.slackPrincipal resolves that committed binding, following subagent parents. It never parses message text, names, from-markup or model arguments for identity.

Plugin permits local tui calls or a Slack principal matching the loaded bot app, configured team and owner, **only in a D-prefixed one-to-one DM**. Other senders, shared C/G channels, foreign app/team, unknown/malformed/unbound/cyclic/archived bindings fail closed before private API calls. Missing bot app identity denies remote access. Subagents inherit the same destination boundary, not additional privilege. Local daemon API access remains local-operator authority (pre-existing single-user trust boundary), not a sandbox against a compromised local process.

Monitor configure/disable is **local-only even for the verified Slack owner**. Its persisted destination is the opted-in local conversation; automatic private summaries never post to Slack. Owner may manually request reads or explicit bot sends from their private bot DM. Prompts prohibit auto-posting; there is no new human-confirmation system for each send.

User auth.test establishes workspace/identity/scopes, not app identity. A same-workspace user token from another app with identical approved read scopes cannot be distinguished. Do not claim three-way app matching.

## Monitoring and latency

Select up to five channels/DMs. Each interval:
- One history page, rotating channels, with fixed oldest/latest window and durable cursor until complete. Initial discovery walks retained history so old roots with new replies can be found; pre-activation messages never create new notices.
- One tracked-thread reply page, least-recently-serviced first, with separate durable fixed window/cursor per root. Failed/incomplete roots rotate too; more than 100 roots are not truncated. Roots remain until monitoring reset, so registry size grows with discovered history.
- At most one unanswered-candidate check. Incomplete evidence never establishes unanswered status.
- Up to 100 due deadlines selected **by due time before the bound**, then ten pending local wake deliveries. Future deadlines cannot hide a lexically later due deadline. Remaining due/outbox work drains on later intervals without duplicate host admission.

At defaults, five quiet channels need about 25 minutes per history sweep. T tracked roots need roughly T × 5 minutes for one reply-page sweep: 100 roots can take about 8 hours 20 minutes. Initial history discovery, multi-page threads, API errors and Retry-After add latency. This is fair bounded polling, **not realtime** and not guaranteed coverage before Slack retention removes data. Status reports root count and errors. Permission failures are not empty successful reads.

DM messages and owner mentions, including discovered thread replies, are candidates, not confirmed tasks. After one hour an unanswered check can create a notice. Later owner replies suppress queued unanswered notices; later DM answers are only a conservative semantic heuristic. Candidate evidence retains a bounded 100-record sample; hourly summaries sample up to ten messages, not full channels. Natural-language deadlines remain uncertain; explicit deadline requires an offset-qualified datetime.

Quiet hours default 22–08 in an explicit IANA zone; equal endpoints disable quiet hours. Durable SQLite outbox and stable host wake keys deduplicate replay/crash-after-admission. Configure/disable fences in-flight polling. State contains private snippets/IDs, is a protected file registered as host storage, and is not encrypted.

## Verification boundary

Tests use injected Slack responses, real temporary SQLite/private files, and existing signed HTTP / local WebSocket channel integration. Deadline starvation reproduced before the fix (expected ten admissions, actual zero). Regression covers 100 future deadlines plus 105 due deadlines, eventual delivery once and no future delivery. Added old-root threaded mention, restart/cursor fairness, 105-root fairness, bot-only setup, owner-private-DM allow/deny and credential-identity tests.

Final focused/setup/principal/host-wake/codemode run: 86 passed / 0 failed, 500 assertions (six files). Direct and codemode-only host tests prove private-owner admission and shared-channel denial despite forged model text. Earlier channel integration/socket/recovery run: all 120 tests passed (846 assertions, eight files, overlapping the focused suite); the 46 native-channel tests passed there and channel code was not changed afterward. Final full TypeScript check passed with DEEPWORK_TYPECHECK_JOBS=2; git diff --check passed.

Local command follow-up on base e0cb8ba:
- Five-file focused run (Slack command, personal plugin, registry, setup command, staged apply): 93 passed, 0 failed, 763 assertions. After adding timer and schema-artifact guards, final local-command run: 10 passed, 0 failed, 249 assertions. Full TypeScript check passed with DEEPWORK_TYPECHECK_JOBS=2. Plain git diff --check passed after preserving existing CRLF lines and normalizing added lines.
- Actual command registry dispatch and loopback HTTP/SSE exercise configure/status and deny remote thread selection without model/tool calls. Real temporary SQLite and protected files prove interval/watch restoration after close/reopen, disable, in-flight disconnect fencing, CAS conflict refusal and credential preservation. Timer checks prove rearm/cancel without waiting 60 seconds.
- Broader six-file run: 114 passed, 1 failed. The unrelated api.test.ts “bound workspace drives actual shell execution” assertion compares Git Bash /tmp/... to C:/Users/.../Temp/... and fails on this host. The same failure reproduced at untouched e0cb8ba in a disposable detached worktree; no unrelated workaround was committed.

No real-account tokens, actual Slack sends, daemon restart, install, push or release. Source/API-fixture verification does not prove a live workspace installation or Desktop UI execution.
