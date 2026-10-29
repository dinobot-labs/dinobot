---
type: Decision
title: 0105 — 장기 작업 원장은 pm 플러그인으로 두고, 규칙은 도구 가드와 턴 종료 훅으로 기계적으로 검사한다
description: 여러 작업자를 쓰는 장기 작업의 원장(작업 단위·상태·커밋·검증·결정)을 opt-in 내장 플러그인 pm으로 만든다. 상태 전이는 코드가 검사하고, 플러그인 계약에 호스트 사실을 받는 onTurnEnd 훅과 호출 대화 정보를 더한다.
status: accepted
tags: [decision, plugins, pm, liveness, hooks]
generated:
  by: process:dinobot
  at: "2026-10-21"
sources:
  - resource: repo://src/plugins/pm/index.ts
  - resource: repo://src/plugins/pm/model.ts
  - resource: repo://src/plugins/pm/store.ts
  - resource: repo://src/plugins/pm/git.ts
  - resource: repo://src/plugins/types.ts
  - resource: repo://src/extensions/plugin-hooks.ts
  - resource: repo://src/core/toolmode.ts
  - resource: repo://src/core/bot.ts
  - resource: repo://test/pm-ledger.test.ts
  - resource: repo://test/pm-hooks.test.ts
---
# 0105 — pm 원장 플러그인과 플러그인 턴 종료 훅

## 배경

여러 작업자를 쓰는 장기 작업에서 일반 Markdown 원장과 보조 스크립트만으로 진행 상태를 관리하면, 작업 전이 규칙을 지키는 주체가 모델에 머문다.

- "작업자 결과를 받으면 원장에 반영한다", "검증 없이 done으로 두지 않는다", "빈 자리가 있으면 다음 작업을 배정한다"는 프롬프트 지시였다. 모델이 잊으면 아무것도 막지 않았다.
- 원장은 일반 Markdown이라 모델이 파일 도구로 아무 행이나 고칠 수 있었다. 커밋 해시와 검증 수치가 실제와 맞는지는 아무도 확인하지 않았다.
- 진행률과 완료 예상은 매번 표를 다시 읽어 계산했다.

기존 ADR 0096의 liveness 훅은 goal에 대해서만 턴 종료를 막는다. 플러그인은 pi-durable을 모르므로 이런 검사를 걸 자리가 없었다.

## 결정

1. **원장은 opt-in 내장 플러그인 `pm`이다.** `plugins.pm: {}`로 켠다. 자격 증명과 네트워크가 없으므로 기존 ADR 0018의 체크리스트를 따르되, 쓰기 도구가 원장 자체라 `write` 스위치는 두지 않는다.
2. **원장은 해시 사슬 이벤트 목록이고, 상태는 그 재생 결과다.** 파일은 작업 폴더 밖인 `<dataDir>/pm/<id>.json`(`root`로 바꿀 수 있음)에 있고 `storagePaths`로 호스트 저장소에 등록된다. 손으로 고치면 다음 로드에서 `hash mismatch`로 드러난다. 저장된 스냅샷이 없으므로 상태가 이력과 어긋날 수 없다.
3. **모든 상태 전이는 순수 함수 가드를 통과해야 기록된다.** 가드는 원장과 호스트 사실만 입력으로 받는다. 거부되면 아무것도 기록하지 않는다.
   - `doing`: 호스트 기록상 실행 중인 서브에이전트 `taskId`가 작업자, 선행 작업 완료, WIP 한도 이내, 작업자 1명당 작업 1개.
   - `review`/`done`: 원장 `repo`에 실제로 있는 커밋, 작업자 종료.
   - `done`: 위에 더해 `integrationRef`에서 도달 가능한 커밋, 그 커밋에서 필수 검사 전부의 마지막 실행이 통과.
   - `blocked`/`todo`(되돌림)/`excluded`: 사유 필수. `done`과 `excluded`는 최종 상태다.
   - 원장을 만든 대화만 바꿀 수 있다. 작업자(서브에이전트)는 보고하고 PM이 기록한다.
