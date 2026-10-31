# Delivery

Use with programming for multi-stage delivery. This workflow grants no additional authority and adds no permission gate. Complete only the endpoint the user requested: a source change does not require deployment, and a deployment request is not complete at a local commit.

## Keep ownership through the endpoint

1. Record the canonical target, scope, exclusions, requested endpoint and observable acceptance checks. Pin dependency and artifact identities; preserve unrelated work.
2. Delegate bounded units with disjoint write ownership and explicit producer/consumer contracts. Collect actual outputs, inspect failures, resolve child questions and continue integration after each settled stage. A worker report or launched background task is not delivery.
3. Classify waits before acting. For an internal resource wait, record the owner/task ID, resource, resume condition and next action. Use the available managed wait/completion mechanism; otherwise report the pending handoff and the responsible resumer. Do not bypass another owner’s claim, busy-poll, restart an active child, or treat a human decision/approval wait as an internal retry. Continue independent authorized work when possible; do not invent missing permission or claim a nonexistent wake-up mechanism.
4. After interruption, inspect receipts and current state before repeating effects. A timeout may have partially applied a change. Preserve human control, active work and unsaved state; never infer safe termination from an idle backend.
5. Verify the integrated result at its frozen identity. After changes, rerun affected checks; inspect skipped tests and cleanup failures. A historical pass, a test found in source, or a read-only review is not a current behavioral pass.

## Evidence boundaries

Keep separate rows for each requested layer; mark others out of scope rather than forcing extra work:

| Layer | Evidence | Does not prove |
| --- | --- | --- |
| Source | Canonical commit and actual relevant test results | Built or published package |
| Package | Built archive/image identity, digest and embedded version/resources | Installation or running process |
| Installed | Destination executable/resources and their hashes | Existing processes switched versions |
| Running | Actual launcher, process/child path, start time and loaded artifact identity | Successful user flow |
| Real flow | User entry path, correlated request/tool IDs, completed result and observable outcome | Untested inputs or historical incident cause |

Use the real consumer, including packaged child runtimes, for runtime acceptance. A source override, fresh diagnostic client, auxiliary request, title or notification is not the user’s completed flow. Bind assertions to the intended result surface and preserve failures and counterevidence. Use sanitized diagnostics; never expose credentials or unrelated user content.

For authorized installation or deployment, compare the intended artifact/configuration with the actual target before switching, then check the requested real flow afterward. Do not silently relax compatibility, transport or sandbox checks to obtain a pass. Temporary diagnostic resources need an owner and verified cleanup; retain cleanup errors.

## Close truthfully

Report the requested endpoint, exact identities, checks actually executed, remaining waits and unverified layers. A staged artifact, queued restart, pending natural exit or pushed source is not a running deployment. Stop at completion or a concrete blocker with owner, resume condition and next action—not merely at a phase boundary.
