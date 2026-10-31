# Durable scheduling

The built-in tools schedule_create, schedule_list, schedule_update and schedule_cancel are available directly and through codemode/tool_search. No calendar plugin configuration is required. Calendar events remain an opt-in plugin; the core scheduler reuses their host wake admission, idempotency keys and channel-answer delivery rather than enabling a mutating plugin by default.

## Contract

- A schedule belongs to the exact top-level conversation making the call. It cannot choose a different wake destination. Subagents cannot create or manage schedules. Other conversations cannot read, update or cancel them.
- key is mandatory and unique within the origin. Repeating it returns the original record, including a cancelled or completed one. To schedule another task, use a new key. Updates change text and/or time only while pending; the completion dependency remains pinned.
- at is a future RFC3339 instant with seconds and an explicit UTC offset, at most 366 days away. Invalid/rolled-over dates, naive local dates, and past/equal instants are rejected. after_thread can be supplied instead, or with at (AND semantics).
- after_thread binds the exact thread, conversation and current goal identity (creation time and objective). Completion requires an achieved goal with nonempty criteria/evidence, a successful final answer, no live run, tool, compaction, queued input or open ask, verified DAGs, completed TODOs and recursively completed descendants. Missing records, replaced goals, unknown/failed/cancelled descendants, blocked/cancelled DAGs and abandoned goals do not count as success. Historical unsuccessful work conservatively blocks the condition too. This is host-observed settlement, not independent verification of the model's claims.
- Cross-thread dependencies are allowed only between local TUI conversations (one authenticated local operator). For messaging channels only the exact origin is permitted; channel names and working directories are not treated as user identity. No cross-user goal text is exposed on rejection.
- Deleting or rotating a dependency thread fails closed. A /new rotation of the origin never transfers a scheduled instruction to the replacement conversation; the pending schedule becomes failed when due. Inspect/cancel it in its original conversation.

## Lifetime and outcomes

Records are stored in the host SQLite session document dinobot.schedules. There is no separate schedule database or migration command. The daemon checks every second, catches overdue tasks on restart, and queues a wake behind an active turn. It cannot execute while the daemon/PC is off; this is not an OS alarm or exact-time SLA.

State transitions: pending -> cancelled, admitted or failed; admitted -> completed or failed. One host service serializes mutation and wake admission. Cancellation before admission prevents delivery; cancellation after admission reports too late, including recovery after a crash before the schedule acknowledgement. It does not claim to stop an already queued/running task.

The stable scheduler wake request key deduplicates admission after restart or a crash between admission and acknowledgement. Existing admissions are reconciled before cancellation/update. Update tool calls retain a task-scoped receipt so replay cannot overwrite a newer update. This guarantees at-most-once wake admission, not exactly-once arbitrary external effects performed by the model.

schedule_list returns state, blocking/defer reason, and up to 4,000 characters of the final answer (or unanswered reason). completed means the scheduled turn produced an answer, not that its requested operation succeeded. The answer is also delivered through the existing host channel hand-over. Scheduling is not permission to perform otherwise unauthorized operations.

History is retained for deduplication, capped at 500 records per origin. There is no recurring schedule, arbitrary predicate execution, automatic revival, cross-channel principal mapping or history deletion tool.

## Checks

Isolated temporary SQLite stores, faux models and fake runtimes cover date bounds, discoverability and model tool calls in direct/codemode-only modes, updates, cancellation ownership/races, restart, crash recovery, no duplicate input, conditional readiness and outcome reporting. Existing calendar and plugin-wake regression suites cover the reused admission and channel delivery paths. No live runtime/configuration or external account is used. The scheduler suite has 11 passing tests, including a real timer and host channel hand-over, plus a live-task update replay receipt. The existing calendar/plugin-wake suites passed 22 tests; liveness/session suites passed 80 tests. TypeScript typecheck and git diff whitespace checks passed. Tests were run sequentially on Windows; no Linux runtime or live installation was certified.
