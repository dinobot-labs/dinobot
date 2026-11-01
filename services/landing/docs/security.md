# Restored landing security contract

Source restoration uses `9b91b4a48cfe9f4099e59634323037ef461f6286`, retaining current pinned dependencies, public guard and CI. This is local verification, not a deployment receipt.

## Routing and input

- `/` runs the Worker: language cookie precedes Accept-Language, crawlers receive English, Korean visitors redirect to `/ko/`. Explicit locale paths remain static-first.
- `/api/waitlist` accepts POST again. JSON bodies are capped at 4096 bytes; email syntax/length, explicit consent, supported locale, source tag, honeypot and minimum elapsed time are validated. Case-insensitive duplicates do not update existing entries.
- API requests use the existing 10 requests/minute limiter and IPv6 /64 grouping. The historical limiter deliberately fails open on binding errors; this is not a hard abuse/spend ceiling.
- GET/HEAD health and unknown API routes retain bounded JSON responses. HEAD bodies are removed. Non-read page methods are rejected.
- Strict same-origin page CSP is unchanged, including no unsafe-inline. API responses use deny-all CSP and no-store. Exceptions containing input are not logged; limiter outages log a fixed message only.

## Preserved service settings

CPU limit: 10 ms/request. Log sampling: 0.01. Query redaction: enabled. Invocation logs: disabled. Traces: disabled. These settings do not impose a monthly cost cap; restoring root negotiation increases Worker execution compared with the retired static-first root. Production CPU percentiles are not measured here.

Existing D1 name/ID and limiter namespace are unchanged. No live database command, migration, reset, deployment, or signup was performed. The historical store uses idempotent CREATE TABLE IF NOT EXISTS on the first signup per isolate, then parameterized insert/count queries; this does not reset existing data. Local tests use in-memory SQLite and a separate ephemeral Miniflare D1.

## Local checks

- 127 behavioral tests passed (8575 assertions): Worker routing, locale, signup protections, in-memory SQLite persistence, runner simulation and showcase scripts.
- Typecheck and production build passed sequentially with DEEPWORK_TYPECHECK_JOBS=2.
- `node test/worker/built-runtime.mjs` passed using the actual built Worker/assets with local workerd: locale/cookie/crawler routing, static assets, isolated D1 signup/duplicate/validation/bot/body cap, rate limiting and HEAD. It asserts the emitted CPU/observability/binding settings.
- Public artifact guard passed on a clean publication-source snapshot; five guard/discovery fixtures passed.

## Historical target caveat

The supplied `9b91b4a` source has the dinosaur UI and download section, **not a homepage waitlist form**. Commit `24dfd2b` replaced that form with downloads; preceding `9d77914` contains the earlier waitlist UI. The API is restored and validated, but no claim is made that this exact historical homepage offers signup. Choosing a different visual revision requires an explicit parent decision. Browser visual/CSP animation verification and live deployment checks remain separate.
