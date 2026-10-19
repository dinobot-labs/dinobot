# Release

CI checks PRs and pushes to main with a read-only token and pinned actions. The stable required check is CI. Maintainers must configure branch protection to require it. No automatic production deployment or release publication is configured.

`bun run release` creates a local audited npm tarball. Before any authorized publication, verify source and dependency licenses, review the public-artifact guard, run functional and Linux sandbox tests, inspect the actual archive, and record hashes. A local build is not evidence of a deployed version. Never include sessions, reports, operational services or credentials.
