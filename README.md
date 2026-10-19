# dinobot

Source-available agent daemon and terminal UI (TUI), written in TypeScript for Bun.

## License

Free noncommercial use under PolyForm Noncommercial 1.0.0 (LICENSE). This is not OSI-approved open source. Commercial use requires separate written permission: dev0jsh@gmail.com. Third-party code retains its original licenses; see THIRD_PARTY_NOTICES.md.

## Development

Use Bun 1.4.2 or newer. Run `bun install --frozen-lockfile`, `bun run typecheck`, and `bun test`. `bun run build` stages a host executable and native addons; `bun run release` builds and audits a local npm archive, not a publication. Run `bun src/main.ts --help` for CLI usage. Start locally with `bun src/main.ts`; configure from dinobot.example.yaml and sign in with `/login`.

The API is not an authenticated multi-user security boundary. Keep it on loopback; do not expose it to the Internet or untrusted networks. See SECURITY.md. Model credentials and external services are not included. Telemetry/report and OAuth backend operations are outside this source snapshot; public source availability does not promise backend access.

See CONTRIBUTING.md and docs/wiki for development, issue, PR and release guidance. This repository contains a curated source snapshot, not the original development history.
