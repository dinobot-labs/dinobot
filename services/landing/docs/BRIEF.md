# Dinobot product introduction

## 1. Direction

**Reject the previous DOS hero.** This is a product introduction, not a DOS theme showcase. The old “An agent for what’s next” headline, blue/black switcher and three-file bash listing do not explain who Dinobot is for or what work it can do. Do not re-skin that composition. DOS is omitted by default; at most a small optional theme detail near the footer, never the hero, workflow or defining product identity. Old DOS-first recommendations in the reference survey and product-page.md are historical, not binding.

Target: people working with project files and commands, and teams that want to send configured chat requests to the agent. Success: a new visitor can explain the task, model/tool relationship, Desktop/TUI/chat roles, setup requirements and next installation step without reading a source repository.

Authority: canonical core source `fec7909`, branch `feat/product-introduction`; factual basis in product-facts.md. This brief delivers documentation only. It does not certify a product run, new screenshot, download availability or deployment.

## 2. Hero copy — proposed direction

### English

Eyebrow: **AI for project work**

Headline: **Work on your files with AI.**

Body: **Use your AI model to read and edit project files and run commands from Desktop or the terminal. Connect Slack, Discord or Telegram when your team needs a chat entry point.**

Setup note: **Your model account is required. Chat channels and optional tools need configuration.**

Primary CTA: **Get Dinobot** → install section.
Secondary CTA: **See a workflow** → real workflow section.

### 한국어

Eyebrow: **프로젝트 작업을 위한 AI**

Headline: **AI와 함께 프로젝트 파일을 읽고 수정하고, 명령어를 실행하세요.**

Body: **데스크톱이나 터미널에서 선택한 AI 모델로 프로젝트 파일을 읽고 수정하고, 명령어를 실행하세요. 팀 채팅에서 요청하려면 Slack, Discord, Telegram을 연결할 수 있어요.**

Setup note: **모델 계정이 필요하며, 채팅 채널과 추가 도구는 별도 설정이 필요합니다.**

Primary CTA: **Dinobot 시작하기** → 설치 영역.
Secondary CTA: **작업 흐름 보기** → 실제 작업 흐름 영역.

Headline line breaks follow actual EN/KO widths; never force the old two-line shape. Body carries the concrete capability; keep it visible, not behind a carousel or tooltip. Desktop is capitalized as the product client, not a promise that every desktop app is automatically controllable.

## 3. Information architecture

### Value
Short audience/capability copy above, one real default-theme product view. The visitor should see a recognizable request and relevant tool detail, not a theme picker. At 1440×900, show meaningful product content in the first viewport. At 390px, stack copy and image without truncating capability or setup copy. Prefer one image over overlapping tiny windows. If the capture is unavailable, show an honest example-request block; do not simulate success.

### Real workflow
Title EN: **From a project folder to a getting-started guide**
Title KO: **프로젝트 폴더에서 시작 안내까지**

Example request EN: “Read the README, write GETTING_STARTED.md, run node --check app.js, and show me the output.”
Example request KO: “README를 읽고 GETTING_STARTED.md를 작성한 뒤, node --check app.js를 실행하고 결과를 보여 줘.”
These are explanatory examples, not verbatim transcript quotes. The captured scripted model dispatched actual bash; only JavaScript syntax was checked.

Sequence: inspect actual project files → edit a guide → run an available check → review changed file and actual command result. Use one synthetic fixture so each image describes the same task. The section needs a visible input, action and observable artifact; not merely a list of plugins. A failed check remains failed. These words specify a candidate workflow, not a completed run. Publish success only after actual evidence; a mock-provider run must carry a nearby “scripted app demo” disclosure and cannot imply general model reliability.

### Features: problem → action → effect
Use three large editorial rows with specific detail, not a wall of cards.

| Problem | Action | Effect a visitor can inspect |
|---|---|---|
| Moving between chat advice and project files | Read/write/edit and command tools | A changed file plus command output, rather than only suggested prose |
| A model is disconnected from the working setup | Sign in, select an available model, configure needed integrations | A selected model and available tools for that setup; no included usage promise |
| Team requests live in chat | Configure Slack, Discord or Telegram credentials and access | Requests and responses in the configured channel; not automatic thread handoff |

EN headings: **Work with files and commands** / **Choose your model and tools** / **Bring requests from team chat**.
KO headings: **파일과 명령어 작업** / **모델과 도구 선택** / **팀 채팅의 작업 요청**.

Each row gets a short explanation and one source-grounded example. Optional browser/computer/MCP integrations appear with setup labels, never as unconditional default capability.

