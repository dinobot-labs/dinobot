# Product facts — introduction redesign

## Evidence boundary

Canonical source inspected: `dinobot-labs/dinobot`, checkout `fec7909`, branch `feat/product-introduction`. These are source-backed capabilities, not a live model run, install check or deployment certification. Only this docs directory was written. No user applications, configuration or daemon were touched.

The requested `src/core/tools` directory does not exist at this pin. Actual registration is `src/core/bot.ts:209`: `CodingTools` from `@earendil-works/pi-durable/tools`, with local image and bash wrappers. `package.json` pins pi-durable 1.0.2 plus the tracked patch. Dependencies were installed with frozen locks by integration after this source review; this fact sheet does not independently certify upstream tool implementation behavior. `src/extensions/task-profile.ts` and `test/bot.test.ts:165` corroborate read/write/edit/bash exposure. Tests were read, not run. Do not cite an invented `src/core/tools` path.

## Capabilities and copy

### Files and commands
- Strength: the agent has file read/write/edit and shell-command tools.
- Why it matters: a request can lead to changes in project files, not only a proposed answer to copy elsewhere. Commands can inspect a project or run its checks when the environment supplies them.
- Evidence: `src/core/bot.ts:209–211`, `src/extensions/task-profile.ts:34–37`, `src/extensions/bash-budget.ts`, `src/extensions/images.ts`, `test/bot.test.ts:165`. Bash has bounded execution, not unlimited runtime.
- EN: “Read project files, make edits, and run commands with your AI model.”
- KO: “AI 모델과 프로젝트 파일을 읽고 수정하고, 명령어를 실행하세요.”
- Storyboard: request → read README/package manifest → edit a small document → run an available check → inspect actual result. This is a proposed sequence, not evidence it happened.
- Avoid: guaranteed fixes, automatic correctness, invented green tests, arbitrary files as a safe sandbox.

### Models and login
- Strength: connect provider credentials with `/login`; choose an available `provider/modelId` with `/model`.
- Why it matters: model choice is separate from the interface used to request work.
- Evidence: `src/commands/builtin.ts:54–100,245–345`; unknown or unavailable model selection throws; login-only providers are distinguished from model transports.
- EN: “Connect your provider. Choose an available model.”
- KO: “사용할 제공업체에 로그인하고, 이용 가능한 모델을 고르세요.”
- Storyboard: provider login entry → available model list → selection → actual selected-model label. Do not show credentials.
- Avoid: every provider supported, login automatically means chat transport, model usage included, unlimited usage, universal subscription compatibility.

### Configured team chat
- Strength: Slack, Discord, Telegram and local HTTP adapters are in the channel catalog.
- Why it matters: configured team members can send requests in a supported chat surface rather than opening the local interface for every request.
- Evidence: `src/channels/index.ts`; `slack.ts` credential checks and allowed users/channels; `discord.ts` allowed users/destinations; `telegram.ts` credentials, pairing/allowlists and polling/webhook paths.
- EN: “Connect Slack, Discord or Telegram with your channel credentials and access settings.”
- KO: “채널 인증 정보와 접근 설정을 준비해 Slack, Discord, Telegram을 연결하세요.”
- Storyboard: configure adapter → authorized person sends request → actual tool progress if supported → actual reply in that thread. Requires a separately authorized test workspace; no fabricated Slack screenshots.
- Avoid: automatic connection, all users admitted, Teams support, identical UI on every adapter, automatic cross-surface conversation handoff.

### Optional tools
- Strength: catalog includes MCP, browser, computer, web and additional integrations.
- Why it matters: connect tools needed by the task rather than claiming every installation already has every service.
- Evidence: `src/plugins/index.ts`; `mcp/index.ts` creates stdio/HTTP transports and discovers tools; `computer/index.ts` uses cua-driver and defaults channel access to TUI; `browser/index.ts` gates channel use before spawning; `web/index.ts` credential-free search with engine fallback, default on.
- EN: “Add MCP, browser and desktop tools as your setup requires.”
- KO: “작업에 맞게 MCP, 브라우저, 데스크톱 도구를 설정하세요.”
- Storyboard: choose integration → supply required setup → discover available tool → execute authorized task → inspect its result.
- Avoid: all plugins preconfigured, error-free web access, free external services, browser use as an unqualified default, tool discovery as successful execution.

### Interfaces
- Desktop: separate Electron/React client requiring a compatible daemon. This repo is not Desktop source. Evidence: README “Choose your interface”.
- TUI: local terminal client; starts a daemon if needed. Closing TUI does not stop the daemon. Evidence: README install/run.
- Chat: configured adapters to the agent, not a third download or a hosted subscription service.
- EN: “Desktop for a dedicated window. TUI for terminal work. Configured chat for team requests.”
- KO: “전용 창에서는 Desktop, 터미널에서는 TUI, 팀 요청은 설정한 채팅 채널에서.”
- Storyboard: one actual Desktop scene → actual default TUI scene → text description of configured chat. Separate examples unless shared-thread continuity is proven.

