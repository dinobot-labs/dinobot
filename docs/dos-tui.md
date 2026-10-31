# DOS TUI

Select /theme dos-blue, /theme dos-black or the /theme picker. DINOBOT_THEME overrides the saved preference for one launch. Default remains Signal/T-rex. Preferences use the existing tui.json store; execution state is unchanged.

DOS replaces the semantic palette, uses double outer frames and single inner dividers, and distinguishes inverse selection from yellow prompt focus. Tool, Markdown, subagent and group caches include theme identity. Switching back restores Signal colors and frames.

Terminal fonts are terminal-owned. For the intended pixel appearance select Neo둥근모 at 16px (or integer multiples), and DINOBOT_ICONS=unicode. This change does not install fonts or emit font-changing escapes. Neo둥근모 upstream: https://github.com/neodgm/neodgm (SIL OFL).

## Validation (2026-10-31)

- Canonical base: dinobot-labs/dinobot main 909d826d562a5578b714c254726355cd10a0f39b, initial fetched baseline. Delivery rebased onto bcfa9c332bec3010786bec94c08e1b131dc83595 (README-only upstream change); relevant DOS tests rerun.
- bun run typecheck passed after repairing an exactOptionalPropertyTypes violation in the new cache test fixture (omit absent error, do not set undefined).
- bun test test/tui-dos-cache.test.ts test/tui-dos-surfaces.test.ts test/tui-dos-theme.test.ts test/tui-tools.test.ts: 40 passed, 1219 assertions. Cache tests rerun after the fixture type repair together with tui-dino-theme: 19 passed, 424 assertions.
- ChatApp/MemoryTerminal integration proves command, picker arrows/Enter, save and fresh-app reload.
- Actual Windows native PTY (@oh-my-pi/pi-natives PtySession) launched ChatApp with ProcessTerminal and an explicitly mock client three times. Typed /theme dos-blue, dos-black, rex; saved preference matched each selection, DOS box output present, all three exited 0 without timeout. Local evidence scripts/ANSI live under .dinobot/dos-pty* (not release files). No model calls or real daemon requests.
- bun run release --local built and audited the npm dual bundle/archive successfully. This is not publication.
- bun run build compiled 2452 modules but failed copying the Bun executable (ENOENT). A one-line console.log compile probe reproduced the identical error, independently of DOS/app code. No compiled executable acceptance claimed; no security-policy changes attempted.
- git diff --check passed. LSP unavailable; closure inspected by search.

## Boundaries

Native PTY confirms terminal I/O, not terminal font rasterization or IME. Full ChatApp approval routing remains covered only by shared Picker and renderer tests, not a live approval run. Desktop native/package acceptance and release/install are separate downstream work. User installation and running daemon were untouched.