4. **검사 결과는 플러그인이 직접 실행해 기록한다.** `pm_run_check`는 원장에 등록된 명령만, 커밋 위치이고 추적 파일 변경이 없는 작업 트리에서 실행한다. 실행 중 HEAD나 파일이 바뀌면 종료 코드 0이어도 실패다. 모델이 적은 "테스트 통과" 문구는 증거가 아니다.
5. **플러그인 계약에 두 가지를 더한다.**
   - `PluginToolCall.conversationId`와 `subagents()`: 호출 대화의 id와, 그 대화가 만든 서브에이전트의 상태(호스트 문서에서 읽음).
   - `PluginInstance.onTurnEnd(turn)`: 최상위 대화가 최종 답으로 턴을 끝낼 때 호스트 사실(`subagents`, 열린 사람 질문 수, 실행 중 DAG run 수)을 받아 문자열을 돌려주면 그 문자열로 run을 이어 간다. pi-durable 타입은 노출하지 않는다.
6. **`plugin-hooks` 확장이 훅을 부르고 횟수를 제한한다.** goal liveness 훅보다 먼저 설치한다. 사람 입력 하나당 최대 3회(호스트 wake로 시작한 run은 그 입력의 횟수를 이어 씀), 이어 간 턴이 도구를 하나도 부르지 않으면 다시 잇지 않는다. 훅이 예외를 던지면 턴은 끝나고 오류만 보고한다.
7. **pm의 턴 종료 규칙**(원장이 `active`일 때만):
   - `unrecorded_worker`: `doing` 작업의 작업자가 끝났는데 기록이 없다.
   - `orphan_doing`: `doing` 작업의 작업자가 이 대화의 서브에이전트가 아니다.
   - `idle_capacity`: 실행 중 작업자가 WIP 한도보다 적은데 시작 가능한 작업이 있다(앞의 두 규칙이 없을 때만).
   - `all_final`: 모든 작업이 최종 상태인데 원장이 아직 `active`다.
   - 의도적으로 멈출 때는 `pm_set_status paused`와 사유를 남긴다.

## 대안

| 안 | 장점 | 단점 |
|---|---|---|
| 스킬(지침)만 | 구현 없음 | 지금과 같이 모델 확률에 의존 |
| 호스트 확장(goal처럼) | 훅·문서 직접 접근 | 플러그인 계약 밖이라 떼어내기 어렵고, 원장 도구가 하네스에 묶임 |
| **플러그인 + 계약 확장(채택)** | 원장 로직은 `src/plugins/pm/`에 격리, 훅은 pi-durable 무관 타입 | 계약에 필드 2개·훅 1개 추가 |
| Markdown 원장 + 검사 스크립트 | 사람이 바로 읽음 | 파일 변조·모델 수정을 막지 못함 |

Markdown은 `pm_export_markdown`이 만드는 읽기용 보기로만 남긴다.

## 보장하지 않는 것

- 검사 명령 자체의 의미(테스트가 충분한지)는 원장을 만든 사람이 정한다. 원장은 그 명령이 그 커밋에서 통과했다는 사실만 보장한다.
- `integrationRef`는 로컬 ref다. 원격 반영은 PM이 fetch한 상태를 기준으로 한다.
- 호스트 계속 실행은 사람 입력마다 3회로 제한되므로, 모델이 계속 무시하면 턴은 끝난다. 남은 지적은 다음 턴 종료나 `pm_status`의 `findings`에 다시 나온다.
- 같은 데이터 디렉터리를 여러 데몬 프로세스가 동시에 쓰는 경우의 잠금은 없다(한 프로세스 안에서는 원장별로 직렬화).
- 해시 사슬은 비밀 키 없는 sha256이다. 손으로 고친 흔적과 사고는 잡지만, 셸 권한으로 해시를 다시 계산해 파일 전체를 위조하는 것까지 막지는 못한다. YOLO 셸을 가진 에이전트를 상대로 한 변조 방지는 범위 밖이다.
