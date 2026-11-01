/** Product copy; historical privacy semantics preserved. */
import type { Content } from "./en.ts";
export const ko = {
  "meta": {
    "title": "Dinobot — AI와 파일·명령어 작업",
    "description": "데스크톱이나 터미널에서 선택한 AI 모델로 프로젝트 파일을 읽고 수정하고, 명령어를 실행하세요. 팀 채팅에서 요청하려면 Slack, Discord, Telegram을 연결할 수 있어요.",
    "ogLocale": "ko_KR",
    "ogLocaleAlt": "en_US",
    "ogImage": "/brand/og-ko.png",
    "ogImageAlt": "Dinobot — 데스크톱과 터미널 에이전트",
    "isKo": true
  },
  "a11y": {
    "skip": "본문으로 건너뛰기",
    "language": "언어",
    "mainNav": "주 메뉴",
    "home": "Dinobot 홈",
    "footerNav": "하단 메뉴"
  },
  "nav": {
    "home": "/ko/",
    "product": "제품",
    "install": "설치",
    "faq": "자주 묻는 질문",
    "cta": "설치"
  },
  "hero": {
    "eyebrow": "프로젝트 작업을 위한 AI",
    "title": "AI와 파일을 읽고 수정하고, 명령어를 실행하세요.",
    "body": "데스크톱이나 터미널에서 선택한 AI 모델로 프로젝트 파일을 읽고 수정하고, 명령어를 실행하세요. 팀 채팅에서 요청하려면 Slack, Discord, Telegram을 연결할 수 있어요.",
    "setup": "모델 계정이 필요하며, 채팅 채널과 추가 도구는 별도 설정이 필요합니다.",
    "primary": "Dinobot 시작하기",
    "secondary": "작업 흐름 보기",
    "open": "원본 이미지 보기",
    "caption": "시나리오 기반 앱 시연: 로컬 모의 모델을 사용했고, 파일·명령 도구는 실제 실행했습니다. JavaScript 구문 검사만 수행했으며 전체 테스트는 아닙니다.",
    "alt": "기본 라이트 테마의 Dinobot Desktop. README 요청, 실제 bash 실행과 새로 작성한 시작 안내가 보입니다.",
    "detailAlt": "README 내용과 node --check app.js 이후 출력한 GETTING_STARTED.md 안내가 보이는 실제 bash 실행 결과.",
    "unavailable": "이미지를 불러오지 못했습니다. 원본 이미지 링크를 이용해 주세요.",
    "imageHint": "실제 Desktop 화면 · README에서 시작 안내까지",
    "mobileHint": "이미지를 가로로 스크롤하거나 원본을 열어 전체 명령을 읽을 수 있어요."
  },
  "interfaces": {
    "eyebrow": "Desktop · 터미널 · 채팅",
    "title": "에이전트를 만나는 여러 방법",
    "desktop": "별도로 다운로드하는 전용 그래픽 클라이언트입니다. 호환되는 Dinobot 데몬이 필요합니다.",
    "cli": "로컬 에이전트 데몬에 연결하는 터미널 인터페이스입니다. TUI를 닫아도 데몬은 종료되지 않습니다.",
    "chat": "설정한 채팅",
    "chatBody": "허용된 사용자와 채널을 위한 Slack, Discord, Telegram 연결입니다. 호스팅된 공동 작업 서비스는 아닙니다.",
    "privacy": "각각 에이전트에 요청하는 진입점이며, 인터페이스 사이에서 대화가 자동 이동한다는 뜻은 아닙니다.",
    "daemon": "로컬 에이전트 데몬",
    "model": "선택한 외부 모델 제공업체",
    "tools": "파일·명령 및 설정한 도구",
    "diagramLabel": "Desktop, TUI와 설정한 채팅은 로컬 에이전트 데몬에 연결됩니다. 데몬은 선택한 외부 모델 제공업체와 사용 가능한 도구를 이용합니다."
  },
  "install": {
    "title": "Dinobot 시작하기.",
    "installer": "설치 파일 받기",
    "zip": "ZIP 받기",
    "unsigned": "Windows 설치 파일과 앱은 코드 서명이 없습니다.",
    "checksums": "체크섬",
    "linux": "Linux에서는 CLI/TUI를 사용하세요. 제공되는 Linux Desktop 다운로드는 없습니다.",
    "cliTitle": "CLI / TUI 설치.",
    "requires": "Bun 1.4.2 이상이 먼저 설치되어 있어야 합니다. 아래 명령은 Bun을 설치하지 않습니다.",
    "os": "설치할 운영체제",
    "copy": "명령 복사",
    "pending": "복사 중…",
    "copied": "복사됨",
    "success": "명령을 복사했습니다.",
    "manual": "자동 복사가 되지 않습니다. 명령을 선택해 복사하세요.",
    "path": "설치기가 출력한 실행 경로를 사용하거나 bin 디렉터리를 PATH에 직접 추가하세요. PATH는 자동으로 바뀌지 않으며, 기존 전역 설치가 먼저 실행될 수 있습니다.",
    "details": "실행 경로와 업데이트",
    "updates": "기본 실행 경로는 Windows의 LOCALAPPDATA/dinobot/bin/dinobot.cmd, macOS·Linux의 ~/.local/bin/dinobot입니다. DINOBOT_INSTALL_DIR를 지정하면 위치가 달라집니다. 관리형 실행기는 실행할 때마다 업데이트를 확인합니다. 실행 중인 데몬은 다음에 해당 실행기를 통해 새로 시작할 때 버전이 바뀝니다. TUI만 닫아서는 데몬이 재시작되지 않으며, 기존 전역 설치도 자동 이전되지 않습니다."
  },
  "faq": {
    "title": "시작하기 전에.",
    "rows": [
      {
        "q": "모델 계정이 필요한가요?",
        "a": "네. 사용자의 모델 제공업체 계정으로 로그인하고 모델을 선택하세요. 다운로드에 무제한 모델 사용이 포함되지는 않습니다."
      },
      {
        "q": "Desktop과 CLI는 같은 다운로드인가요?",
        "a": "아니요. Desktop은 별도 클라이언트입니다. CLI 설치기는 Desktop이 아니라 코어 데몬과 터미널 인터페이스를 설치합니다."
      },
      {
        "q": "어떤 운영체제를 지원하나요?",
        "a": "Desktop은 서명 없는 Windows x64 0.1.5와 macOS Apple Silicon·Intel 0.1.4 다운로드를 제공합니다. Linux Desktop 다운로드는 없습니다. CLI/TUI는 Bun 1.4.2 이상이 설치된 Windows, macOS, Linux에서 사용할 수 있습니다."
      },
      {
        "q": "관리형 업데이트는 언제 적용되나요?",
        "a": "관리형 실행기는 실행 시 업데이트를 확인합니다. 실행 중인 데몬은 다음에 해당 실행기를 통해 새로 시작할 때까지 현재 파일을 사용합니다. TUI만 닫아서는 재시작되지 않습니다. 기존 전역 설치는 이 실행기로 자동 이전되거나 업데이트되지 않습니다."
      },
      {
        "q": "Dinobot은 오픈 소스인가요?",
        "a": "소스는 PolyForm Noncommercial 1.0.0으로 공개되어 있습니다. OSI 승인 오픈 소스 라이선스나 제한 없는 상업적 이용 허가는 아닙니다."
      },
      {
        "q": "모든 데이터가 내 기기에만 남나요?",
        "a": "아니요. Dinobot은 기기에서 실행되지만 외부 모델 요청은 선택한 제공업체로 전송됩니다. 연결한 채널과 도구도 외부 서비스와 통신할 수 있습니다. 사용하는 서비스의 정책을 확인하세요."
      }
    ]
  },
  "footer": {
    "core": "코어 소스",
    "desktop": "Desktop 소스",
    "privacy": "개인정보 처리방침",
    "privacyHref": "/ko/privacy/",
    "license": "소스 공개 · PolyForm Noncommercial",
    "legal": "©2026 Dinobot",
    "tagline": "AI와 파일을 읽고 수정하고, 명령어를 실행하세요."
  },
  "privacy": {
    "title": "개인정보 처리방침 · dinobot 대기자 명단",
    "description": "dinobot 대기자 명단이 이메일 주소를 수집하고 이용하고 보관하는 방법입니다.",
    "eyebrow": "개인정보",
    "h1": "대기자 명단 개인정보 처리방침",
    "lede": "이 방침은 이 사이트의 이메일 대기자 명단에만 적용됩니다. 무엇을 왜 수집하는지, 어디에 보관하는지, 어떻게 삭제를 요청하는지 설명합니다.",
    "effectiveLabel": "시행일",
    "effective": "2026-10-11",
    "back": "홈으로 돌아가기",
    "sections": [
      {
        "title": "개인정보 처리자",
        "html": "대기자 명단은 정승현이 운영하며, 이 정보의 이용 방법을 결정합니다. 연락처: <a href=\"mailto:dev0jsh@gmail.com\">dev0jsh@gmail.com</a>"
      },
      {
        "title": "수집하는 항목",
        "html": "이메일 주소, 등록한 페이지의 언어, 등록 시각, 사용한 신청 양식(선택), 동의한 안내문의 버전입니다. IP 주소나 브라우저 정보는 등록 정보와 함께 저장하지 않습니다."
      },
      {
        "title": "수집·이용 목적",
        "html": "대기자 안내와 얼리 액세스가 열릴 때의 초대 메일 발송에만 씁니다. 광고나 프로파일링에는 쓰지 않습니다."
      },
      {
        "title": "보유 기간",
        "html": "출시 후 1년이 지나거나 동의를 철회할 때 중 먼저 오는 시점까지 보관하고, 그 뒤 삭제합니다."
      },
      {
        "title": "보관 장소와 국외 이전",
        "html": "Cloudflare, Inc.(미국)가 운영하는 Cloudflare D1 데이터베이스에 아시아·태평양 위치 힌트로 보관합니다. 즉, 이메일은 국외 서버로 이전되어 보관됩니다. 양식을 제출할 때 암호화된 연결로 전송되며, 위 보유 기간 동안 보관됩니다."
      },
      {
        "title": "제3자 제공",
        "html": "이메일을 판매하거나 다른 곳에 제공하지 않습니다. Cloudflare는 호스팅 제공자로서 저희를 대신해 보관만 합니다."
      },
      {
        "title": "정보주체의 권리",
        "html": "언제든 <a href=\"mailto:dev0jsh@gmail.com\">dev0jsh@gmail.com</a>로 메일을 보내 등록 정보의 열람, 정정, 삭제나 동의 철회를 요청할 수 있습니다. 요청은 지체 없이 처리합니다."
      },
      {
        "title": "동의를 거부할 권리",
        "html": "등록은 선택입니다. 동의하지 않으면 양식을 제출하지 않으면 되며, 그 경우 대기자 명단에 오르지 않는 것 외에 다른 불이익은 없습니다."
      },
      {
        "title": "쿠키",
        "html": "이 사이트는 언어를 바꿀 때만 선택을 기억하기 위해 <code>lang</code> 쿠키 하나를 설정합니다. 분석이나 광고용 쿠키는 없습니다."
      }
    ]
  },
  "notFound": {
    "title": "페이지를 찾을 수 없습니다 · dinobot",
    "description": "존재하지 않는 페이지입니다.",
    "eyebrow": "404",
    "h1": "없는 페이지입니다.",
    "body": "링크가 오래됐거나 주소에 오타가 있을 수 있어요. 다운로드는 홈에 있습니다.",
    "home": "홈으로 가기",
    "mascot": "눈이 X로 바뀐 dinobot"
  },
  "workflow": {
    "eyebrow": "요청에서 결과까지",
    "title": "프로젝트 폴더에서 시작 안내까지",
    "exampleLabel": "요청 예시",
    "request": "README를 읽고 GETTING_STARTED.md를 작성한 뒤, node --check app.js를 실행하고 결과를 보여 줘.",
    "intro": "작은 프로젝트 하나, 파일로 저장한 안내 하나. 실행한 명령과 결과를 직접 확인하세요.",
    "steps": [
      {
        "title": "프로젝트 읽기",
        "command": "cat README.md",
        "body": "기존 프로젝트 설명을 읽고 안내를 작성할 준비를 합니다."
      },
      {
        "title": "시작 안내 작성",
        "command": "GETTING_STARTED.md",
        "body": "프로젝트 폴더에 짧은 시작 안내 문서를 작성합니다."
      },
      {
        "title": "구문 검사",
        "command": "node --check app.js",
        "body": "JavaScript 구문을 검사합니다. 앱을 실행하거나 기능을 테스트한 것은 아닙니다."
      },
      {
        "title": "결과 읽기",
        "command": "cat GETTING_STARTED.md",
        "body": "새 안내 파일을 출력해 내용을 검토할 수 있게 합니다."
      }
    ],
    "result": "확인할 수 있는 결과는 데모 실행 명령이 담긴 GETTING_STARTED.md입니다. 앱 자체를 실행한 것은 아닙니다.",
    "detail": "실제 파일·명령 실행 결과"
  },
  "features": {
    "eyebrow": "작업에서 달라지는 점",
    "title": "답변을 넘어, 프로젝트 안에서",
    "rows": [
      {
        "title": "파일과 명령어 작업",
        "problem": "답변을 프로젝트에 옮기는 것도 작업입니다.",
        "body": "선택한 모델이 읽기·쓰기·수정·명령 도구를 사용합니다. 제안만 받는 대신 바뀐 파일과 명령 출력을 확인할 수 있어요.",
        "example": "이 시연에서는 GETTING_STARTED.md를 새로 만들고 내용을 출력했습니다."
      },
      {
        "title": "모델과 도구 선택",
        "problem": "모델을 실제 작업 환경에 연결해야 합니다.",
        "body": "제공업체에 로그인하고 이용 가능한 모델을 선택하세요. 필요한 작업에 맞게 추가 도구를 설정할 수 있어요. 다운로드에 모델 사용량이 포함되지는 않습니다.",
        "example": "/login과 /model로 시작하세요. MCP는 모델 제공업체가 아니라 도구 연결 방식입니다."
      },
      {
        "title": "팀 채팅의 작업 요청",
        "problem": "팀의 요청은 터미널 밖에서도 시작됩니다.",
        "body": "Slack, Discord, Telegram의 인증 정보와 접근 권한을 설정하면 허용된 사람이 연결한 채널에서 작업을 요청할 수 있어요.",
        "example": "채팅은 별도 설정이 필요합니다. 인터페이스 사이에서 대화가 자동 이전되는 것은 아닙니다."
      }
    ]
  },
  "configuration": {
    "eyebrow": "첫 요청 전에",
    "title": "모델과 작업 환경 설정",
    "rows": [
      {
        "title": "로그인과 모델 선택",
        "body": "/login으로 제공업체에 연결하고 /model로 이용 가능한 모델을 선택하세요. 인증 정보와 제공업체 사용 요금은 사용자가 관리합니다."
      },
      {
        "title": "필요한 연결만 설정",
        "body": "파일·명령 도구는 기본입니다. 브라우저, 컴퓨터 제어, MCP 연결에는 각각 설정·의존성·계정이 필요할 수 있어요. 채팅에는 인증 정보와 접근 설정이 필요합니다."
      },
      {
        "title": "실행 환경의 경계",
        "body": "로컬 실행이 격리나 개인정보 보호를 보장하지는 않습니다. 외부 모델과 연결한 서비스로 데이터가 전송될 수 있어요. HTTP API에는 인증이 없으므로 신뢰하는 로컬 계정과 루프백에서만 사용하고 인터넷에 노출하지 마세요."
      }
    ],
    "security": "보안 안내 읽기",
    "license": "PolyForm Noncommercial 1.0.0으로 소스를 공개합니다. OSI 승인 오픈 소스가 아니며, 상업적 이용에는 별도의 서면 허가가 필요합니다.",
    "licenseLink": "라이선스 읽기"
  },
  "start": {
    "title": "이제 첫 요청",
    "body": "프로젝트 폴더에서 Dinobot을 실행하고 /login으로 제공업체에 연결한 뒤 /model로 모델을 선택하세요. 결과를 검토할 수 있는 작은 작업부터 시작해 보세요.",
    "link": "작업 예시로 돌아가기"
  }
} satisfies Content;
