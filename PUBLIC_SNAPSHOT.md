# Public snapshot review

Status: PRIVATE STAGING ONLY in dinobot-labs/dinobot. Not publicly released. Hosted Linux acceptance remains mandatory.
Source baseline: 0aefd6416a45b810039f2bed05d8e09ceb48d43d, extracted by git archive; snapshot-local repairs are listed below. Original source tree was not edited.

## Publication inputs

Included: src/, test/, patches/, vendor/, selected build/install/release/CI/benchmark scripts, package and lock/config files, runtime SOUL.md, new public docs/policies/licenses and CI.
Excluded: services/, reports/, relay/, openwiki/, original private docs and history, runtime databases/sessions/exports, .env, QA/live benchmark outputs. node_modules/, dist/ and .git/ are not publication inputs. SOURCE_SHA256SUMS inventories every other source file except itself.

## Repair scope

- Removed unknown-license optimization/debugging bodies and additionally discovered clarification adaptation and verbatim Herdr output. Replaced them with independently written project-specific short instructions; catalog names/API remain. See THIRD_PARTY_NOTICES.md for the prose inventory and retained licenses.
- Restored google.test.ts (17 tests) and report-service.test.ts (13 tests) client coverage from the pinned original, using real loopback HTTP transports with synthetic protocol responses. No private service implementation is copied. See docs/PUBLIC_CLIENT_TESTS.md for the exact private CI gap; client fixture success is NOT backend integration acceptance.
- Corrected Windows separator normalization in the Google import-boundary check and URL.pathname misuse in the compiled skill test. POSIX permission checks remain active on Linux and do not pretend to validate Windows ACLs.
- Added standalone compilation to hosted package CI. Existing Ubuntu sandbox probe, containment requirements, full functional tests, strict release audit and separate unchanged performance budgets remain enabled.

## Actual checks on Windows, Bun 1.4.3

Passed: typecheck; 31 Google/report/build-plan tests (482 assertions); 16 focused skill catalog/loading tests (172 assertions); 92 CI/release/local-audit tests (535 assertions); artifact guard (0 violations); actual npm release build with strict tarball audit (59 dependency notices, about 2 MB); bundled CLI --help smoke.

The first mixed skill run exposed two additional Windows failures: compiled import pathname and symlink EPERM. The pathname was fixed and retested: it now reaches Bun compilation but fails with the same ENOENT described below. Symlink test remains genuine and unchanged. The 16-test skill run intentionally excludes these checks and is not a full-suite pass.

Standalone compile remains BLOCKED on this Windows runtime: bun run build bundles 2335 modules then fails copying the Bun executable (ENOENT). A one-module compile of script/ci/pr-title.ts fails identically, so this is not evidence for a project bundling defect. No speculative build workaround was applied. Compiled skill test after path correction fails at the same executable-copy boundary. Root cause inside Bun/host is unproven.

The expensive Windows release-audit.test.ts tar/symlink suite was not repeated; its earlier failure remains unresolved locally.

## Hosted CI repair after run 39245401168

The first hosted run passed the package job, including standalone compilation, audited npm bundle and CLI smoke. It failed the performance environment step because performance-counters.sh contained CRLF (`do\r`), and the functional job failed the real sandbox probe with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` on Ubuntu 24.04. Functional and performance suites therefore were not accepted by that run.

- Normalized the owned shell script to LF. `.gitattributes` limits normalization to shell scripts and explicitly preserves patches/vendor bytes; no source-wide renormalization was performed.
- Moved only the functional/sandbox job to standard hosted Ubuntu 22.04. Ubuntu 24.04 host security-policy interaction is a hypothesis, not a proven kernel/AppArmor diagnosis from this stderr alone. The candidate runner must still pass the unchanged real probe; no sysctl/AppArmor relaxation, namespace/network bypass or sandbox skip was added. Package and performance runners remain 24.04.
- Preserved sandbox implementation, full functional command, package checks, aggregate failure gate and performance test bytes/budgets. Added CI contract tests for shell bytes/bash parsing/Git attributes and fail-closed sandbox wiring. The pre-fix regression run had 3 failures (CRLF and runner assertions); the post-fix run passed.
- Adopted the reviewed community-policy drafts for CONTRIBUTING, Issues and Pull-Requests, adapted to actual `CI`/`gate` naming and core commands; expanded release/closure guidance. These documents do not claim branch protection or labels are already configured.

Actual repair checks on Windows/Bun 1.4.3: `bun test test/ci-hosted-boundary.test.ts test/ci-workflows.test.ts test/ci-release.test.ts` passed 89 tests with 526 assertions; `bun run typecheck` passed; `bun script/public-artifact-guard.ts` reported 0 violations; `git diff --check` passed. Shell `bash -n` and attribute checks ran inside the regression test. No full Windows suite or repeated packaging build was run. Windows checks do not prove Linux sandbox compatibility. SOURCE_SHA256SUMS is refreshed over actual publication input bytes.

## Self-contained regression fixtures after run 39246451313

The hosted functional suite reached 3,791 tests and failed seven. Locally, the same two files reproduced exactly seven failures before repair: one missing excluded `services/landing/src/brand/species.ts` input and six explicit CRLF rejection errors in manifest editing. The example structure itself was not the observed failure.

- Replaced the operational landing file dependency with an independently written data-only brand contract fixture (all four species and all five ordered color stops). The existing presence and exact-stop assertions remain unchanged. This checks pinned brand compatibility, not live landing integration.
- Added a synthetic LF manifest fixture with real/commented channel blocks, inline/standalone comments, empty plugin mapping and an unrelated tail section. All original exact-byte, semantic, comment-order and 25-seed/12-step randomized assertions remain unchanged. No tests were skipped or assertions removed.
- Normalized only the public YAML example to LF and pinned both YAML paths with Git attributes. Added a separate real-example LF/edit/remove round-trip test; the editor still rejects CRLF as before.
- No runtime implementation, CI workflow, sandbox containment, performance budget, third-party license, patch or vendor payload changed. Original source checkout was untouched.

Actual local repair checks (Windows, Bun 1.4.3): 124 tests passed across setup-manifest-edit, tui-dino-theme, tui-theme, ci-hosted-boundary, ci-workflows and ci-release (2,811 assertions); typecheck passed; public artifact guard reported zero violations; diff whitespace check passed. SOURCE_SHA256SUMS is regenerated to include both new fixtures (701 files, excluding itself). Hosted full-suite acceptance of this repair remains pending; expected runtime is approximately 16 minutes plus queue/setup. No CI polling or public conversion is performed by this repair.

## Required before publication

1. Hosted Ubuntu full functional suite, including compiled-skill, POSIX permissions, symlink and GNU-tar audit cases; exact snapshot SHA required.
2. Real namespace sandbox probe on hosted Ubuntu with no containment bypass. The workflow installs bubblewrap/dbus and establishes a user service; actual hosted AppArmor/user-namespace compatibility is not yet observed.
3. Unchanged TUI performance budgets on the hosted runner.
4. Hosted standalone compilation, audited npm package and bundled CLI smoke; all aggregate CI jobs must succeed.
5. Independent sensitive-information/license inventory review. Marker searches and the artifact guard are bounded checks, not proof of absence.
6. Separate private backend integration CI before claiming cross-service acceptance. It is documented, not newly wired or executed by this repair.

The snapshot is staged in a private GitHub repository; this repair is intended for an authorized private main push after local checks. No public conversion, npm publish or live deployment is part of this repair. Follow-up hosted CI is not polled by this repair; its result remains a publication blocker. Existing unauthenticated loopback API risk is described in SECURITY.md and was not changed here.
