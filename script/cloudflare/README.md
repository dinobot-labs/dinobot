# Core release Worker

A separate Worker named **releases**, served at https://releases.dinobot.workers.dev. This is not the Desktop **get** Worker. No Desktop source, route or object is changed.

## Bindings

- `BUCKET`: existing R2 bucket `dinobot-desktop-releases`. Every key accessed by this Worker starts with `core/`.
- `CORE_PUBLISH_TOKEN`: secret bearer token, set through the Cloudflare API or secret tooling. Never place it in source, shell history, output or request logs.

The default export is a module Worker with `fetch(request, env)`. It uses Web APIs only, no SDK, Node compatibility or rate-limit binding. The deployment tool bundles `script/cloudflare/deploy-entry.ts` for the browser and `src/managed-install.ts` for Bun, both as ESM. It uploads the Worker plus three `text/plain` module assets (`install.sh.txt`, `install.ps1.txt`, `install.mjs.txt`) in the same multipart deployment. Bootstrap files do not use R2. Deploy and credentials are managed separately. There is no health route; before first publication, `GET /core/latest.json` returns 404 with `{"error":"not_found"}`.

## Public requests

GET and HEAD support:

| Path | Result | Cache-Control |
| --- | --- | --- |
| /install.sh | POSIX bootstrap script | no-store |
| /install.ps1 | PowerShell bootstrap script | no-store |
| /install.mjs | Bundled Bun managed installer | no-store |
| /core/latest.json | Release metadata | no-store |
| /core/dinobot.tgz | 302 to the current immutable tarball | no-store |
| /core/releases/VERSION/dinobot-VERSION.tgz | Exact published bytes | public, max-age=31536000, immutable |
| /core/releases/VERSION/manifest.json | Immutable release metadata | public, max-age=31536000, immutable |

VERSION must be three decimal components with no leading zeroes (except zero itself), no prefix, prerelease or build suffix, maximum 256 characters. The tarball filename version must equal the directory version. HEAD always has an empty body, including errors. Metadata and tarballs expose quoted R2 ETags. Tarballs use `application/gzip` and Content-Length. Unknown routes return 404; wrong methods on known routes return 405 with Allow. Query parameters do not change the selected object.

Metadata has this shape:

```json
{
  "name": "dinobot",
  "version": "1.2.3",
  "dist": {
    "tarball": "https://releases.dinobot.workers.dev/core/releases/1.2.3/dinobot-1.2.3.tgz",
    "integrity": "sha512-<canonical base64 of the 64-byte digest>"
  },
  "sourceSha": "<40 lowercase hex characters>",
  "size": 123456,
  "publishedAt": "2026-01-01T00:00:00.000Z"
}
```

## Managed installation

Install Bun first from https://bun.sh. Bootstrap scripts require Bun on PATH and stop before creating temporary files when it is missing. The POSIX bootstrap also requires curl.

Download the appropriate script over HTTPS without following redirects, inspect it, then execute it:

- POSIX: https://releases.dinobot.workers.dev/install.sh (`sh install.sh`)
- Windows: https://releases.dinobot.workers.dev/install.ps1 (`.\install.ps1` in PowerShell)

PowerShell must permit the downloaded script under your existing policy. No ExecutionPolicy bypass or elevation is performed. Both scripts fetch only https://releases.dinobot.workers.dev/install.mjs, reject redirects/non-200 responses, run `bun <temporary-install.mjs> --install`, report installer failures and remove their temporary directory. POSIX preserves the native exit status. PowerShell throws an error containing the original Bun exit status (a `-File` invocation returns 1), rather than calling `exit` and terminating an interactive caller. Success returns to that caller. They never call sudo or restart the daemon.

The managed installer owns installation under `~/.local/share/dinobot` on POSIX or `%LOCALAPPDATA%/dinobot` on Windows, with `DINOBOT_INSTALL_DIR` as an override. It creates immutable version slots and launcher/shims; launch-time update checks do not restart an already running daemon. Bootstrap scripts themselves only stage the temporary installer.

`buildReleaseModules()` performs an offline build without uploading. Deployment still uses `bun script/cloudflare/deploy.ts` with the existing secret environment settings below. A failed build stops before any Cloudflare request; errors printed by the CLI do not include raw API bodies or credentials.

