# 관리형 CLI/TUI 설치·업데이트

## 설치

Bun 1.4.2 이상이 필요하다. 공개 설치 명령은 저장소 [README](../../README.ko.md#설치와-실행)에 모아 둔다. 설치 프로그램은 관리자 권한을 요구하지 않으며 기존 전역 설치를 덮어쓰지 않는다.

- Windows 기본 설치: `%LOCALAPPDATA%\dinobot`, launcher: 해당 경로의 `bin\dinobot.cmd`
- macOS/Linux 기본 설치: `~/.local/share/dinobot`, launcher: `~/.local/bin/dinobot`
- 격리 설치: 절대 경로 `DINOBOT_INSTALL_DIR` 지정. launcher는 지정한 디렉터리의 `bin`에 생성

PATH는 자동 편집하지 않는다. 기존 전역 명령과 중복되면 설치 결과에 출력된 경로를 사용한다. 알 수 없는 launcher 파일이 설치 대상에 있으면 덮어쓰지 않고 실패한다.

## 업데이트

관리형 launcher 실행 시 Cloudflare 최신 안정 버전을 확인한다. 새 버전이면 SHA-512 확인, OS 임시 디렉터리 설치, 패키지 이름·버전·실행 검증을 마친 뒤 활성 포인터를 변경한다. `dinobot update`로도 같은 확인을 즉시 수행한다.

- 실패: 기존 버전 유지. 명시적 update는 실패를 표시하고 일반 실행은 기존 버전으로 계속 실행
- 동시 실행: 설치 잠금 하나로 직렬화. 잠금을 임의로 훔치지 않음
- 실행 중 프로세스: 이전 버전 디렉터리를 계속 사용. 자동 삭제·덮어쓰기·강제 재시작 없음
- 반영: 새 CLI/TUI는 선택된 버전, 기존 데몬은 자연 종료 후 다음 관리형 기동에서 반영
- 제외: 상시 업데이트 타이머, live hot-swap, 기존 전역 설치 자동 이전, Desktop 업데이트

설계 이유는 [결정 0106](decisions/0106-managed-cloudflare-install.md)에 정리했다.
