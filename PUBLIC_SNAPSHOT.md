# Public source provenance

## Maintained source

Core and TUI development and publication use `dinobot-labs/dinobot`:
https://github.com/dinobot-labs/dinobot

Desktop uses `dinobot-labs/dinobot-desktop`:
https://github.com/dinobot-labs/dinobot-desktop

The former private client repositories are retired, read-only historical references. They are not development or release destinations. This repository is publicly visible, under PolyForm Noncommercial 1.0.0 (not an OSI-approved open-source license); its third-party license grants remain separate.

## Historical export and subsequent maintenance

- Historical export baseline: `0aefd6416a45b810039f2bed05d8e09ceb48d43d`, originally extracted with `git archive` into a new public history. This SHA describes the export, not the current source.
- Initial public reconciliation base: `9177352f3c5bed3d27ba6dfccbb703f78bfca787`, including the public PM ledger integration. Before publication, the delivery clone fast-forwarded to `9a6285e9d879e95c2a539103d7c2941eac289c26`, retaining its six-file concurrent DAG-spawn change byte-for-byte.
- Frozen legacy delta endpoint: `3020f2be8d7407f148d4e265f9fd70dc8c448cf1`. Only product changes after the export baseline were recovered; unrelated private history was not merged.
- Recovered scope: report CLI/API/diagnostics, safe explicit restart, channel fixes, ask/codemode fixes, local calendar and host wake, and optional proof skills. Public PM behavior and later host-wake integration coexist.
- Source manifest version: `0.8.3`. This is source metadata, not evidence that an npm package, installer or running daemon has that version. No package publication, installation or daemon restart is part of this source handover.

The exact maintained revision is the Git commit containing this document. Historical export/CI notes and their old pass counts remain in Git history; none are current acceptance evidence.

## Public input boundary

Included: product source and tests, patches/vendor with existing notices, selected build/install/release/CI scripts, package/configuration files, and public documentation. Excluded: private service implementations, reports, relay, operational wiki trees, customer/internal documents, runtime sessions/databases/exports/credentials, QA recordings and live benchmark outputs. `node_modules`, `dist` and `.git` are not publication inputs.

- Public synthetic Google/report fixtures, credential fixtures, compiled skill path repair, example-provider placeholder, CI/sandbox boundaries and release audits are retained.
- The four useful PM documents formerly misplaced in the forbidden operational-wiki directory now live under `docs/wiki`; the general PM contract is retained without project-specific work history. The artifact guard is unchanged.
- Unknown-license prose removed by the historical export remains removed. The new proof-skills package includes its complete MIT copyright/license in source, every loaded package, and `THIRD_PARTY_NOTICES.md` for release-notice collection. It stays disabled unless `plugins.skills.proofSkills: true` is explicit. Companion setup scripts are not executed during import.
- Report tests use independent loopback protocol doubles, not copied private workers. They verify client projection/redaction and wire contracts, not service persistence or server-side acceptance. See `docs/PUBLIC_CLIENT_TESTS.md`.
- Release selection addresses the canonical public repository. npm releases are published from this repository (see Releases below).

## Source validation (2026-10-29)

Checks ran sequentially with Bun 1.4.3 and `DEEPWORK_TYPECHECK_JOBS=2`, using synthetic fixtures and no real diagnostic upload. Independent read-only reviews checked the selected delta, public boundaries, licenses and Desktop/core report contract.

- Before concurrent-main integration, Linux/WSL exercised 33 relevant test files, including every recovered/adjusted test and private-file regressions. The initial run had 573 passes, 9 platform skips and one test-environment failure because the isolated Git index lacked HEAD. Sealing the identical tree as a local validation commit and rerunning all 84 release-helper tests passed. The combined result is 574 distinct passing tests and 9 skips, not an extra 84 tests.
- Windows: all seven planned batches executed. Native-path and protected-file fixture failures were repaired and their 45 tests passed. The actual Windows private-file/FFI suites passed 10 tests with 2 POSIX skips. The compiled skill loader and ordinary/oversized GNU-tar fixtures also passed after targeted reruns. File-symlink cases requiring unavailable Windows privileges were exercised on Linux; this is not a claim that the complete Windows suite passed.
- `bun run typecheck` and `bun run build` passed on Windows. The compiled executable reports 0.8.3 and exposes report/restart help. A same-version, byte-identical Bun copy at an ASCII temporary path avoided an independently reproduced Bun compiler failure with its Unicode executable path; no runtime source workaround was added.
- `bun run release` built and strictly audited the local 0.8.3 npm tarball. Its minified entry reports 0.8.3 and exposes report/restart help. This command only builds a package; no `npm publish`, installation or daemon restart was performed.
- After concurrent-main integration, a separate 17-file DAG/plan/ask/subagent/PM integration run passed all 193 tests. Typecheck, native build and strict package build/audit were repeated successfully on the combined source. Previously validated recovered source/test blobs remained unchanged.
- The unchanged artifact guard passes after the PM-document relocation; canonical release selection and whitespace checks pass. `SOURCE_SHA256SUMS` covers all 839 other tracked Git blobs, not checkout line endings. Final documentation changes require regenerated hashes and exact coverage verification.

No full repository-wide suite, hosted CI, macOS native behavior, privileged POSIX foreign-owner case or installed-application acceptance is claimed by this record. Platform skips remain visible; matching-platform source tests do not establish deployment. Existing loopback API risks remain documented in `SECURITY.md`.

## Releases

npm releases of `dinobot` are published from this repository, starting after 0.8.3 (0.8.3 and earlier were published from the retired private repository).

- Squash-merged PR titles are Conventional Commits. `fix` makes a patch release and `feat` a minor release; `ci`, `docs` and `chore` make none.
- `.github/workflows/release.yml` runs on every push to `main`. It reruns the full CI on that exact commit, then release-please opens or updates the release PR. Merging the release PR tags `vX.Y.Z` on that commit.
- The `publish` job runs only in the `npm` environment (branch `main`). It downloads the tarball that CI built and audited, checks its SHA-512 and audit again, refuses conflicting or older registry versions, and publishes through npm Trusted Publishing (OIDC). No npm token is stored, and the publish job never rebuilds.
- A failed publish is retried with `workflow_dispatch` (`tag: vX.Y.Z`). The retry rebuilds and audits the tagged source, and reruns the tests only when `full_verify` is set.
