# Public snapshot review

Status: PREPARATION ONLY. Not published. Hosted Linux and independent review remain mandatory.
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

## Required before publication

1. Hosted Ubuntu full functional suite, including compiled-skill, POSIX permissions, symlink and GNU-tar audit cases; exact snapshot SHA required.
2. Real namespace sandbox probe on hosted Ubuntu with no containment bypass. The workflow installs bubblewrap/dbus and establishes a user service; actual hosted AppArmor/user-namespace compatibility is not yet observed.
3. Unchanged TUI performance budgets on the hosted runner.
4. Hosted standalone compilation, audited npm package and bundled CLI smoke; all aggregate CI jobs must succeed.
5. Independent sensitive-information/license inventory review. Marker searches and the artifact guard are bounded checks, not proof of absence.
6. Separate private backend integration CI before claiming cross-service acceptance. It is documented, not newly wired or executed by this repair.

No git push, repository publication, npm publish or live deployment was performed. Existing unauthenticated loopback API risk is described in SECURITY.md and was not changed here.
