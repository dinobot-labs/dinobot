# 변경 기록

- 2026-10-31: 자동 기억 회수에서 한국어 내부 두 글자 조각 대신 정규화된 어휘 일치를 사용하고, 전달 이력과 무관하게 프로젝트 전체로 IDF를 계산한다. [회수 계약](contracts/memory-recall.md)에 정상 회수·빈 결과·중복/재시작 불변식과 형태소·의미 판별의 한계를 기록했다. 소스 수정이며 설치된 실행 버전 갱신을 뜻하지 않는다.

- 2026-10-31: 코어 예약 도구 `schedule_create/list/update/cancel`을 추가했다. 시간·명시적 목표 완료 조건, 원래 대화 소유권, 재시작 유지, admission 중복 방지·취소 경계·결과 조회를 구현했다. calendar의 host wake/채널 전달 경계를 재사용한다. 조건은 idle이 아니라 성공 final·목표 증거·하위 작업·질문·큐를 함께 확인한다. 외부 채널 간 사용자 권한은 추정하지 않는다. [예약 계약](contracts/scheduling.md)에 제약과 검증 범위를 기록했다.
- 2026-10-31: 명시적 목표 예약 대기와 liveness를 연결하고, 권한 질문·DAG 작업 제어·도구 검색 exactMatch 안내를 실제 계약에 맞췄다. 예약/프롬프트 회귀 132개를 확인했다.
- 2026-10-31: 오프라인 복구에 macOS PID·PGID·Cua Driver 거부 인벤토리와 tokenless native process exact-call 조정을 추가했다. terminal/ownership/lease·OS 증거·CAS·감사·SQLite exclusive lock을 유지하며 historical external abandonment와 분리한다. [복구 계약과 제한](quarantine-recovery.md).

- 2026-10-29: 공개 정본에 opt-in `pm` 원장 플러그인과 `onTurnEnd` 훅을 이식했다. 원본 cd9e4c3 및 실행 시간 보정 1b8ce47을 기준으로 소유 대화·작업자·커밋·검사 전이 가드와 입력당 3회 이어 가기를 보존한다. `pm_run_check`는 기본·최대 900초 검사, 945초 codemode 호출 예산을 선언한다. 설정·계약은 [PM 구조](architecture/pm.md), 결정은 [ADR 0105](decisions/0105-pm-ledger-plugin.md)에 기록했다.
