# Releases

Official CLI/TUI packages are hosted on Cloudflare R2 through the dedicated `releases` Worker. Desktop downloads use a separate service and are unchanged.

First installation uses the managed bootstrap scripts documented in the [README](../../README.md#install-and-run): `/install.sh` for macOS/Linux and `/install.ps1` for Windows. Bun is required; the scripts do not install Bun or elevate privileges. The launcher checks Cloudflare on each launch and installs verified packages into immutable per-version slots. Running daemons are never restarted by managed updates. See [Managed Updates](Managed-Updates.md) for paths and activation timing.

The `/core/dinobot.tgz` route remains a compatibility redirect to the latest immutable package, not the recommended managed installer. Existing global installations retain their old updater until the user selects the new managed launcher. Third-party dependencies still come from their package registry; no npm publishing account is required.

Version 0.8.5 bootstrapped this channel through the audited local publisher from source `4f6576eed7f6599e5f22d1c5f59bb0060bfd3b96`. It is already immutable. Do not republish it from a different build: Windows Bun 1.4.3 and hosted Linux Bun 1.4.2 produced different archive hashes. Subsequent versions should be published by the GitHub release workflow below, using its single checked artifact.

## Source and package identity

`bun run release` builds and audits a local package-format tarball under `dist/npm/`; `npm pack` is local and does not publish. The archive audit remains unchanged. GitHub tags identify the exact source, and the release workflow downloads the artifact produced by its source checks rather than rebuilding it at publication time.

Before publication, run relevant functional tests, type checks, archive audit and the packaged smoke test. Linux sandbox checks require Linux. Do not describe checks on one platform as coverage of another. Source verification is not packaged or deployed acceptance.

## Publication

Maintainers bump the source version and publish a stable GitHub release for its exact tag. The `release: published` event selects that immutable source, verifies it, verifies the tag against the tested SHA, downloads the checked artifact, rechecks its SHA-512 and archive contents, and publishes through `script/ci/publish-cloudflare.ts`. A manual workflow dispatch retries an existing published stable tag. Drafts and prereleases do not publish to the stable channel. No automated release PR or organization-wide Actions permission change is required.

The repository secret `CORE_PUBLISH_TOKEN` authenticates only to the dedicated Worker publication endpoint. It is not an npm token or a Cloudflare account token. The same value is stored as the Worker's secret binding. Never log or commit either value.

Publication stores only `core/` keys in R2. The immutable tarball and version manifest are written before the latest pointer. A checksum mismatch, a conflicting version, invalid existing metadata or a stale latest compare-and-swap fails closed. Identical retries do not overwrite a release or downgrade the channel. Public version metadata records version, source SHA, size and SHA-512 integrity.

- Latest metadata: `https://releases.dinobot.workers.dev/core/latest.json`
- Immutable package: `https://releases.dinobot.workers.dev/core/releases/<version>/dinobot-<version>.tgz`
- Version metadata: `https://releases.dinobot.workers.dev/core/releases/<version>/manifest.json`

After publication, download the public bytes and compare their checksum; execute the public bootstrap in an OS temporary directory with an isolated `DINOBOT_INSTALL_DIR`, then verify the installed launcher and version. Managed `dinobot update` validates fixed-origin metadata and SHA-512, stages a separate package, verifies its identity and executable, then atomically selects it. It never downgrades or restarts a daemon. Old global installations still use the legacy updater (including its restart behavior); they do not automatically gain managed safety.

A merge is not a published release. Link issue fixes to exact commits and label them unreleased until the corresponding artifacts are available. Never include sessions, reports or credentials in release inputs.
