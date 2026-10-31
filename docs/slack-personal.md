# Slack personal assistant (opt-in)

## Desktop integration contract

Use the existing daemon command protocol. Start "/setup channels" in a **local tui conversation** and select checklist option id **slack-personal**. This is also the reconnect entry, including when channels.slack already exists. Do not submit credentials as chat messages or add a secret-bearing HTTP endpoint.

The command emits:
1. text prompt: app name.
2. print: official Slack app-create URL with encoded manifest (bot scopes plus read-only user scopes).
3. secret prompt: bot xoxb token; server auth.test + bots.info.
4. secret prompt: app xapp token with connections:write; server apps.connections.open + short hello probe, then socket closes. Bot/app app IDs must both exist and match.
5. secret prompt: user xoxp token; auth.test derives owner ID, requires matching team and exactly the allowed read scopes (no write/unknown scopes).
6. ordinary setup apply event: candidate manifest contains file paths, never token values. Existing apply/CAS/restart flow applies. No custom endpoint is introduced.

Errors are SlackSetupError kinds: invalidAuth, revoked, inactive, missingScope, network, unexpected, badResponse, socketModeOff. app-mismatch and team-mismatch are unexpected details. Failed validation offers retry/skip. Tokens must be rendered as secret fields and sent only through existing command replies.

New credentials live in slack/<random-generation>/{bot,app,user}.token next to the manifest, protected by existing cross-platform private-file utility. Cancelled reconnect never overwrites active credentials. After successful reconnect, old generations are not automatically deleted (no unsafe cleanup of a possibly running daemon's credentials).

Staged configuration:

    channels.slack:
      transport: socket
      botTokenFile: <protected path>
      appTokenFile: <protected path>
      databasePath: <data>/slack.sqlite
      port: 0
      appId: <verified app>
      teamId: <verified team>
      botUserId: <verified bot>
      allowedUserIds: [<derived owner>]
      allowedChannelIds: ["*"]
    plugins.slack_personal:
      botTokenFile: <same protected bot path>
      userTokenFile: <protected user path>
      ownerUserId: <derived owner>
      teamId: <verified team>
      databasePath: <data>/slack-personal.sqlite

Optional plugin keys: transferDirectory (default sibling slack-transfers), pollIntervalSeconds (60..3600; default 300). Plugin disabled by default. Credentials are revalidated when loaded, including owner/team/scopes. Existing channel is the sole long-lived Socket Mode consumer.

## Tool/status contract

All tools use prefix slack_personal_. status returns teamId, ownerUserId, access="local-only", transferDirectory, enabled, watch|null, lastPollAt|null, lastError|null, intervalSeconds and delivery explanation. This is a plugin tool, **not** a new public HTTP route. Loading needs network access; failures are ordinary plugin-load errors. No real-account connectivity claim should be inferred from configuration presence.

Tools: list, history, replies, search, download, send, upload, monitor, deadline, status. JSON schemas are provided by the plugin catalog. Cursor methods return messages/channels, nextCursor, complete, pages. Limit is 15/page, 1..5 pages/call. search has page 1..100, count 50 and Slack's native paging response. No claim of complete history without exhausting continuation within Slack access/retention limits.

User token is used only for a fixed read-method allowlist. Bot token sends messages and files. Files use Slack files.info and HTTPS files.slack.com only, redirects denied. Signed upload URLs carry no bearer. File size max 10 MiB; flat filenames in dedicated transfer directory; no overwrite, traversal, alternate streams, device names, symlinks or hardlinks. Copy upload files into this directory first.

## Privacy / delivery boundary

The current core plugin call contract exposes a trusted channel but no trusted remote sender. Therefore **all remote conversations are denied**, including the owner's Slack conversation. Only local Desktop/TUI can use personal tools. This deliberately fails closed instead of trusting a name in a model prompt. Remote owner access requires a future authenticated principal contract.

auth.test establishes the user's workspace/identity/scopes, not a user-token app ID. Bot/app identity is verified against Socket Mode hello; a user token from another app in the same workspace with identical approved read scopes cannot be distinguished by this flow. Do not claim three-way app identity verification.

Monitoring is separately enabled with monitor in the local conversation. It selects up to 5 channels/DMs and starts at activation time; it does not backfill old history. Each interval polls one 15-message history page, rotating selected channels, preserving a fixed window/cursor until exhausted. At default settings 5 quiet channels take about 25 minutes per sweep; backlog and Slack 429 Retry-After increase delay. Only selected-channel top-level history is scanned; threaded mentions not surfaced in channel history and group-DM request inference are not comprehensive. Manual search/replies remain available.

DM messages and owner mentions become candidates, not confirmed tasks. After one hour, at most one candidate thread is checked per interval; incomplete replies never establish an unanswered assertion. A later owner DM reply is a conservative suppression heuristic, not proof of semantic resolution. Explicit deadline accepts an offset-qualified datetime only; natural-language deadlines remain candidates. Hourly summaries are bounded samples (10 messages per summary), not full-channel reports.

Quiet hours default 22–08 in the explicitly supplied IANA zone; equal start/end disables quiet hours. SQLite outbox plus stable host wake keys prevents repeated host admission after crashes. Configure/disable fences in-flight polling; account changes discard prior monitoring state. Monitoring wakes only the opted-in local conversation and never directly calls Slack send APIs. Tool prompts prohibit model auto-posting; explicit send requests are still available locally. This is not a separate human-confirmation system for each send.

Monitoring database contains private snippets and IDs, is created as a protected file, and is registered as host storage; it is not encrypted. Keep the daemon data directory private. No live user-token, actual Slack send, installation, daemon restart or publication was performed in backend tests.

## Backend verification

- Relevant setup/client/monitor suite: 59 passed, 0 failed (351 assertions).
- Full TypeScript check: passed with DEEPWORK_TYPECHECK_JOBS=2.
- git diff --check: passed.
- Expanded regression run: 96 passed, 2 POSIX-only skipped, 3 failed. All three failures reproduced on untouched canonical base 51495a58ac8c9087be9f366b936088c4d69d64e5: existing CLI test reaches live daemon lock because Windows HOME isolation is incomplete; existing research-readiness manifest expectation fails; independent PowerShell ACL inspection cannot autoload Microsoft.PowerShell.Security in this environment. No production daemon was stopped or restarted.
- Existing plugin-wake integration tests: all 8 passed in that expanded run. Private file creation/read and exposed-ACL rejection tests passed; the independent Get-Acl inspection remains environment-blocked.
