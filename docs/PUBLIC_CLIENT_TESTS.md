# Public client and service integration boundary

Public client tests use independent protocol doubles with actual ephemeral loopback HTTP transport. No private service source is imported or copied. Historical Google/report client coverage originated at export baseline `0aefd6416a45b810039f2bed05d8e09ceb48d43d`; the report CLI/API/diagnostic coverage now also includes the recovered product delta through `3020f2be8d7407f148d4e265f9fd70dc8c448cf1`. These are source identities, not test-pass claims.

## Google

`test/google.test.ts` retains PKCE request shape, issuer rejection, token refresh/revocation, scope checks, persisted grants, API request shapes, tool invocation and separability checks. Its fixture answers broker configuration/pending/token messages and synthetic Google REST routes. Client-secret injection and browser callback persistence are not tested here.

## Reports

- `test/report-service.test.ts`: consent, preview, client-side redaction, diagnostic/conversation projection, gzip/hash wire format, automatic delay/cooldown, retries, undo/withdraw, participant exclusion, TUI API and command flows.
- `test/report-api.test.ts`: consent version/shape rejection and one-step daemon API reports with live/thread context, without creating a nonexistent thread.
- `test/report-cli.test.ts`: real CLI child processes with a fake install, no-daemon send, synthetic daemon routing and timeout fallback. The upload target is a loopback protocol double.
- `test/report-diagnostics.test.ts`: bounded diagnostic sections, masking/anonymization, isolated section failures, fake setup-failure context, consent migration and retry persistence.
- `test/report-lock.test.ts` and `test/report-redact.test.ts`: shared-state locking and redaction regressions.

The shared `test/fixtures/report-protocol.ts` captures the exact compressed client payload and checks request/hash/delete/withdraw messages. `protocol-http.ts` provides loopback transport. The fixture does not redact the captured payload; secrecy assertions therefore test the client projection. It does not implement or certify D1/R2 storage, processing queues, retention, server-side redaction or backend authorization. Test preload disables external diagnostic network probes; no real report upload is needed.

## Separate service acceptance

Cross-service acceptance needs evidence from the service owner against an explicitly identified service revision and protocol version, including broker callback/token-secret handling and report persistence/authorization/retention. These public tests are not equivalent evidence. Do not resume development in the retired private client repositories to obtain it, and do not publish private source or operational artifacts.

POSIX permission assertions remain active on Linux. Windows does not claim POSIX-mode or ACL acceptance from those assertions. Google path-separability normalizes directory separators without relaxing the import rule.
