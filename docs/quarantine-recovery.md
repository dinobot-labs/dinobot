# Offline quarantine recovery

An idle session can remain undeletable when a native or external call has an
unresolved provenance fence. Idle tasks, expired claim leases, vanished PIDs and
reboots do not establish that historical external effects ended.

The `quarantine-recovery` command supports Windows and macOS only. It never
loads application configuration, credentials or plugins, starts scheduling,
stops a daemon/driver, or automatically unlocks a claim. Unsupported platforms
refuse before opening the database.

Before either mode, stop writers through their supported lifecycle controls and
make a protected copy of the stopped database and any existing SQLite sidecars.
Keep that backup untouched and rehearse on another copy. The command retains an
exclusive SQLite connection across planning, mutation and authoritative readback;
an open reader or writer causes refusal. Close the command completely before
reopening the application. Do not supply a live production database as a test.

## Reconcile proven tokenless native calls

A terminal child task can leave an UNKNOWN native process call and its
`native:<taskId>:process` coordination lease without holding any claim tokens.
Token-based reconciliation cannot name such a call. Use the separate explicit
mode; ordinary token abandonment does not run it automatically.

For example, a **synthetic** request file can begin with:

```json
{"calls":[{"conversationId":101,"taskId":"202"}]}
```

```sh
dinobot quarantine-recovery --database /path/to/stopped-copy.sqlite --request /path/to/request.json --reconcile-native
```

Review the exact `requiredCalls`, `calls`, `blockers` and `snapshot`. Apply only
when there are no blockers. Add the preview's snapshot, a nonempty `actor`, and
an explanatory `note` to the same request, then repeat with `--apply`.

This mode requires exact existing UNKNOWN native process calls with no held or
acquired tokens, terminal call tasks and terminal owner tasks where applicable,
complete recorded identities, OS-backed quiescence evidence, and exact matching
blocked native leases. It compares the call/task/ownership/lease snapshot again
at commit, records reconciliation evidence in the existing audit, removes only
those leases, and reads back the result. Claims, task records and unrelated
leases are retained. Alive/unknown evidence and changed snapshots refuse; caller
JSON is never accepted as process evidence. A postcommit readback failure must be
inspected before retrying because the commit may already have succeeded.

## Abandon historical external uncertainty

Without `--reconcile-native`, the existing mode still requires the exact current
quarantined-token closure, a fresh snapshot, actor/note, and the literal risk
acceptance returned by its plan. It refuses unrelated unresolved leases and
nonterminal affected tasks. Reconcile eligible tokenless calls separately first;
do not suppress those blockers.

Abandonment is explicit, audited acceptance of unproven historical effects. Its
result remains `canonicalQuiescence: false`. Native-call reconciliation does not
mark old image generation or computer-use effects as settled.

On macOS, a fixed `/bin/ps` inventory additionally refuses any recorded PID or
matching process group, any live `cua-driver` basename, incomplete/malformed
output, stderr, timeouts and exhausted output budgets. Missing PIDs are only a
negative control, never positive evidence of historical quiescence. Driver
shutdown and restoration remain operator actions, not recovery-command effects.

These source changes are not a statement that a packaged desktop release has
shipped with them. See [the reported recovery gaps](https://github.com/dinobot-labs/dinobot/issues/6).