### Desktop, TUI and chat roles
Explain the relationship, not three competing product promises:
- Desktop: dedicated graphical client; separate download; compatible daemon required.
- TUI: terminal interface to the local agent daemon; good entry point for people already working in a terminal.
- Chat: configured Slack/Discord/Telegram adapters for permitted users/destinations; not a hosted shared SaaS workspace.

One quiet, accessible diagram may show the interfaces connected to the daemon, then to selected model and tools. Label external providers separately. Do not animate a message magically transferring between interfaces unless tested. Local daemon survival after TUI closes is a lifecycle fact, not a guarantee of task completion.

### Models, tools and configuration boundaries
Keep these adjacent to the benefits, not only buried in legal text:
- `/login` connects a provider; `/model` selects an available model. Credentials and provider usage are the user’s responsibility.
- File/command tools are core; integrations have their own setup/dependencies/accounts. MCP is a tool connection mechanism, not a model provider.
- Channels need credentials and access configuration.
- Local does not mean private or isolated: external services may receive data. The HTTP API is unauthenticated; keep it on loopback/trusted accounts. Link SECURITY.md.
- Source available under PolyForm Noncommercial 1.0.0, not OSI-approved open source. Commercial permission is separate.

### Install
Retain separate Desktop and CLI/TUI choices, current fixed version/architecture destinations and existing EN/KO caveats. Show OS selector and exact shell command only here, not as the hero explanation. Keep selectable commands/no-JS access, copy pending/success/manual-failure states, stale-copy handling, unsigned Windows disclosure, Bun >=1.4.2 prerequisite, manual PATH guidance, old-global-install precedence and managed-launcher/next-natural-daemon-start boundaries. Never turn a successful copy into “installed.”

Finish with a short FAQ and source/license/privacy links. No waitlist form, invented customer badges, fake counters, provider price promises or OS support extrapolation.

## 4. Visual system and references

Use the fresh required-reference synthesis in reference-brief.md as the primary source. The following older survey notes are historical context only, not a substitute for the new Factory/Claude/Codex investigation.
- Cursor: compact explanation, aligned CTA, large immediate actual product. Borrow hierarchy, not scenery or DOS-first interpretation.
- Claude Code: task-led description beside a useful product view. Keep one nav row and avoid screenshot occlusion.
- Linear: strong shared left edge and typography. Reject dark/dim entrance hiding product content.
- Notion: restrained brand personality around product. Reject giant word-pill imitation, logo strips and long headline delay.
- Brand survey: dinosaur as identity, not page metaphor. No simulated desktop website.

Starting direction: light neutral page, dark readable text, one consistent accent from existing brand assets. Existing licensed Geist/Geist Mono/Korean font pipeline stays unless independently reviewed. Body >=16px (hero 18–20px); captions >=15px. Use 1200–1280px content width with generous but non-wasteful gutters, restrained 1px rules, little elevation. Product UI keeps its native light/dark appearance. A light marketing page is not proof the product supports a light theme.

No default card-grid UI, status-score chips, oversized dinosaur, gratuitous background gradients, full-page mono typography or “agentic” slogans. Keep source hashes, capture IDs, QA counters and orchestrator details out of public copy; operational provenance belongs in docs.

## 5. Asset acceptance and capture candidates

See product-facts.md for provenance fields. No product assets were created by this node.
1. Primary candidate: real Desktop default light task view, if the actual isolated build supports it.
2. Secondary candidate: real Desktop default dark, same task/stage.
3. Terminal candidate: TUI default Signal/rex dark surface from this pin.
4. TUI light: unestablished; do not invent/recolor it.
5. DOS: omit; optional tiny bottom theme detail only, with original mock-provider disclosure.

Capture owner must record version/theme/profile/workspace/provider/task/tool execution and original-image provenance before accepting an image. Use separately owned disposable instances and synthetic data only; never change the user’s applications, theme settings or daemon. Screenshots are not to be recreated as HTML transcripts. No fake output, success label or baked-in benchmark. If a genuine flow cannot be obtained, clearly label the request as an example and retain the evidence limitation.

## 6. Implementation boundaries

- This node owns only `services/landing/docs/product-facts.md` and `services/landing/docs/BRIEF.md`; no commit required.
- Page owner owns locale copy/templates/client/CSS and must preserve current install copy semantics and protected behavior. Asset owner supplies provenance-backed captures. Integration owner reviews claims and final rendering.
- Existing generation/layout entry points: `src/content/en.ts`, `ko.ts`, `src/pages/home.html`, partials, `src/client/main.ts`, `src/client/app/product.ts`, `src/client/styles/product.css`, `vite/pages.ts`. Reuse these; no parallel page framework.
- No API/schema/D1/telemetry changes. Preserve `/api/waitlist` retirement, strict CSP, static-first routing, locale cookie/query/hash behavior, privacy body semantics and security docs contract. No release endpoint migration.
- QA hooks should identify value, workflow, features, interfaces, configuration and install sections semantically. Avoid tests that merely count files or match CSS/source strings.