## Representative workflow

Example request, not a recorded result:
- EN: “Read this project’s README and package scripts. Add a short getting-started guide, then run the relevant check and tell me what happened.”
- KO: “이 프로젝트의 README와 실행 스크립트를 읽고, 짧은 시작 안내를 작성해 줘. 관련 검사를 실행하고 결과도 알려 줘.”

Visible sequence: request → file inspection → document edit → real command result → changed file for review. Use a synthetic, non-sensitive fixture with a documented check. Keep failed, skipped and unavailable checks truthful. Until a capture owner runs it, label this as an example request; do not render a fabricated transcript or success output.

## Safety, licensing and installation invariants

- `README.md`, `README.ko.md`, `SECURITY.md`, `LICENSE`: local execution is not isolation. HTTP API is unauthenticated, for loopback/trusted local accounts, not Internet exposure or hostile multi-user use. External models and integrations may send data to third parties.
- PolyForm Noncommercial 1.0.0: source-available, not OSI-approved open source. Commercial use needs separate written permission. No free-for-all commercial claim.
- Preserve existing EN/KO privacy bodies, locale behavior, strict CSP and retired-waitlist behavior. Existing docs/security.md is a historical local receipt, not a fresh deployed-state assertion.
- Preserve exact CLI command bytes: `curl -fsS https://releases.dinobot.workers.dev/install.sh | sh` and `irm https://releases.dinobot.workers.dev/install.ps1 | iex`.
- CLI prerequisite: already-installed Bun >=1.4.2. Desktop is separate. Printed launcher path/manual PATH; old global installation may take precedence. Launcher updates on launch; running daemon switches only on its next natural startup through the launcher. Closing TUI is not a daemon restart.
- Existing landing EN/KO source lists Windows x64 Desktop 0.1.5 unsigned, macOS Apple Silicon/Intel 0.1.4, no Linux Desktop download. Preserve these versioned destinations and disclaimers; their current public availability was not checked here.
- Clipboard success means copied command only, never installed successfully. Keep pending/error/manual fallback and stale-selection protection.

## FAQ copy basis

1. What does it do? Uses your selected model with file and command tools; optional integrations extend it.
2. Do I need an account? Yes, your own model-provider credentials; no included unlimited usage.
3. Is Desktop the CLI download? No; Desktop is a separate client with a compatible daemon requirement.
4. Is chat ready immediately? No; adapter credentials/access configuration are required.
5. Does everything stay local? No; external models and tools can transmit data. Keep the unauthenticated local API on loopback.
6. Is it open source? Source available under PolyForm Noncommercial 1.0.0, not OSI-approved open source.

## Capture candidates and provenance

This initial source review did not capture the product. Integration later supplied native Desktop 0.1.5 Light/Dark captures, independently accepted for public screenshot use with scripted-local-model and syntax-only captions. The exact accepted workflow is README read → GETTING_STARTED.md write → node --check app.js → guide readback, using actual daemon bash. No package manifest/scripts or full tests were exercised. Raw capture receipts and scripts remain private. The table below records original candidate requirements, not additional accepted assets:

| Candidate | Purpose | Required verification |
|---|---|---|
| Desktop default light, real task conversation | Primary hero on a light page | Inspect actual Desktop version/theme support in a disposable profile, record native window and task provenance |
| Desktop default dark, same task and stage | Secondary view or features detail | Same app/version/task; use native theme, never recolor pixels to invent it |
| TUI Signal / rex, default dark surfaces | Terminal role | `src/tui/theme.ts` initializes rex; capture a disposable instance only |
| TUI light | Optional only | Not established: canonical theme source has dark Signal surfaces and no named light theme; do not invent one |
| DOS blue/black | Optional tiny footer detail, preferably omitted | Existing scripted/mock-provider assets must keep that disclosure; never primary evidence |

For each published asset record: source repo and commit/build, app version, native theme, isolated profile/workspace, fixture identity, exact prompt, provider type (real vs scripted/mock), tool execution evidence, dimensions, original path, crop rectangle if any, capture date, SHA-256 and permission/license. Put operational receipts outside public assets. Original imagery must contain only intentionally authored synthetic data; do not touch the user’s windows/settings/daemon to create it. If no authentic capture exists, use a clearly labeled example request, not fabricated UI.

## Existing reference survey

Reviewed the four historical analysis files in the prior landing worktree’s `reports/landing-research/{product,brand,agents,supplement}`; reopened Cursor, Claude Code, Linear and Notion screenshots. Historical survey reports 21 usable references, excluding Codex/Replit blocked pages; it is desktop first-fold evidence, not fresh liveness, mobile or performance evidence. Old DOS-first recommendations are explicitly superseded by BRIEF.md. Borrow hierarchy and staging only, not third-party assets/fonts/logos or their product claims.
