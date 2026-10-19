# Contributing

Open an issue with a minimal synthetic reproduction before proposing a large change. Use bug, enhancement, needs-reproduction, security and documentation as triage categories; maintainers apply labels. Never upload credentials, real session exports, private messages or database files. Send vulnerabilities privately as described in SECURITY.md.

Use a branch and a focused pull request. Explain the problem, behavior change, tests and privacy impact. Run `bun install --frozen-lockfile`, `bun run typecheck`, `bun test` and `bun script/public-artifact-guard.ts`. Linux sandbox checks and performance budgets also run in CI; do not bypass them to make a check green. Use conventional titles such as `fix(tui): preserve selection`.

A maintainer reviews changes; address review feedback and keep tests passing. Maintainers normally squash merge. Review and response times are not guaranteed.

Contributions are submitted under the project license, with third-party licenses preserved. No CLA or automatic relicensing grant is implied. An additional commercial grant for contributed code requires the contributor’s explicit agreement; submitting a PR alone does not grant one.
