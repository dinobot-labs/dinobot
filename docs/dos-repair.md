# DOS repair evidence

- Reproduced stale ANSI in subagent row/group rendering: 8 failing tests before repair. Added themeName() to the two cache keys; no data/execution mutation changes. Closure inspected by search (LSP unavailable): screen.ts default subagent/group renderers.
- Command: bun test test/tui-dos-cache.test.ts test/tui-dos-surfaces.test.ts test/tui-dos-theme.test.ts test/tui-tools.test.ts
- Result: 40 pass, 0 fail, 1219 assertions. Covers rex -> dos-blue -> dos-black -> rex, running/completed/failed/cancelled rows/groups, unchanged tool diff text/error data, approval Picker rendering and Enter choice. Approval fixture is the real shared Picker, not full ChatApp ask routing. Diff fixture is tool output text, not a specialized diff renderer.
- git diff --check passes. Removed CR whitespace on changed lines only, preserving baseline line endings elsewhere to avoid whole-file churn.
- No heavy typecheck/build/browser or native PTY acceptance run. Existing takeover view lifetime caches and full ChatApp approval routing are outside this bounded regression evidence. No original repository writes, install, commit or push.
