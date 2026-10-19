# Development

Install Bun 1.4.2 or newer, then `bun install --frozen-lockfile`. Use `bun run typecheck`, `bun test`, `bun run build`, and `bun script/public-artifact-guard.ts`. Do not run tests with real credentials or production data.

CI uses GitHub-hosted Ubuntu 22.04 for functional tests and the sandbox probe, and Ubuntu 24.04 for performance and packaging. The 24.04 sandbox probe failed at bubblewrap loopback setup; the 22.04 environment must pass the same probe before acceptance, without disabling host security policy. Linux-only namespace/process sandbox tests require bubblewrap, a user systemd/DBus session and working user namespaces. The sandbox probe fails closed; no unsandboxed fallback is permitted. Windows test results cannot certify Linux containment. Performance tests run separately with unchanged budgets.
