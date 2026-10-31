# Releases

Official CLI/TUI packages are hosted on Cloudflare R2 through the dedicated `releases` Worker. Desktop downloads use a separate service and are unchanged.

```sh
bun add -g https://releases.dinobot.workers.dev/core/dinobot.tgz
dinobot update
```

The short installation URL redirects to the latest immutable version. Older npm builds need the URL install once: their embedded updater still queries npm. Bun and npm remain supported installation managers; third-party dependencies still come from npm. No npm publishing account is required.

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

After publication, download the public bytes and compare their checksum; test a URL installation in an isolated global prefix. `dinobot update` validates the fixed-origin metadata, verifies the downloaded package digest before installing, preserves the owning manager, and checks the installed version. It never downgrades. Its default daemon restart can interrupt active work; update when idle or use `--no-restart` to leave the daemon untouched.

A merge is not a published release. Link issue fixes to exact commits and label them unreleased until the corresponding artifacts are available. Never include sessions, reports or credentials in release inputs.
