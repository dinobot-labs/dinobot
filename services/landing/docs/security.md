# Landing security and request-cost contract

## Result

Source implementation and local checks passed on 2026-11-01. **Not deployed.** No account-wide settings, releases service, D1 data, privacy text, root manifests, or page entry were changed by this work.

| Surface | Behavior |
| --- | --- |
| /api/waitlist, including trailing slashes and query strings | Constant 410 JSON error gone for every method; HEAD has no body |
| /api/health | GET 200 JSON ok; HEAD 200 empty; other methods 405 with Allow: GET, HEAD |
| Other /api paths reaching Worker | Constant 404 JSON; no reflected URL, query, body, or origin |
| Non-API Worker fallback | Only GET/HEAD call ASSETS; other methods return 405 before body access |
| Asset failures | Constant 500 JSON, deny-all CSP and no-store; HEAD remains bodyless |

Worker execution never reads/drains/parses request bodies, accesses DB/limiter, calls external fetch, creates custom cache keys, or logs input/exception messages. Asset retrieval is the only binding operation, and only on page GET/HEAD fallback. Retired calls do not even access binding getters in the tests. A 2 MiB payload, malformed JSON, invalid UTF-8, large declared length, foreign origin, varied content types, custom methods, case differences and arbitrary queries were exercised locally. A zero-high-water-mark stream throws when pulled; all tested early-response paths perform zero pulls and leave bodyUsed=false.

Existing D1 name dinobot-waitlist and ID 6d10b251-9a75-435d-9eca-a9a10b53f070 remain, as does rate-limit namespace 7321. Historical CONSENT_VERSION remains waitlist-consent-v1. No schema/data operation ran. Removed the unreachable server signup/store/rate-limit/negotiation implementation and old mutation tests after a search-based import closure check. waitlist.ts retains the consent constant and legacy client emailChars constant because content and client modules still import them. No LSP server was available.

## Static routing and locale

runWorkerFirst is now only /api/*, not /. public/_headers is unchanged and retains the strict same-origin CSP without unsafe-inline. Worker asset fallback now uses that same strict page policy, while generated JSON/error responses use a stricter deny-all policy. Existing asset validators/cache-control survive fallback.

src/client/app/locale-preference.ts exports:
- localePreferenceTarget(pathname, cookie, languages): pure root-only decision returning /ko/ or null.
- mountLocalePreference(): root suggestion with location.replace, preserving search/hash and writing no cookie.

The page owner must wire mountLocalePreference into the page entry; this node deliberately did not edit main.ts. The existing selector owns its lang cookie. A supported cookie wins over navigator.languages[0]; unsupported/empty browser language defaults to English. Explicit /ko/, privacy and other non-root paths always win. /ko/ is a fixed point, and replace prevents a Back-button redirect loop. With JavaScript disabled, / stays English and explicit locale links remain available. This intentionally replaces server Accept-Language negotiation and removes root Vary by language/cookie; it is not identical server crawler negotiation.

## Cost controls, not a spend cap

Selected **10 ms CPU per request** as a conservative technical bound for this tiny fixed-response Worker. This is not a measured production CPU percentile, a request-count limit, or a monthly dollar cap. Static-first removes normal matching-asset Worker execution; dynamic requests still incur applicable request charges. Cost exposure remains proportional to request count, and separate releases/R2 costs remain outside scope.

Built metadata and @cloudflare/config conversion preserve:
- limits.cpuMs=10 → limits.cpu_ms=10
- observability.enabled=true, headSamplingRate=0.01 → head_sampling_rate=0.01
- redactQueryString=true → redact_query_string=true
- logs.enabled=true, invocationLogs=false → invocation_logs=false
- traces.enabled=false

No request success logs were added. One-percent sampling does not independently guarantee privacy or zero log spend. These are service-local settings only. Deployed enforcement and actual production CPU remain live checks.

## Local receipts

Commands ran sequentially with DEEPWORK_TYPECHECK_JOBS=2, in services/landing:

| Check | Actual result |
| --- | --- |
| bun test | 9 passed, 0 failed, 737 assertions across worker and pure locale tests |
| bun run typecheck | tsc --noEmit exited 0 |
| bun run build | cf build exited 0; Worker bundle 3.18 kB, 6 Worker modules transformed |
| node test/worker/built-runtime.mjs | Exit 0; built metadata validated with OutputWorkerSchema and converted with InputConfigSchema/convertToWranglerConfig; real local workerd routing passed |

The post-build harness reads actual .cloudflare/output/v0/workers/default/worker.config.json and bundle/index.js, not source-text assertions. It uses installed Miniflare 5.20261006.1-alpha via its supported V4 option converter. A local-only observational wrapper adds x-local-worker-executed when the built user Worker runs. No D1 or limiter binding exists in this runtime.

- GET and HEAD of /, /ko/, /privacy/, /ko/privacy/, /favicon.svg: 200, strict static CSP/nosniff, **no Worker marker**, including Korean cookie/Accept-Language headers.
- GET, HEAD, POST, OPTIONS, PATCH /api/waitlist: 410 with Worker marker; HEAD empty, all other bodies constant.
- /api/health: 200 with marker; /api/unknown: 404 with marker.
- /missing-page?secret=x: static 404 without marker. Static 404 handling can avoid the Worker as well.
- Harness disposes its owned runtime in finally. No public malformed/body/load test was performed.

Harness preparation failures were not application regressions: first conversion omitted parsed defaults, then used an output manifest as an input field; resolved by validating OutputWorkerSchema and converting its settings. Installed Miniflare v5 rejected legacy constructor options; its exported converter resolved this. An initial local API probe returned 500 because the harness did not declare has_user_worker; adding the runtime's required router declaration produced the passing results above. No failed receipt was counted as a pass.

## Remaining independent and live checks

1. Page owner wires the locale helper; page QA proves browser cookie preference, language suggestion, explicit paths, hash/query retention, no loop, no-JS links and selector behavior. Pure logic passed, but browser integration is not yet certified here.
2. Independent verifier reruns the scoped checks against integrated page source and build. The current build may precede concurrent page implementation.
3. After separately authorized deployment, inspect actual service settings (CPU/log sampling/redaction/invocation/traces/bindings), ordinary GET/HEAD routes, static/API headers and assets. A cache HIT alone is not proof of asset-first routing.
4. Production CPU behavior, account usage/billing permissions, alert status and Workers Caching activation remain unverified. No monthly spend ceiling is claimed.
5. No releases infrastructure change or download cache/R2 mitigation was performed. Final public artifact scan and browser CSP/network checks belong to integration/page QA.
