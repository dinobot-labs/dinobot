# Public landing transfer

## Boundary

Transferred from historical commit `9b91b4a48cfe9f4099e59634323037ef461f6286` (landing tree `cd455c78875420a1e6afe7da7452ec9fdb95799b`). The parent selected `services/landing`, superseding the audit’s suggested `website` destination. No repository merge or history import was performed.

The audit’s explicit runtime/public/build allowlist was copied by reading each blob from that commit: 143 runtime/public/build files, seven reviewed configuration/dependency files, and four separately authorized Worker test/fake files. Historical docs, reports, QA, scripts, lab entrypoints, campaign/obsolete OG images, databases, credentials and dependencies were not copied. This document is new.

## Preserved contracts and next owners

- Worker routing, schema, consent version, locale negotiation and privacy pages remain unchanged in this transfer. D1 identity `6d10b251-9a75-435d-9eca-a9a10b53f070` and limiter namespace `7321` remain unchanged. No database was queried or mutated; tests use in-memory SQLite.
- The security implementation node owns intentional waitlist retirement/static-first routing and the corresponding replacement of historical API assertions. Current tests explicitly preserve the old fail-open limiter behavior; passing these tests is not security/cost acceptance.
- The product implementation node owns updated product copy, supported download links, real product screenshots and regenerated OG assets. Historical templates still reference the excluded obsolete OG images. This transfer is buildable source, **not publication-ready product copy or imagery**.
- No deployment command was run. The convenience deploy script was removed; preserved production-bound configuration still requires explicit review before any future deployment.

## Package and publication integration

Root manifest and lock remain byte-identical to HEAD. Package dependencies are pinned to the audited lock versions; unused playwright-core was removed and only the package lock regenerated. Installation and frozen-lock validation ran in an OS temporary directory; its node_modules and reviewed lock were placed only in this package and the temporary directory was removed.

The public guard permits only this leading services/landing package and its public source directories/config files. Other services and nested operational, secret, database and symbolic-link paths remain rejected. Generated HTML, caches, node_modules and build outputs are locally ignored, **not guard exemptions**. Run the filesystem guard on a clean source checkout or publication staging copy, not this populated build worktree. Local reports remain excluded from publication.

CI adds an isolated landing job: clean-source guard, package frozen install, all package tests, guard/discovery regression tests, typecheck and build, sequentially with DEEPWORK_TYPECHECK_JOBS=2. Its result is required by the final gate except the existing package-only retry mode. Core functional discovery omits exactly services/landing; the landing job runs its complete test suite, including future nested tests. Core release packaging remains unchanged.

## Local receipts

Environment: Windows x64, Bun 1.4.3. LSP unavailable; closure inspected by import/path searches plus executable checks.

| Check | Result |
| --- | --- |
| Isolated install then frozen install | Pass; pinned package lock, no frozen changes |
| Worker behavioral suite | 45 passed, 0 failed; 535 assertions |
| Public guard and discovery fixtures | 5 passed, 0 failed; 29 assertions, real temporary directories and symlink |
| Package typecheck (src/test/vite) | Pass |
| cf build | Pass; Worker plus six HTML entries |
| Regenerated Korean font | 464 glyphs; bytes identical to pinned historical font |
| Clean publication-source guard | Zero violations on tracked plus nonignored new source staging copy |
| Root manifest/lock | Byte-identical to HEAD |
| Historical landing worktree | Scoped git status clean |
| git diff --check | Pass |

An extra attempt to run the existing root ci-functional-shard.test.ts could not load fast-xml-parser because root dependencies are intentionally not installed in this worktree. A read-only NODE_PATH retry did not change Bun resolution. No root dependency install or root modification was made. The new isolated discovery fixtures pass; the full existing root shard suite remains for normal root CI, not claimed locally passed.

Initial transfer preparation hit unavailable Python and a temporary script syntax error before copying any files; the corrected Bun blob-copy script completed and was removed.

No commit, push, deployment, live signup, browser E2E, Lighthouse or FPS check belongs to this transfer receipt. Downstream implementation changes require fresh affected checks and final security/product acceptance.
