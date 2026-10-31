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

## Tools and permissions

Prefix: slack_personal_. Tools: status, list, history, replies, search, download, send, upload, monitor, deadline. Schemas are in the plugin catalog; status is a tool, not an HTTP route.

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

No real-account tokens, actual Slack sends, daemon restart, install, push or release. Source/API-fixture verification does not prove a live workspace installation or Desktop UI execution.
