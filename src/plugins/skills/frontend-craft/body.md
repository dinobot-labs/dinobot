# Frontend craft: SF-startup-grade landing and marketing pages

Use this skill when someone asks for a landing page, waitlist page, marketing site, product page or similar public frontend. It works well when they ask for "polished", "like an SF startup", "fun animation" or a performance bar (for example 120 FPS). It produces a researched design system, brand assets, the page, real QA numbers and a deployment, not a template page.

Worked example: the dinobot waitlist site (https://www.dinobot.workers.dev, repo tmdgusya/dinobot services/landing, ADR 0086). Its docs/BRIEF.md, docs/references/*.md, docs/design-system.md and qa/*.mjs are the reference implementation. Read them when you can.

## Companion files

| Purpose | File |
| --- | --- |
| Brief template | `templates/BRIEF.template.md` |
| Reference research guide | `templates/REFERENCE_GUIDE.md` |
| Screenshot a URL with headless Edge | `scripts/shot.mjs` |
| Fingerprint a site (fonts, colors, motion tech, scroll FPS) | `scripts/fingerprint.mjs` |
| Start/stop a local Vite dev/preview server for QA | `scripts/serve.mjs` |
| Minimal rAF FPS probe (default vs uncapped) | `scripts/fps-probe.example.mjs` |

Copy the scripts into the project's `qa/` folder and adjust paths (they assume Edge at the default Windows path and run from the service root).

## 0. Ground rules
- Explore first: existing brand assets (logos, mascot data, color tokens in code, ADRs), product docs, deploy targets and accounts. Reuse the brand before inventing a new one.
- Set a measurable goal (goal_set) with these criteria: references >= 20; design system tokens + living style guide; assets used on page; sections; i18n if asked; FPS; Lighthouse a11y; deployed + live E2E; merged.
- Use a DAG. Keep each node small: nodes that run the whole QA suite or view many screenshots die of context exhaustion (model_error). Split large integration into polish -> polish -> qa-fix -> verify.
- Work in a separate git worktree and branch if other threads share the repo. Never leave dev servers running: start them inside the script that uses them (scripts/serve.mjs withServer).

## 1. Brief first (orchestrator writes it, every node reads it)
Write docs/BRIEF.md (template: templates/BRIEF.template.md). It contains the goal, audience and message hierarchy, existing brand assets, design direction with do/don't, the section-by-section information architecture, motion and performance rules, the API contract, the tech layout and directory ownership per node, module contracts between parallel nodes, QA hooks (data attributes) and the definition of done. Keep it current. When a facts check or a review changes something, append a numbered "creative director notes" section instead of telling nodes ad hoc.

## 2. Facts sheet before copy
A node reads the real product (code + docs) and writes docs/product-facts.md. For each strength it records what the strength is, why a non-expert cares, evidence paths, a 3-6 beat animation storyboard, EN/KO copy and claims to avoid. It also writes a FAQ and a "do not claim" list. Copy never exceeds the facts. Examples of things it may forbid: improvement claims, open source, pricing, dates, third-party logos.

## 3. References (>= 20, three parallel groups)
Use templates/REFERENCE_GUIDE.md. Typical pools:
- A: light, mostly monochrome design-system-grade startups (Vercel, Notion, Loops, Cursor, Anthropic, Attio...)
- B: mascots and playful dot/pixel brands (Ollama, Deno, Bun, Playdate, Nothing, PostHog, Chrome T-Rex...)
- C: products in the same category, plus waitlist mechanics

Each entry needs a live check, screenshots that you actually view (scripts/shot.mjs), real numbers from scripts/fingerprint.mjs (fonts, colors, H1 size/tracking, motion libs, scroll FPS), "why it's great", "borrow" and "avoid". Every group ends with token-level takeaways and a Top 3. A verifier counts the entries and spot-checks liveness. Then merge them into docs/references.md: an index, a synthesis matrix and 10-15 principles, each principle citing references.

## 4. Design system (the most important creative step)
- Tokens in CSS custom properties:
  - neutral scale (10-12 steps, one hue)
  - brand signals as flat solids with AA "deep" text variants and tints
  - semantic roles
  - fluid type scale with tracking per step (display around -0.045em)
  - spacing, radii, borders, flat elevation, z-index, layout, motion (durations, easings, linear() springs, stagger, reduced-motion policy)
- Compute contrast programmatically for every text/background pair. Publish a living /design/ style guide with every token and component state, set to noindex.
- Self-host OFL fonts only. Subset CJK at build time. Record licenses.
- Signature ideas that worked: a five-stripe flat brand band, an inline pill word inside the H1, a character peeking over the product card, and a dot-grid paper texture.

## 5. Assets
Derive the mascot and logo from existing brand data (for example, a TUI bitmap becomes round SVG dots). Build poses: idle, blink, done, failed, look, run, jump. Make eyes read clearly on light backgrounds. The pure render function returns an SVG string. Ship a favicon set and OG images per locale from a re-runnable script (Edge screenshot of an HTML template). Write an inventory doc.

## 6. Build (parallel nodes with disjoint write scopes)
- Page node: templates plus locale dictionaries rendered at build time, forms with every state, SEO/OG/hreflang, a security-header CSP, and tests for key parity and leftover placeholders.
- Scene/showcase node: each product strength gets its own animated scene, plus an interactive "watch it work" demo with a step bar, pause and replay.
- Game/fun node: a canvas widget with a pure fixed-timestep simulation (for example a Chrome-dino runner bar), unit-tested.
- Backend node: API, storage, rate limit, honeypot and consent. Use fakes for tests.
- Contracts: each module exports mountX(host, opts) and returns {destroy}. The page supplies empty hosts with fixed aspect ratios so there is no layout shift (CLS).

## 7. Motion and the FPS budget
- Animate only transform and opacity. Do not animate layout, filter (including filter: opacity), box-shadow, clip-path or backdrop-filter. Avoid blurred shadows inside animated scenes.
- Prefer CSS animations, WAAPI and scroll-driven animations (animation-timeline: view()) with an IntersectionObserver fallback. Pause anything offscreen or hidden. Loading dots must not run while invisible.
- **Ghost-first scenes**: render the final composition dimmed from the first frame, then animate activation. Never show a big empty box. Moving tokens travel through empty lanes on solid bordered surfaces.
- Word swaps use clipped vertical slots, so two words never overlap.
- prefers-reduced-motion shows the final state plus a Play button.

## 8. QA harness (scripts/ + build these per project)
- screens: locales x 1440/390 x top/middle/bottom + reduced motion; console errors; QA hooks (fixed bar visible, footer not covered, jump changes state); hreflang and leftover checks.
- fps: Edge headless via playwright-core. The default headless clock is about 200 Hz; also run uncapped with --disable-gpu-vsync --disable-frame-rate-limit, keeping a 1px damage animation so frames are produced. Script a human-like full scroll plus interactions. Gate on the min 250 ms-window FPS (>= 120); report p99 and a 4x CPU-throttle run. Machine load (games, other agents) causes false failures, so rerun before blaming the site.
- lighthouse: npx lighthouse with CHROME_PATH pointing to Edge, desktop and mobile.
- Verify nodes must judge like a strict design director from screenshots they actually view, not only from JSON.

## 9. Creative director loop (orchestrator)
After the first full build, take screenshots (en/ko x desktop/mobile, every section) and review them yourself. Typical defects: empty scene areas, overlapping swaps, tiny game sprites, missing mobile locale toggle, random icons. Write them as numbered binding notes in BRIEF, then run polish nodes.

## 10. Ship
Deploy with fresh infrastructure (for example D1 with an explicit location hint). Run a live E2E: post a test signup, query the DB, delete the row, confirm it is gone. Run Lighthouse and FPS on the live origin. Write a README and an ADR, open a PR, and wait for CI. Note that root CI may run service tests without service deps, so test imports must not pull build-only packages. Resolve bot review threads, merge, and confirm the post-merge workflow.

## Windows notes
- winget Bun has no bunx; add ~/.bun/bin/bunx.cmd containing "@bun x %*".
- With @cloudflare/vite-plugin, set multi-page inputs only in environments.client.build.rollupOptions.input; a top-level input breaks the worker build.
- Vite dev on non-ASCII paths can fail on inline module scripts, so use external files.
