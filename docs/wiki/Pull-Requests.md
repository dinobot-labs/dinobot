# Pull requests

## Before implementation

Link the issue that defines the problem and agreed scope. Discuss features, architectural changes and large refactors before coding; a small typo or self-contained correction may explain its purpose directly in the PR. Use a draft PR for work in progress or early design feedback. State what is intentionally out of scope and avoid unrelated formatting, dependency upgrades or generated output.

Use `Refs #123` for related or partial work. Use `Fixes #123` only when the entire issue is addressed and closure on merge is intended; GitHub may close that issue automatically. Maintainers must still record that the change is unreleased. Never imply that merge means a packaged release is available.

## Ready-for-review checklist

- Explain the problem, approach, user-visible behavior and linked issue.
- Add a regression test for a bug and cover relevant normal, boundary and failure cases. For docs-only work, check paths, examples and the public-source guard instead of claiming runtime tests.
- Run the applicable checks in Development.md. Report commands and actual results, including failures, skipped tests and platform limitations. Do not describe unrun tests as passing.
- Use only synthetic examples. Do not include raw sessions, tokens, private configuration, personal screenshots or build artifacts.
- Update affected documentation and preserve third-party licenses and attribution. Confirm that you have the right to contribute every included change.
- Keep the diff focused and mark the PR ready only when it is reviewable.

## Review and integration

Maintainers review behavior, tests, privacy, compatibility and licensing. The stable aggregate CI check is `CI` (workflow `CI`, job id `gate`); maintainers should require it in branch protection. This policy does not assert protection is already configured. Green CI is necessary for code integration, not a promise of acceptance or a substitute for review.

Answer review comments with an explanation or a revision. When changes are requested, address each blocking point or explain the disagreement, then request another review. A resolved conversation alone does not establish that the code is fixed. Keep discussion about the change, following CODE_OF_CONDUCT.md.

Resolve merge conflicts on the contributor branch, preserve unrelated changes and rerun affected checks against the updated base. Avoid force-pushing during active review without warning; never rewrite another contributor’s branch. Maintainers make the final merge decision and may decline a PR with an explanation. There is no review SLA and no automatic stale closure.

Independent review is preferred when another maintainer is available. A sole maintainer may merge their own change after documenting checks and reviewing the final diff; this policy does not demand an impossible self-approval or invent a second reviewer. Maintainers should configure protection rules consistently with the actual team.

Squash merge is the default. Use a clear final commit message referencing the issue and preserve contributor authorship, copyright notices and appropriate co-author trailers. Do not claim others’ work as your own. Delete the merged feature branch when it is no longer needed.

After merge, verify issue scope and record the commit and release status. Merge and source verification do not mean a packaged release has shipped; follow Release.md. A declined or superseded PR should state why it closed and link any replacement.

## Contribution rights

Submission is under PolyForm Noncommercial 1.0.0 for first-party contributions, not an implicit commercial license or copyright assignment. Third-party material retains its own terms. See CONTRIBUTING.md at the repository root and Licensing.md; any commercial permission requires a separate explicit agreement with the relevant rights holders.
