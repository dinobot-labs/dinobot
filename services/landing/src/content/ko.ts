/** Product copy; historical privacy semantics preserved. */
import type { Content } from "./en.ts";
export const ko = {
  "meta": {
    "title": "Dinobot — 지금 해야 할 일에, 함께하는 에이전트.",
    "description": "데스크톱이나 터미널에서 시작하세요. 모델을 고르고 팀 채팅을 연결하세요.",
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
    "eyebrow": "데스크톱 + 터미널",
    "line1": "지금 해야 할 일에,",
    "line2": "함께하는 에이전트.",
    "sub1": "데스크톱이나 터미널에서 시작하세요.",
    "sub2": "모델을 고르고 팀 채팅을 연결하세요.",
    "primary": "Dinobot 시작하기",
    "source": "소스 보기",
    "demo": "앱 시연 화면",
    "blue": "블루",
    "black": "블랙",
    "open": "원본 보기",
    "caption": "제품 시연 · 실제 데스크톱 앱에서 모의 모델로 진행한 대화입니다.",
    "altBlue": "프로젝트 파일 세 개를 보여 주는 bash 실행 결과가 펼쳐진 Dinobot 블루 테마 화면.",
    "altBlack": "프로젝트 파일 세 개를 보여 주는 bash 실행 결과가 펼쳐진 Dinobot 블랙 테마 화면.",
    "unavailable": "미리보기를 불러오지 못했습니다. 원본을 열어 주세요."
  },
  "tools": {
    "title": "말로 요청하고, 도구 실행을 확인하세요.",
    "body": "작은 프로젝트의 파일을 보여 달라고 요청한 시연입니다. 펼친 bash 결과에서 명령어와 출력을 확인할 수 있습니다.",
    "label": "도구 실행 결과 · 앱 시연 화면"
  },
  "workflows": {
    "title": "원하는 방식으로 일하세요.",
    "rows": [
      {
        "title": "모델을 고르세요.",
        "body": "모델 제공업체 계정으로 로그인한 뒤 사용할 모델을 선택하세요."
      },
      {
        "title": "필요한 도구를 연결하세요.",
        "body": "MCP, 브라우저, 데스크톱 도구로 Dinobot을 확장하세요."
      },
      {
        "title": "팀 채팅을 연결하세요.",
        "body": "Slack, Discord, Telegram을 대화 채널로 설정하세요."
      }
    ],
    "note": "사용하는 기능에 따라 모델 계정, 채널 인증 정보와 도구 설정이 필요합니다."
  },
  "interfaces": {
    "title": "데스크톱과 터미널, 편한 곳에서 시작하세요.",
    "desktop": "Dinobot을 사용하는 별도의 데스크톱 클라이언트입니다.",
    "cli": "에이전트 데몬과 터미널 인터페이스입니다.",
    "chat": "팀 채팅",
    "chatBody": "직접 설정해 연결하는 Slack, Discord, Telegram 채널입니다.",
    "privacy": "Dinobot은 사용자 기기에서 실행됩니다. 외부 모델 요청은 선택한 제공업체로 전송됩니다."
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
    "tagline": "지금 해야 할 일에, 함께하는 에이전트."
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
  }
} satisfies Content;
