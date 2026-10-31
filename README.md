<p align="center">
  <img src=".github/assets/logo.svg" alt="Dinobot logo" width="160">
</p>

# Dinobot

**The agent daemon and terminal interface behind Dinobot.**

Work with an agent in your terminal, connect it to your team’s chat, and extend it with tools. Dinobot is written in TypeScript for Bun; the daemon runs the agent, while the terminal user interface (TUI) connects to it locally.

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md)

Source available · [PolyForm Noncommercial 1.0.0](LICENSE) · Not OSI-approved open source

## See it in action

https://github.com/user-attachments/assets/6b7d112e-d469-4512-b97b-96999dcf8936

## Choose your interface

- **Dinobot — this repository:** the agent daemon and TUI. Start here to run the core or work in a terminal.
- **Dinobot Desktop:** an Electron/React desktop client that requires a compatible Dinobot daemon.
  https://github.com/dinobot-labs/dinobot-desktop

## What you can do

| Capability | In practice |
| --- | --- |
| Work in the terminal | Start the TUI, sign in to a model provider with `/login`, and choose a model with `/model`. |
| Connect chat channels | Configure Slack, Discord, Telegram or a local HTTP channel in the manifest. Messaging adapters require their own credentials and access settings. |
| Add tools | Configure plugins for MCP servers, browser and desktop automation, and other integrations. Some need external programs or service accounts. |

See [dinobot.example.yaml](dinobot.example.yaml) for configuration examples. Enabling a plugin does not supply its credentials or dependencies.

## Install and run

You need **Bun 1.4.2 or newer** and your own model-provider credentials. Install the official CLI/TUI package from Cloudflare:

```bash
bun add -g dinobot@https://releases.dinobot.workers.dev/core/dinobot.tgz
dinobot
```

Update with `dinobot update` (or `dinobot update --no-restart` to leave the daemon running). Users of older npm releases must run the URL install once to switch update channels. Dinobot publication no longer needs npm credentials; third-party dependencies still download from npm. Desktop installation is separate.

To run from source, you also need Git:

```bash
git clone https://github.com/dinobot-labs/dinobot.git
cd dinobot
bun install --frozen-lockfile
bun src/main.ts --help
bun src/main.ts tui
```

In the TUI, use `/login` to connect a model provider, then `/model` to select a model. The TUI starts a background daemon if none is running; closing the TUI does not stop that daemon.

For a custom configuration, use [dinobot.example.yaml](dinobot.example.yaml) as a reference, save your settings in `dinobot.yaml`, and start with:

```bash
bun src/main.ts tui --config dinobot.yaml
```

Keep credentials out of the manifest. For a foreground daemon instead of the TUI, use `bun src/main.ts serve --config dinobot.yaml`.

**Local does not mean isolated.** The HTTP API is unauthenticated and is not a multi-user security boundary. Keep it on loopback and a trusted local machine/account; do not expose it to the Internet, untrusted networks or public proxies. Model providers and enabled integrations may send data to external services. Read [SECURITY.md](SECURITY.md) before connecting tools or channels.

Model credentials and external services are not included. Telemetry/report and OAuth backend operations are outside this source snapshot; source access does not promise access to those backends.

## Develop and contribute

```bash
bun run typecheck
bun test
bun run build
bun script/public-artifact-guard.ts
```

`bun run build` stages a host executable and native addons. `bun run release` builds and audits a local npm archive; it does not publish it. A source build alone is not an installable release. See the development guide for platform-specific test requirements; do not test with production data or real credentials.

- [Development guide](docs/wiki/Development.md) — checks and environment requirements.
- [Contributing](CONTRIBUTING.md) — issues, pull requests and contributor rights.
- [Project wiki](docs/wiki) — development and release guidance.
- [Source snapshot](PUBLIC_SNAPSHOT.md) — publication scope and release details.

This repository contains a curated source snapshot, not the original development history.

## License

Permitted noncommercial use is free under [PolyForm Noncommercial 1.0.0](LICENSE). This is **source-available, not OSI-approved open source**. Commercial use requires separate written permission from the relevant rights holders; contact dev0jsh@gmail.com for licensing discussions.

Third-party code retains its original licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
