# Functional CI shards

CI uses two Ubuntu 22.04 runners. Each runner retains the real namespace probe,
credential-free HOME/XDG directories and 1200-second suite timeout. Types, public
artifact checks and PR-title validation run on shard 1; the existing package,
performance and aggregate CI jobs retain their gates. Matrix fail-fast is off:
a failing shard does not cancel evidence collection from its sibling.

## Selection and timing evidence

- Discovery covers Bun default .test/_test/.spec/_spec naming and all eight
  JS/TS extensions, recursively excluding hidden directories and node_modules.
  Only tui-perf.test.ts is excluded (the independent performance job runs it).
  Public artifact guard already forbids symlinks. Keep the discovery parity
  fixture current if Bun discovery or bunfig test-root/loader settings change.
- Timing data never determines membership. New files use the positive median
  seed duration (1000 ms with no data). Zero-duration files have a 1 ms floor.
- Longest-processing-time-first assigns each file to the least-loaded bucket.
  Ties use code-point path order, then bucket index. Execution is path sorted.
- Every selected argument begins ./, so Bun treats it as an exact file, not a
  substring filter. The behavioral test includes prefix/nested-name collisions.
- Empty/unknown shards and malformed inputs fail closed. Exit codes and signals
  propagate. No timeout, assertion or test-name filtering is relaxed.

The maintained seed functional-timings.json comes from successful run
41201191726, job 124537167422: 4075 tests, 337 files, 977.71 seconds. Its per-file
weights sum printed per-test milliseconds, NOT whole-file wall time. The 337
weights sum to 969116.03 ms. They are scheduling estimates, not claimed speedup.

Reproduce this seed explicitly (do not regenerate it during ordinary tests):

    gh run view 41201191726 -R dinobot-labs/dinobot --job 124537167422 --log > seed.log
    bun script/ci/import-functional-timings.ts seed.log script/ci/functional-timings.json

Each actual run uploads selection.json and junit.xml from reports/functional-*.
JUnit testsuite file/time attributes expose actual per-file measured test time
(in seconds); GitHub step start/completion gives full wall time including startup.
Generated timings/reports are artifacts only, never committed. A future seed
refresh is a deliberate reviewed change, with updated source provenance.

Inspect membership without executing tests:

    bun script/ci/functional-shard.ts 1/1 --list
    bun script/ci/functional-shard.ts 1/2 --list
    bun script/ci/functional-shard.ts 2/2 --list

## Same-source comparison

### Required original-discovery baseline

A `functional_shards=1` run still uses the custom discovery/runner. It measures
partitioning overhead, not parity with the original Bun discovery command. For
the primary comparison, also run the original command on the SAME checkout SHA
as the two-shard run, including the same product code, tests and bunfig.toml.
Do not use the pre-sharding commit as the baseline checkout.

Create a temporary standalone comparison workflow (not a caller that merely sets
`functional_shards=1`). Copy the current CI jobs and gates, but make its `test` job
a single non-matrix job: remove matrix-dependent conditions so typecheck, title
validation and artifact guard still run, preserving the PR-event title condition.
Use a literal baseline job/artifact name instead of matrix/strategy expressions,
and replace the shard artifact path with `reports/original-junit.xml`.
Keep Ubuntu 22.04, Bun 1.4.2, frozen install, real namespace probe, job timeout,
credential-free HOME/XDG setup, package/performance jobs and aggregate gate. All
checkout steps must explicitly use the same source SHA as the two-shard run. The
temporary workflow definition may be on a different ref; do not alter the checked
out `.github/workflows/ci.yml` or test files to run the baseline.

In the functional step, retain the sandbox setup and replace only the shard
invocation with the original discovery command:

```sh
env HOME="$sandbox" XDG_CONFIG_HOME="$sandbox/config" XDG_DATA_HOME="$sandbox/data" XDG_CACHE_HOME="$sandbox/cache" DINOBOT_NO_UPDATE_CHECK=1 timeout 1200 bun test --path-ignore-patterns '**/tui-perf.test.ts'
```

Archive its complete log and step/job timestamps. For machine-readable membership
and totals, append only `--reporter=junit --reporter-outfile=reports/original-junit.xml`
to that command (create `reports` first) and upload that file with `if: always()`.
Do not pass explicit file paths, the custom runner, native sharding or test-name
filters in this baseline. Apply identical JUnit reporting to both measurements.
Compare the original JUnit per-file list against the union of both shard selection
lists and JUnit file lists: normalize path separators and optional `./`, require
exact set equality and no duplicates across shards, then compare test/pass/fail/skip
totals. Missing JUnit, unexplained totals or membership differences invalidate the
comparison; do not claim discovery parity from the custom one-shard list alone.
Remove the temporary workflow after collecting evidence. Remote execution and
cleanup are owned by the parent delivery; this procedure is not a recorded result.

### Optional custom-runner one-versus-two comparison

Use the SAME commit SHA containing this runner and workflow for both runs. Replace
REF and SHA below. The workflow_dispatch input only changes the runner count;
product code, test code, Bun pin, timeout and the remaining CI checks are identical.
No permanent second comparison workflow is needed. Dispatch requires the CI
workflow to be registered on the default branch; if GitHub refuses pre-merge
manual dispatch, use a temporary caller of this reusable workflow on the comparison
branch and remove that caller afterwards (parent delivery owns remote actions).

    gh workflow run ci.yml -R dinobot-labs/dinobot --ref REF -f source_sha=SHA -f functional_shards=1
    gh workflow run ci.yml -R dinobot-labs/dinobot --ref REF -f source_sha=SHA -f functional_shards=2

Record both run IDs, resolved checkout SHA, runner/Bun version, final gate result,
full functional step duration and all job durations. Download each run separately:

    gh run download RUN_ID -R dinobot-labs/dinobot --dir comparison/RUN_ID

Check the union of the two selection lists equals the custom one-runner list with
no duplicates; compare JUnit test/pass/fail/skip totals. This is supplementary to
the original-discovery baseline above. Compare original baseline functional wall
time with max(shard wall times), and report total runner-minutes separately. Label
any custom one-runner timings separately; do not substitute them for the original
baseline or infer native Bun sharding performance from these measurements.
The typecheck is only on shard 1, so also report end-to-end job/gate latency rather
than presenting the functional-step reduction as the whole pipeline reduction.
A failed/skipped suite is not a successful speedup measurement.