## 7. Motion, interaction and acceptance

Essential copy and product evidence are present on frame one. Motion is optional transform/opacity only; pause offscreen/hidden work and honor reduced motion. Theme comparison, if retained, is secondary and keyboard-operable; no auto-rotation. Focus states, image failure/original link, copy failure, pending and stale updates stay visible and honest.

Integration acceptance (not executed by this documentation node):
1. EN and KO visitors can name one concrete task, tool actions, output and model/config requirements. No DOS hero or vague-only headline.
2. Every published task result has a real capture receipt; mock activity is conspicuously labeled. Product/theme/version assertions match that capture.
3. Desktop/mobile/320px and 200% text zoom: no horizontal document overflow, crop hiding essential task content or overlapping controls. Keyboard navigation, reduced motion and no-JS commands work.
4. Actual installer clipboard checks preserve exact bytes; manual fallback, late completion and rapid OS changes are exercised. Existing security/locale regressions are checked.
5. Source/license/security/install EN/KO caveats remain accurate. No secrets, private sessions, reports or unapproved assets in public output.
6. Independent visual review checks the actual page against this brief; performance/accessibility measurements are reported as measured, not inherited from the old survey.

## Creative director notes

1. The reference reports remain useful for hierarchy, but all old instructions to put DOS in the hero are superseded.
2. The exact source has no `src/core/tools` directory; core tools are registered from pi-durable in `src/core/bot.ts`. Do not manufacture a source citation.
3. New owner-supplied real default light/dark captures are at `../dinobot/reports/product-introduction-capture (local, unpublished evidence)`. This supersedes the earlier candidate-only status for those specific captured scenes, not a general theme claim from the core checkout. The synthesis node did not rerun or independently accept these captures. TUI default remains Signal/rex on dark surfaces; do not infer TUI light support. Verify app/version/theme/profile receipts before publication.
4. Required-reference synthesis and parent-review entry: `reference-brief.md`. Factory and Claude product screenshots were directly reopened; Codex product access showed Cloudflare, so Codex recommendations are documentation-only. Factory late-page copy/visual coverage is incomplete. These are new required-reference findings, not a relabeling of the historical 21-reference survey.
5. Explanation priority: definition → concrete task → feature evidence → readable real UI → installation. Real UI already supports the hero/task; do not hide it in a late gallery. Keep section 2’s explicit file/command/model definition, primary Get Dinobot CTA and secondary workflow CTA. Borrow Claude’s recognizable request/tool trace, Factory’s inspectable work state, and Codex documentation’s action/location definition and install→sign-in→first-task ladder—not colors, slogans or unsupported feature parity.
6. The actual owner-supplied capture workflow is **read README → write GETTING_STARTED.md → run `node --check app.js` → read output**. This replaces the candidate workflow wording in section 3 and product-facts.md for the captured demo. Do not say package scripts were read. Do not call the syntax check a full test suite, functional test, app execution or correctness guarantee. The model is mocked/scripted; bash execution is actual.
7. Proposed public example wording (not a verbatim transcript): EN “Read the README, write GETTING_STARTED.md, run node --check app.js, and show me the output.” KO “README를 읽고 GETTING_STARTED.md를 작성한 뒤, node --check app.js를 실행하고 결과를 보여 줘.” Match final visible input to the actual capture receipt. Nearby disclosure: “Scripted app demo: mocked model, real file and command tools. Syntax check only.” / “시나리오 기반 앱 시연: 모델 응답은 모의 구성, 파일·명령 도구는 실제 실행. 구문 검사만 수행.” No live-model reliability implication.
8. Feature rows must point to a genuine artifact or a source-backed setup example. Desktop/TUI/chat are different entry roles, not automatic conversation transfer. Keep provider credentials, optional tool setup, exact existing install destinations/commands, license and privacy boundaries intact. Do not import Factory enterprise badges, Claude permission absolutes, or Codex cloud/IDE claims.
9. Fresh reference/message review passed (dag-cee992f70d2a); independent native-capture review passed for captioned image use (dag-867879204edd). Rendered-page acceptance is pending. Review source screenshots, owner capture provenance and exact task evidence before implementation/public acceptance; review the rendered EN/KO page afterward. This documentation update changes no implementation and does not certify installation, general model performance or full reference coverage. Earlier candidate-only statements remain historical where these numbered notes explicitly supersede them.
