<p align="center">
  <img src=".github/assets/logo.svg" alt="Dinobot 로고" width="160">
</p>

# Dinobot

**Dinobot의 에이전트 데몬과 터미널 인터페이스.**

터미널에서 에이전트와 작업하고, 팀 채팅을 연결하고, 필요한 도구를 추가하세요. Dinobot은 TypeScript와 Bun으로 만들어졌습니다. 데몬이 에이전트를 실행하고, 터미널 사용자 인터페이스(TUI)가 로컬에서 데몬에 연결됩니다.

[English](README.md) · [한국어](README.ko.md) · [简体中文](README.zh-CN.md)

소스 공개 · [PolyForm Noncommercial 1.0.0](LICENSE) · OSI 승인 오픈소스가 아닙니다

## 데모

https://github.com/user-attachments/assets/6b7d112e-d469-4512-b97b-96999dcf8936

## 인터페이스 선택

- **Dinobot — 이 저장소:** 에이전트 데몬과 TUI입니다. 본체를 실행하거나 터미널에서 작업하려면 여기서 시작하세요.
- **Dinobot Desktop:** 호환되는 Dinobot 데몬이 필요한 Electron/React 데스크톱 클라이언트입니다.
  https://github.com/dinobot-labs/dinobot-desktop

## 할 수 있는 일

| 기능 | 사용 방법 |
| --- | --- |
| 터미널에서 작업 | TUI를 열고 `/login`으로 모델 제공자에 로그인한 뒤 `/model`로 모델을 선택합니다. |
| 채팅 채널 연결 | 설정 파일에서 Slack, Discord, Telegram 또는 로컬 HTTP 채널을 구성합니다. 메시징 어댑터에는 별도의 자격 증명과 접근 설정이 필요합니다. |
| 도구 추가 | MCP 서버, 브라우저·데스크톱 자동화 등의 플러그인을 설정합니다. 일부 기능에는 외부 프로그램이나 서비스 계정이 필요합니다. |

설정 예시는 [dinobot.example.yaml](dinobot.example.yaml)을 참고하세요. 플러그인을 켜는 것만으로 자격 증명이나 의존 프로그램이 준비되지는 않습니다.

## 설치와 실행

**Bun 1.4.2 이상**과 본인의 모델 제공자 자격 증명이 필요합니다. Cloudflare에서 정식 CLI/TUI 패키지를 설치하세요.

```bash
bun add -g dinobot@https://releases.dinobot.workers.dev/core/dinobot.tgz
dinobot
```

이후에는 `dinobot update`로 업데이트합니다. 데몬을 계속 실행하려면 `dinobot update --no-restart`를 사용하세요. 예전 npm 배포본 사용자는 위 URL 설치를 한 번 실행해야 새 업데이트 경로로 전환됩니다. Dinobot 발행에 npm 계정은 필요 없지만 외부 라이브러리는 npm에서 내려받습니다. Desktop 설치는 별도입니다.

소스에서 실행하려면 Git도 필요합니다.

```bash
git clone https://github.com/dinobot-labs/dinobot.git
cd dinobot
bun install --frozen-lockfile
bun src/main.ts --help
bun src/main.ts tui
```

TUI에서 `/login`으로 모델 제공자에 로그인하고 `/model`로 모델을 선택하세요. 실행 중인 데몬이 없으면 TUI가 백그라운드 데몬을 시작합니다. TUI를 닫아도 데몬은 계속 실행됩니다.

설정을 바꾸려면 [dinobot.example.yaml](dinobot.example.yaml)을 참고해 `dinobot.yaml`을 작성한 뒤 실행하세요.

```bash
bun src/main.ts tui --config dinobot.yaml
```

자격 증명은 설정 파일에 넣지 마세요. TUI 대신 포그라운드 데몬을 실행하려면 `bun src/main.ts serve --config dinobot.yaml`을 사용하세요.

**로컬 실행이 격리를 뜻하지는 않습니다.** HTTP API에는 인증이 없으며 다중 사용자를 위한 보안 경계가 아닙니다. 신뢰할 수 있는 로컬 컴퓨터·계정에서 루프백으로만 사용하고, 인터넷·신뢰할 수 없는 네트워크·공개 프록시에 노출하지 마세요. 모델 제공자와 활성화한 연동 기능은 외부 서비스로 데이터를 보낼 수 있습니다. 도구나 채널을 연결하기 전에 [SECURITY.md](SECURITY.md)를 읽어주세요.

모델 자격 증명과 외부 서비스는 포함되지 않습니다. 텔레메트리·리포트 및 OAuth 백엔드 운영은 이 소스 스냅샷 범위 밖이며, 소스 공개가 해당 백엔드 접근을 보장하지는 않습니다.

## 개발과 기여

```bash
bun run typecheck
bun test
bun run build
bun script/public-artifact-guard.ts
```

`bun run build`는 현재 호스트용 실행 파일과 네이티브 애드온을 준비합니다. `bun run release`는 로컬 npm 아카이브를 만들고 검사하며, 게시하지는 않습니다. 소스 빌드만으로 설치 가능한 릴리스가 만들어지지는 않습니다. 플랫폼별 테스트 요건은 개발 가이드를 참고하고, 운영 데이터나 실제 자격 증명으로 테스트하지 마세요.

- [개발 가이드](docs/wiki/Development.md) — 검사 명령과 실행 환경 요건.
- [기여 안내](CONTRIBUTING.md) — 이슈, PR, 기여자의 권리.
- [프로젝트 위키](docs/wiki) — 개발 및 릴리스 안내.
- [소스 스냅샷](PUBLIC_SNAPSHOT.md) — 공개 범위와 릴리스 상세.

이 저장소는 공개용으로 선별한 소스 스냅샷이며, 원래 개발 이력 전체를 담고 있지는 않습니다.

## 라이선스

[PolyForm Noncommercial 1.0.0](LICENSE)이 허용하는 비상업적 사용은 무료입니다. **소스가 공개되어 있지만 OSI 승인 오픈소스는 아닙니다.** 상업적 사용에는 관련 권리자의 별도 서면 허가가 필요합니다. 라이선스 문의: dev0jsh@gmail.com.

제3자 코드는 원래 라이선스를 유지합니다. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 참고하세요.
