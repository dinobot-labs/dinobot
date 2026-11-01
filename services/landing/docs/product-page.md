# Historical product page implementation

**Superseded:** the DOS-led composition below was rejected as a product-message/design failure. Current direction and evidence are in BRIEF.md, reference-brief.md and product-facts.md. The replacement explains project-file/command work, actual bounded workflow, interface roles, configuration and installation. Historical QA below does not certify the replacement.

Implemented locally on 2026-11-01. **Frontend implementation and scoped smoke passed; not deployed or committed.** Independent creative, accessibility, security and publication acceptance remain with the integration owner.

## Delivered

- Six static-first EN/KO sections: real product, tool detail, workflow choices, entry points, separate Desktop/CLI installation, FAQ. Paper/Cobalt layout, original dinosaur, licensed self-hosted Geist/Geist Mono and existing renamed Pretendard subset pipeline.
- Full original 1280×720 blue/black captures; native original-image links; explicitly scripted/mock-provider captions. Tool detail is the approved 704×248 crop at (432,192), not simulated HTML. Only approved PNGs were copied; no capture receipt/profile/config was published.
- Fixed platform/version download destinations and honest unsigned-Windows/source-license/external-provider notes. Exact CLI bytes; Bun 1.4.2 prerequisite, manual PATH, old-global-install and next-natural-start update boundaries.
- Native OS radios, keyboard-operable preview buttons, native FAQ disclosures, selectable horizontally scrolling command region, polite clipboard status and no-JS command fallback.
- Existing locale-preference helper wired without modification. Existing lang cookie preserved; selector now retains both query and hash. Historical privacy body values were copied unchanged; only navigation/footer presentation changed.
- Removed obsolete fake chat/showcase/runner/mascot/styleguide runtime modules and old client behavior/style closure; no Doto font payload. Replaced the old design route with a noindex token/component guide. Reused reviewed locale OG PNGs.

## State and closure

Search-based closure: no installed LSP server was available. Inspected vite/pages.ts, routes, template renderer, font pipeline, all page entries and client imports before edits. Existing generation pipeline remains the authority; no invented index.ts or new runtime dependency.

One product module owns preview and installation interactions. Installer state is (OS, copy state, generation). Every OS selection invalidates pending generations, including macOS→Linux where command bytes match. Duplicate pending requests return without writing. Clipboard success/failure only publishes for the current generation. Preview decode completes before replacing the last good image and original-image target. No installer is executed and no network telemetry/release polling is introduced.

The copied label means only that clipboard writing succeeded. Clipboard denial/missing API selects command text and offers manual instructions; it does not claim installation or download success. Pending copy uses aria-disabled/aria-busy plus the controller guard rather than native disabled, retaining keyboard focus.

## Actual checks

All commands ran sequentially with DEEPWORK_TYPECHECK_JOBS=2.

| Check | Observed result |
| --- | --- |
| bun run typecheck | Exit 0 after final source change |
| bun test | 17 passed, 0 failed, 755 assertions; includes 8 new behavioral installer tests |
| bun run build | Exit 0; six generated entries; final client JS 3.61 kB, CSS 10.70 kB (uncompressed) |
| Owned Edge smoke | EN/KO × 1440×900 and 390×844; six sections, loaded applicable fonts, no document overflow or console/page errors |
| Actual clipboard readback | Windows/macOS/Linux exact command bytes in both locales and both viewports, 12 successful reads; no installer execution |
| Preview / FAQ / no-JS | Both real image states and original link update; native FAQ opens; KO no-JS keeps both commands visible |
| Additional behavior probe | Pending keyboard focus retained; stale completion leaves new OS idle; Korean root suggestion and explicit EN switch preserve query/hash and only lang cookie |
| 320px width | EN/KO document width exactly 320px |

### Rendered geometry

| Viewport / locale | Hero image top | Image size | Image bottom |
| --- | ---: | ---: | ---: |
| 1440×900 EN and KO | 364.78px | 1200×675px | 1039.78px |
| 390×844 EN and KO | 408.06px | 350×196.875px | 604.94px |

The desktop tool result is inside the first fold. Mobile shows the full image and honest caption in the first viewport; original-image navigation remains available for readable zoom. Mobile provenance uses its own 15px/22px line rather than undersized utility text. EN loads Geist/Mono; KO additionally loads dinobot KR. Screenshots of both locales at top, tool detail, install and FAQ were opened and visually reviewed, plus black preview samples.

## Evidence and preparation failures

Evidence stays outside public assets in reports/landing-page-implementation:
- smoke.mjs, smoke.json, smoke-run.log and locale/viewport JPEGs: final local browser run.
- behavior.mjs / behavior.json: keyboard, late completion, locale and narrow-width checks.
- behavior-before-fix.json: failing pending-control guard. The initial native disabled implementation was observed dropping focus to body; replaced with aria-disabled plus the already-tested duplicate guard. Final keyboard probe retains focus.
- crop.ps1: deterministic approved source crop. Initial PowerShell non-ASCII literal decoding failed; relative script-root paths fixed it.
- Initial migration preparation had an escaped-newline syntax error before mutation; rewritten and executed successfully. Initial screenshot output used URL pathname with percent encoding and failed; fileURLToPath fixed output paths.
- Image previews appeared inconsistent in the review attachment display. A direct pixel comparison of matching EN/KO mobile product rectangles found zero differing pixels; the saved KO crop shows intact content. Final smoke captures use a fresh headless Edge with GPU disabled and two animation frames after scrolling. This is not performance evidence.

## Boundaries / remaining acceptance

No worker, Cloudflare configuration, security helper/test, root manifest/lockfile, D1 data, security headers or privacy semantics changed. No commits, pushes or deployment. The outer worktree already contained owner changes; these were not reset or included in a commit.

Owner final QA still needs independent rendered contrast/accessibility/Lighthouse, FPS and reduced-motion measurements; the full real-browser clipboard-denial/missing-API/race matrix and preview-failure behavior; 200% text zoom and complete keyboard traversal; runtime/security/publication scan and final public download availability. Pure rejection/race tests passed but do not replace those browser checks. No production availability, installation, performance or final-delivery claim is made here.