## Private publication

POST `/core/publish` with the binary tgz as its entire body, **not multipart**:

- `Authorization: Bearer <CORE_PUBLISH_TOKEN>`
- `x-release-version: 1.2.3`
- `x-release-sha: <40 lowercase hex characters>`
- `x-release-integrity: sha512-<canonical base64 digest>`

A non-empty body of at most **32 MiB (33,554,432 bytes)** is accepted, including chunked requests. Content-Length is optional and never substitutes for measuring the stream. SHA-512 is verified before any R2 write. This endpoint verifies identity and size, not archive structure, package version inside the tgz, source provenance or package safety; the trusted release producer must validate those before publication.

Success is HTTP 200:

```text
{ok: true, release: <metadata>, latestVersion: <version observed/promoted>, promoted: <boolean>}
```

Errors are `{"error":"CODE"}`; all publication responses and errors use `Cache-Control: no-store`.

| HTTP | Codes | Meaning |
| --- | --- | --- |
| 400 | https_required, invalid_release_headers, empty_body | Invalid release input |
| 401 | unauthorized | Token missing/wrong, or secret binding empty; rejected before body/R2 access |
| 409 | release_conflict | Existing bytes, source SHA, size or stored artifact checksum differ |
| 409 | downgrade | Unpublished older version cannot replace latest |
| 409 | latest_conflict | Another publisher won the latest CAS; retry the identical upload |
| 413 | body_too_large | Body exceeds limit or Content-Length is invalid/excessive |
| 422 | checksum_mismatch | Uploaded bytes do not match the declared SHA-512 |
| 503 | invalid_stored_metadata | Existing metadata is malformed; publication stops closed |
| 503 | storage_unavailable | Storage/request processing failed; backend details are not exposed |

### Publication invariants

1. The latest object is read and validated before any mutation. Only an absent latest allows bootstrap. Strict numeric comparison uses decimal component length and lexicographic order, never JS numbers, so large version components remain exact.
2. Both tarball and version manifest are created with R2 `onlyIf: {etagDoesNotMatch: "*"}`. Existing objects are never overwritten. The tarball atomically binds `sourceSha` and `integrity` in customMetadata. This prevents same-byte/different-source races before the manifest exists.
3. Stored tarball bytes are read back and hashed even after successful insertion. A matching immutable manifest is reused with its original publishedAt. A partial tarball-only publication can be completed by an identical retry.
4. Latest is changed only after artifact verification and manifest creation/readback, using `etagMatches` against the snapshot, or `etagDoesNotMatch: "*"` for bootstrap. A CAS loser receives 409; no unconditional write or automatic retry occurs.
5. A previously published older version can be retried identically without changing latest. An unpublished downgrade is rejected. A successful no-op response reports the latest snapshot observed during that request; another publisher may advance it concurrently.
6. Multi-object publication is not transactional. Failed requests may leave immutable artifact/manifest objects, but cannot move latest backward. There is no cleanup/delete route. Do not manually rewrite or delete release objects: the guarantee assumes all publishers use these conditions and R2 strong consistency.

## Behavioral verification

Run sequentially:

```sh
bun test test/install-bootstrap.test.ts
bun test test/cloudflare-worker.test.ts
```

The in-memory R2 seam returns object snapshots, derives ETags from contents and atomically checks conditional writes at commit time. Tests cover auth-before-body, checksum and size boundaries, immutable conflicts, partial writes, exact numeric ordering, bootstrap/upgrade/downgrade, deterministic CAS races, readback corruption, cache headers and route/method handling. They do not certify deployed Cloudflare bindings, Cloudflare memory limits, public TLS/DNS or live R2 behavior; deployment must exercise those separately.

Deployment: set CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN and CLOUDFLARE_RELEASE_BUCKET through a secret source, then run `bun script/cloudflare/deploy.ts`. First deployment also requires CORE_PUBLISH_TOKEN. For an existing Worker, omit CORE_PUBLISH_TOKEN to preserve its secret binding: deployment first checks that the existing secret name/type and R2 bucket match, then uses Cloudflare `keep_bindings: ["secret_text"]`. It never reads or prints the secret value. Publication requires HTTPS; plaintext requests are rejected before reading the body.
