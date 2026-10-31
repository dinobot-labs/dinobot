# Offline quarantine recovery

The maintenance command supports Windows and macOS. Stop the daemon yourself and retain an untouched database/sidecar backup before using a separate rehearsal copy. The command never stops a process or starts scheduling, plugins, channels or credentials. Every operation holds the same exclusive SQLite connection until close; lock contention refuses immediately.

## Exact tokenless native-process calls

An UNKNOWN process call with no captured or subsequently acquired claim tokens cannot be named by the existing token-closure reconciliation API. Use the explicit offline mode instead:

    dinobot quarantine-recovery --database <existing.sqlite> --request <request.json> --reconcile-tokenless

Request JSON (IDs are illustrative):

    { "calls": [{ "conversationId": 123, "taskId": "456" }] }

Planning returns the exact snapshot and blockers. Inspect them, then add actor, note and the returned snapshot to the same request. Repeat the command with --apply. Do not supply tokens, abandonment acceptance or supposed OS evidence in this mode. Reconciliation gathers its own native evidence; arbitrary evidence fields are ignored.

Each selected call must be unique, UNKNOWN, kind process, and tokenless. Its task must be terminal and belong to the named conversation. Tasks in that conversation and its owned descendants must also be terminal. Exactly one matching blocked-unknown native lease must have the same task and conversation, empty workId and native process provenance reason. Recorded admission/start identities must be complete and unambiguous.

The existing native observer supplies quiescence (or an existing canonical native settlement receipt). PID absence, task completion and notes do not supply evidence. Alive, unknown and failed observations refuse. A SHA-256 snapshot includes selected call records, owning task records, matching leases and descendant maintenance state. The transaction repeats that read and refuses changes after observation. A successful transaction only marks the exact calls reconciled, removes their exact leases and appends the actor/note/snapshot/native evidence audit; it does not release any claim, alter tasks or settle unrelated leases.

## Historical external effects remain separate

The existing default mode still requires an exact quarantined-token closure, snapshot, actor, note and the literal risk-acceptance string returned by its plan. Its result remains canonicalQuiescence: false. It does not turn historical external effects into native quiescence or silently include tokenless calls. Reconcile eligible tokenless calls first, then obtain a fresh abandonment plan if explicitly accepting historical uncertainty.

## macOS inventory and limits

The offline adapter executes /bin/ps -ww -axo pid=,pgid=,comm=. It refuses recorded PID matches, members of recorded process groups (even when the original PID is absent), and Cua Driver command names. It rejects empty, malformed, duplicate-PID, unterminated or missing-launchd output. Command failure, timeout or output overflow fails closed. Inventory absence is only a negative control, never proof of historical external-effect quiescence.

Windows headless tests cover the new state transitions, existing native observer regressions and actual SQLite lock exclusion. macOS output parsing is tested with synthetic process tables on Windows; real macOS execution has not been verified in this change.
