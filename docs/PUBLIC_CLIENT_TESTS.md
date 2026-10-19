# Public client and private integration boundary

The public google.test.ts and report-service.test.ts were restored from source commit 0aefd6416a45b810039f2bed05d8e09ceb48d43d. Their public client scenarios use an actual ephemeral loopback HTTP server. No private service source is imported or copied.

Google retains PKCE request shape, issuer rejection, token refresh/revocation, scope checks, persisted grants, API request shapes, tool invocation and separability checks. The fixture answers the broker configuration/pending/token protocol and synthetic Google REST routes. Client-secret injection and browser callback persistence are NOT tested here.

Report retains consent, preview, client-side redaction, gzip/hash wire format, automatic delay/cooldown, retries, undo/withdraw, participant exclusion, TUI API and command flows. The fixture records uploads and checks authorization hashes for delete/withdraw. It does not claim server-side redaction, D1/R2 persistence, queues, retention or authorization implementation coverage.

## Mandatory private integration CI (not implemented in this public repository)

On the matching private source revision, retain and run the original test/google.test.ts and test/report-service.test.ts plus services/oauth-broker and services/report-worker tests. Keep the real broker callback/token-secret and report Worker/D1/R2/Queue assertions there. Publish only the check conclusion and source identity, not private artifacts. An owner must wire this separate check before claiming cross-service acceptance; these public fixture tests are not equivalent evidence.

POSIX 0600 checks still run on Linux; Windows does not claim POSIX-mode or ACL acceptance. Google path-separability normalizes directory separators without relaxing the import rule.
