# Development

The turn-end liveness hook reconciles active goals with non-met criteria and pending/in-progress TODOs. It does not mark work complete automatically. Running children/DAGs, pending wakes and open human questions retain their normal wait behavior; aborts and subagent turns are not continued. Continuations stop after no tool progress or three attempts per input. Terminal goals do not complete TODOs or authorize restarting abandoned work.

Install Bun 1.4.2 or newer, then `bun install --frozen-lockfile`. Use `bun run typecheck`, `bun test`, `bun run build`, and `bun script/public-artifact-guard.ts`. Do not run tests with real credentials or production data.

CI uses GitHub-hosted Ubuntu 22.04 for functional tests and the sandbox probe, and Ubuntu 24.04 for performance and packaging. The 24.04 sandbox probe failed at bubblewrap loopback setup; the 22.04 environment must pass the same probe before acceptance, without disabling host security policy. Linux-only namespace/process sandbox tests require bubblewrap, a user systemd/DBus session and working user namespaces. The sandbox probe fails closed; no unsandboxed fallback is permitted. Windows test results cannot certify Linux containment. Performance tests run separately with unchanged budgets.
