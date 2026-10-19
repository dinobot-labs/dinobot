# Vendored: answer-me-with-html

- Upstream: https://github.com/QingYunA/answer-me-with-html (MIT License, see LICENSE)
- Vendored commit: 1ca0988ac179722cbfdb51efd62b25244cfe40c1 (upstream version 0.4.8)
- Vendored on: 2026-10-05

## What is vendored

- `am.mjs` — the self-contained single-file CLI from `skills/answer-me-with-html/scripts/am.mjs`
  upstream. It renders a short Markdown draft into a single-file HTML explainer page
  (templates, SVG auto-layout, STE controlled-writing check). Requires Node.js 20+, no
  dependencies to install.
- `SKILL.md` — the upstream skill instructions, kept verbatim as the usage reference.
- `LICENSE` — the upstream MIT license.

## How the harness uses it

`script/reinstall.ts` installs these files to
`~/.local/share/dinobot/vendor/answer-me-with-html/`. The `explanation` skill calls:

```bash
node "$HOME/.local/share/dinobot/vendor/answer-me-with-html/am.mjs" render - --no-open
```

with the Markdown draft on stdin. Pages are written to `~/.answer-me-with-html/pages/`
(override with `AM_HOME`). The bot always passes `--no-open` because it runs headless.

Upstream `${CLAUDE_SKILL_DIR}` variable substitution does not apply here; use the absolute
installed path above. The upstream `config` / `clean` / `update` subcommands are not used by
the harness skill workflow.

## Language notes

The CLI auto-detects English, Chinese and Japanese drafts (content, labels, `<html lang>`).
Other languages (e.g. Korean) render correctly as content but are misdetected as Chinese;
write `lang: en` in the draft frontmatter for those languages so UI chrome and `<html lang>`
stay English instead of wrongly Chinese.

## Updating

Replace the files here from a newer upstream release, update the commit hash and version in
this notice, and run `bun run reinstall`.
