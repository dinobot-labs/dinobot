# Release

CI checks PRs and pushes to main with a read-only token and pinned actions. The stable required check is CI. Maintainers must configure branch protection to require it. No automatic production deployment or release publication is configured.

A merge makes a change available at its source commit, not necessarily in a published release. On issue closure, link the fix and state unreleased or name the release containing it. Verify the full issue scope even when GitHub closes it via a keyword; partial fixes leave remaining work open. When releasing, list notable fixes and breaking changes, link their issues, record the exact source revision and update issue release status. Do not equate source verification with packaged or deployed acceptance.

`bun run release` creates a local audited npm tarball. Before any authorized publication, verify source and dependency licenses, review the public-artifact guard, run functional and Linux sandbox tests, inspect the actual archive, and record hashes. A local build is not evidence of a deployed version. Never include sessions, reports, operational services or credentials.
