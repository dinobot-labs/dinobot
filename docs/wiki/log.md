# 변경 기록

- 2026-10-29: 공개 정본에 opt-in `pm` 원장 플러그인과 `onTurnEnd` 훅을 이식했다. 원본 cd9e4c3 및 실행 시간 보정 1b8ce47을 기준으로 소유 대화·작업자·커밋·검사 전이 가드와 입력당 3회 이어 가기를 보존한다. `pm_run_check`는 기본·최대 900초 검사, 945초 codemode 호출 예산을 선언한다. 설정·계약은 [PM 구조](architecture/pm.md), 결정은 [ADR 0105](decisions/0105-pm-ledger-plugin.md)에 기록했다.
