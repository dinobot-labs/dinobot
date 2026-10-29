---
type: Component Architecture
title: pm 원장 플러그인
description: 여러 작업자를 쓰는 장기 작업의 작업 단위·상태·커밋·검사·결정을 해시 사슬 이벤트로 기록하고, 상태 전이와 턴 종료를 코드로 검사하는 opt-in 플러그인.
status: stable
tags: [architecture, plugins, pm, liveness]
generated:
  by: process:dinobot
  at: "2026-10-21"
sources:
  - resource: repo://src/plugins/pm/index.ts
  - resource: repo://src/plugins/pm/model.ts
  - resource: repo://src/plugins/pm/store.ts
  - resource: repo://src/plugins/pm/git.ts
  - resource: repo://src/extensions/plugin-hooks.ts
  - resource: repo://test/pm-ledger.test.ts
  - resource: repo://test/pm-hooks.test.ts
---
# pm 원장 플러그인

결정 배경은 [0105](../decisions/0105-pm-ledger-plugin.md), 호스트 경계는 [플러그인 계약](../contracts/plugin-contract.md)에 있다.

기본은 꺼짐이며 `dinobot.yaml`의 `plugins.pm: {}`로 켠다. 저장 위치는 `<dataDir>/pm`, 별도 위치는 `plugins.pm.root`로 지정한다.

## 구성

```text
src/plugins/pm/
  model.ts   순수 모델: 타입, reduce, 전이 가드, 진행률·ETA, 턴 종료 규칙, Markdown 보기
  store.ts   이벤트 파일: 해시 사슬 검증, 재생, 원장별 직렬화, 원자적 교체
  git.ts     git 사실(커밋 존재·도달 가능)과 검사 실행
  index.ts   플러그인: 설정, 도구 10개, prompt, onTurnEnd
src/extensions/plugin-hooks.ts   호스트: 플러그인 onTurnEnd 호출과 횟수 제한, 서브에이전트 상태 읽기
```

`src/plugins/pm/`은 같은 디렉터리와 `../types.ts`만 import한다.

## 데이터 모델

원장 파일은 `{ events: Event[] }` 하나다. 이벤트는 `op`(create, add_items, transition, check_run, decision, ledger_status)와 `seq`, `at`, `actor`(대화 id), `prev`, `hash`를 갖는다.

```text
hash_n = sha256(hash_{n-1} + "\n" + JSON(event_n without prev/hash)),  hash_0 = 0^64
state  = reduce(... reduce(undefined, e_1) ..., e_n)
```

로드는 항상 `seq`, `prev`, `hash`를 확인한 뒤 재생한다. 그래서 다음이 성립한다.

- 저장된 상태와 이력이 어긋날 수 없다(상태를 따로 저장하지 않는다).
- 파일 중간을 고치면 그 이벤트부터 해시가 맞지 않는다. 마지막 이벤트를 고쳐도 그 이벤트의 해시가 맞지 않는다.
- 가드는 기록 전에만 돈다. `reduce`는 외부 사실을 다시 확인하지 않는다. 기록 당시 검사한 사실(커밋 전체 해시, 검사 결과)이 이벤트에 들어 있다.

## 상태 전이

```text
todo ──> doing ──> review ──> done
  │        │  ^       │
  │        │  └───────┤
  │        ├──> blocked ──> todo / excluded
  │        └──> todo(사유)
  └──> excluded / blocked
```

| 전이 | 가드(모두 만족해야 기록) |
|---|---|
| → doing | worker 지정, worker가 이 대화의 서브에이전트이고 `running`, 다른 doing 작업을 잡고 있지 않음, 선행 작업이 done/excluded, doing 수 < `wipLimit` |
| → review | 커밋 지정(또는 이미 있음), 16진 형식, `repo`에 존재, worker가 `running`이 아님 |
| → done | review 조건 + `integrationRef`에서 도달 가능 + 필수 검사마다 그 커밋에서의 마지막 실행이 통과 |
| → blocked / todo / excluded | 사유 필수 |
| done, excluded | 최종. 다시 열지 않고 새 작업을 추가한다 |

원장이 `paused`나 `closed`면 전이를 받지 않는다. `closed`는 모든 작업이 최종일 때만 된다. 모든 변경은 원장을 만든 대화(`owner`)만 할 수 있다.

## 검사 실행

`pm_run_check`의 순서:

1. 원장 `checks`에 있는 검사인지, 커밋이 `repo`에 있는지 확인한다.
2. 작업 트리 `cwd`의 HEAD가 커밋과 같고 추적 파일 변경이 없는지 확인한다(아니면 거부, 기록 없음).
3. 셸로 명령을 실행한다. 제한 시간이 지나면 프로세스 트리를 끝낸다. 제한 시간은 검사의 `timeoutSec`(기본·최대 900초)이고, 그 전에 만든 원장에 더 큰 값이 있어도 900초로 자른다. codemode-only 모드에서는 pm 도구가 codemode 셀 안에서 돌고 셀 상한이 960초라서다. `pm_run_check`는 `maxDurationMs`(945초)를 선언해 셀이 기본 60초 대신 그만큼 기다린다.
4. 다시 HEAD와 변경을 확인한다. 바뀌었으면 `invalid`로 기록한다.
5. `passed = exit 0 && invalid 없음`. 출력은 sha256과 마지막 4000자만 남긴다.

## 턴 종료 훅

```text
최종 답 ─> plugin-hooks.onYield
            ├ 서브에이전트 대화면 통과
            ├ facts = { subagents(호스트 문서), openHumanAsks, runningDagRuns }
            ├ 각 플러그인 onTurnEnd(facts) → 첫 문자열 채택
            └ 횟수 확인(입력당 3회, 도구 없는 이어 가기 뒤에는 중단) → continue
```

pm은 대화가 소유한 `active` 원장마다 [0105](../decisions/0105-pm-ledger-plugin.md)의 네 규칙(`unrecorded_worker`, `orphan_doing`, `idle_capacity`, `all_final`)과 무결성 오류를 모아 한 메시지로 돌려준다. 실행 중 작업자만 있고 시작 가능한 작업이 없으면 아무것도 돌려주지 않는다. 작업자가 끝나면 idle wake(기존 ADR 0091)가 대화를 다시 깨우고, 그 턴이 기록 없이 끝나면 이 훅이 잡는다.

## 진행률과 ETA

`pm_status`가 계산한다. 시계 이외의 입력은 기록된 타임스탬프뿐이다.

```text
throughput = 최근 6시간 done 수 / 6   (3개 미만이면 시작 이후 전체 평균)
by_rate    = 남은 작업 수 / throughput
by_path    = 남은 작업의 최장 선행 사슬 길이 × done 작업 소요 시간 중앙값
eta        = max(by_rate, by_path)
```

## 검증

- `test/pm-ledger.test.ts`: 가드 전수(작업자·선행·WIP·커밋·도달 가능·검사), 순환 거부, 턴 종료 규칙, ETA, 실제 git 저장소에서 전체 수명 주기(소유자 아닌 대화 거부, 더러운 트리 거부, 실패 검사 뒤 done 거부), 파일 변조 감지, 재생 일치.
- `test/pm-hooks.test.ts`: 실제 봇(faux 모델)에서 이어 가기 1회, 입력당 상한, 도구 없는 이어 가기 중단, 실제 background 서브에이전트가 끝난 뒤 기록 없이 끝나는 턴을 잡는지.
