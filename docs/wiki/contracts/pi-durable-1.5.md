# pi-durable 1.5 전환

## 계약 경계

Dinobot의 공개 메시지·플러그인·codemode worker 결과는 계속 `content`다. Durable 도구 실행 반환만 `output`으로 바뀐다. `AgentEvent`·`SnapshotEvent`·`MessageChange`는 `src/core/ui-contract.ts`의 Dinobot 계약이고, 네이티브 conversation 상태는 관찰 어댑터에서 변환한다. 상태 watch는 중간 변경을 접을 수 있으므로 완료 증거는 immutable entry와 submission/task receipt다.

| 경계 | 1.5 계약 |
|---|---|
| watch | `call.kind === "value"`에서만 value/ops/retired 사용. `failed`는 성공·idle이 아님 |
| watch 종료 | `kind`: stopped, aborted, ended, listener_error, failed |
| 도구 API | models, now, outputWindow, retainedOutput, executeTool 포함. 출력 변환 wrapper는 outputWindow도 비활성화 |
| 스키마 | Type·Static·TSchema는 typebox에서 import |
| 보고 | onReport의 단일 Report에서 kind/error 확인 |
| 저장 | commit(batches, receive, context). receive는 저장된 prefix의 배치마다 순서대로 한 번 |

현재 설치본의 `CommitResult.refused`는 오류 값 자체(`unknown`)다. 내부 구현의 임시 `{error}` 변수를 공개 반환형으로 오해하면 안 된다. CHANGELOG의 오래된 서명 대신 해당 배포본의 types와 writer 구현을 기준으로 한다.

## 불변식

- 모델 요청: `dispatch(c,a) ⇒ freshGuard(c,a) succeeded ∧ invocation alive`. 일반 hook 오류를 보고하고 계속하는 경로와 별개다. generation·compaction·deferred polling·재시작에서 거부 시 provider 호출이 없어야 한다.
- 스트리밍: partial 반영에는 `live.run.taskId = producer.taskId ∧ live.generation.attempt = producer.attempt`가 필요하다. 소유자·attempt 교체 뒤 늦은 partial은 새 상태를 수정하지 않는다.
- 압축 경계: `B = max(1, floor(min(W-R, W*r, C>0 ? C : ∞)))`. `tokens > B`에서 blocking하며 같을 때는 blocking하지 않는다. 기본 cap은 300K, ratio는 70%; 명시 모델 설정·전역 설정·현재 모델 기본값의 우선순위를 보존한다. 요약 출력 예산은 reserve 기준이다.
- 호스트 문서: `checkpointEvery256(value, ops, info)`는 `info.deltasSinceBase >= 256`일 때 base를 만든다. upstream pi.live의 generation/tool 경계 정책을 이 정책으로 덮지 않는다.
- 저장: stale writer는 첫 SQL 쓰기 전에 거부한다. 성공 prefix만 저장·공개하며 SQL rollback이면 예상 sequence를 전진시키지 않는다.
- 대기: 저장된 절대 deadline `D`는 재시작 시 `now + delay`로 재계산하지 않는다. `now < D`에서 작업을 실행하지 않고 `now >= D`에서 한 번 완료한다.

## Upstream 재사용과 자체 패치

| 책임 | 전환 |
|---|---|
| baseline system 문맥 순서·요약의 thinking 제외 | 1.5 upstream 구현 재사용 |
| 필수 문서 checkpoint 정책 | 호스트 문서 정의에 기존 256-delta 의미 명시 |
| SQLite schema·LiveDoc·ToolTask 버전 변환 | upstream migration 재사용 |
| 300K/70% 압축 정책·모델 요청 안전 경계 | 자체 패치 유지 |
| 늦은 streaming producer 거부 | 실제 generation 경로의 소유자/attempt 검사 유지 |
| stale SQLite writer·특정 역사적 replay 복구 | 자체 패치 유지; 다른 손상으로 허용 범위 확대 금지 |
| 손상 task 격리·native 실행 provenance | 자체 패치 책임 유지; 별도 회귀 검증 필요 |

## 저장 실패의 동작 변경

1.0.2 fixture는 저장 전 거절 뒤 같은 Session을 재사용했다. **1.5에서는 definite refusal도 Session을 실패 상태로 만든다.** `dist/session/writer.js`의 `#publish`는 성공 prefix를 공개한 뒤 refusal/rejection에서 Session을 실패 처리한다. `dist/session/session.js`의 `#assertHealthy`가 후속 읽기·쓰기를 `SessionFailed`로 막는다.

이는 이전 live-session 동작과 동일하지 않다. 회귀 테스트는 거절된 변경의 원자성, **기존 Session의 추가 쓰기 거부**, close/reopen 뒤 이전 값의 동일성, 같은 요청의 재시도 성공을 확인한다. 오류를 삼켜 재사용하는 호환층은 추가하지 않는다. unknown-outcome I/O 실패와 definite refusal의 저장 결과는 다르지만 둘 다 새 Session 전에는 계속 실행하지 않는다.

## DB의 순방향 경계

SQLite를 1.5로 열면 schema 1→2 migration이 일어나며 sleeping 상태를 지원하도록 task 테이블을 재구성한다. pi.live v1→v3는 compaction `reason→trigger`와 누락된 `run.turns→0`을 처리한다. 오래된 task의 pending call은 실행 가능하지만, 실행 intent까지 기록된 unsafe tool은 재실행하지 않고 interrupted 결과를 남긴다. safe tool만 재실행한다. 이 경계를 지나간 DB를 1.0.2와 양방향 호환한다고 보지 않는다.

검증에는 사용자 DB가 아닌 **실제 1.0.2가 만든 합성 DB의 SQL export**를 사용한다. 일반 테스트는 체크인된 pending/running SQL을 OS 임시 디렉터리에 materialize하므로 sibling worktree·네트워크 설치가 필요 없다. 실행 중이던 fixture는 commit 완료 뒤 프로세스를 종료했으며, 정지한 파일 집합만 복사한다. schema·indices·integrity·entry ID/value·queue·live·task의 보존과 재개를 실제 1.5 SQLite/Harness에서 확인한다.

## Fixture 재생성

생성기: `test/fixtures/durable102-db.mjs`. SQL 헤더의 manifest에는 원본 task 상태, 예상 entry/queue/live 값, Durable JS 트리 SHA-256과 생성기 SHA-256, dependency 버전이 들어간다. SQL은 검토 가능한 입력 fixture이며 런타임 DB·스크린샷·매회 갱신되는 결과물이 아니다.

1. 읽기 전용으로 사용할 1.0.2 설치 루트를 준비한다. 외부 OS 임시 프로젝트라면 Durable·pi-ai·chord를 모두 `1.0.2`로 고정한다. Durable의 caret 의존성만으로는 최신 pi-ai/chord가 설치될 수 있다. 기존 패치 재현이 목적이면 기준 커밋의 patch와 lock도 사용한다.
2. `bun test/fixtures/durable102-db.mjs <old-root> <disposable-output> pending` 및 running을 별도 빈 디렉터리에서 순차 실행한다. 출력 디렉터리는 먼저 만든다.
3. 생성된 SQL의 schema 1, pending/call 또는 running/execute와 provenance를 확인하고 source fixture를 교체한다. DB 파일은 커밋하지 않는다.
4. `DINOBOT_DURABLE_102_ROOT=<old-root> bun test test/durable15-migration.test.ts`는 체크인된 SQL 대신 실제 구버전 생성기를 사용한다. 이 옵션 없이 실행하면 SQL 입력만 사용한다. old-root 부재·버전 불일치는 실패이며 조용히 skip하지 않는다.

## 검증 범위

| 파일 | 관찰 대상 |
|---|---|
| durable15-migration | 실제 v1 schema, LiveDoc v3, immutable history/queue, safe/unsafe pending·running, 절대 deadline·reopen |
| stream-producer-ownership | 실제 Harness와 controlled provider stream의 소유자 교체·attempt 교체·현재 producer |
| startup-replay | 역사적 identity/revision/bytes 양성·음성, v3 hydration, 프로세스 간 stale writer, 손상 task 격리 |
| compaction-policy·pi-durable-backport | cap/ratio·window 경계·모델 전환·요약 사실 보존·thinking 제외·실패 시 dispatch 차단 |
| skill-integrity-boundary | ordinary hook과 안전 경계 구분, compaction·deferred·SQLite reopen 거부 |
| document-checkpoint | 256-delta bound·600회 쓰기 값 복원·수동 compact 전후 값 동일성 |
| skill-store·skill-storage | definite refusal의 Session fence와 reopen 원자적 재시도 |

Windows에서는 SQLite close 뒤에도 메모리 매핑이 프로세스 종료까지 남을 수 있다. SQLite fixture의 부모 프로세스가 임시 디렉터리를 소유하고, 자식에서 실제 assertion과 close를 끝낸 뒤 자식 exit를 기다려 삭제한다. 삭제 실패를 catch로 삼키지 않는다.

검증은 합성 데이터·controlled provider 기준이다. 실제 사용자 DB migration, provider network, 전 OS native containment, 설치된 daemon/Desktop 교체까지 증명하지 않는다. 테스트 wrapper의 부모 assertion 수와 자식에서 수행한 실제 DB assertion 수를 구분한다. 이는 모든 환경의 무결함 보장이 아니며, 플랫폼별 실패와 진단 probe의 재현 성공을 기능 검증 통과와 구분한다.

### 통합 실행 결과 (2026-11-05)

- 격리 Linux에서 전체 TypeScript 검사와 관련 63개 테스트 파일: **717 통과, 3 skip, 0 실패**. skip은 Windows ZIP 전용 3개이며 Windows에서 별도로 모두 통과했다. 저장·압축·관찰·도구·하위 작업·DAG·native process crash 검증을 포함한다. 저장소 전체 테스트를 실행했다는 뜻은 아니다. 추가 `durable-tools` 4개도 통과했다. 이 fixture는 1.5의 model-offered 목록과 callable 목록을 구분하고, 실제 codemode 도구 목록의 정확한 일치를 검사한다.
- Windows와 Linux standalone 빌드 및 각각의 `--version` 실행: `0.8.5`. Windows에서는 Bun 실행 파일의 Unicode 경로 문제를 피하려고 동일 바이트의 Bun을 ASCII 경로에서 직접 `script/build.ts`에 실행했다. 기본 PATH의 Bun으로 실행한 최초 빌드는 실패했으며 이를 제품 빌드 성공으로 세지 않는다.
- OS 임시 프로젝트의 frozen install 후 자체 patch 대상 17개 파일이 검증된 설치 트리와 byte-identical이고 lockfile도 불변이다. pi-tui 1.0.0 및 oh-my-pi/pi-ai 18.5.0의 버전·패치는 유지했다.

## 추가 경계 검증

- `beforeRequest`가 제거한 도구는 provider가 이름을 반환해도 실행하지 않는다. upstream의 pre-hook inventory 참조 문제를 실제 Harness로 재현했고, 요청 분류에는 실제 전달한 post-hook messages를 사용하도록 패치했다. 도구가 유지된 양성 사례도 실행한다.
- 호스트 invocation 종료 후 저장된 conversation handle·환경·reader·model 메서드는 새 작업을 받지 않는다. reader.close는 자원 해제를 위해 남겨 둔다. 이미 시작한 비동기 작업의 취소·결과는 native 계약을 따른다. 이는 JavaScript sandbox를 의미하지 않는다.
- nested key는 native JSON 동등성을 따른다. 0/-0 및 객체 prototype 차이는 새 실행이 아니며, 다른 인수는 거부한다.
- attachment/wire 보관을 거절해도 이미 발생한 usage는 같은 terminal commit에서 한 번 기록한다. nested ToolTask의 usage를 부모가 중복 계산하지 않는다.
- watch stop과 listener rejection이 겹치면 listener_error를 보존한다. session close로 미전달 entry가 생길 수 있으면 failed/reconnect로 알리며, 도구 성공·실패를 만들어 내지 않는다. immutable toolResult와 일치할 때만 채널 결과를 확정한다. 종료 후 무손실 전달이나 닫힌 DB 조회를 보장하지 않는다.
- text block이 thinking/toolCall로 교체되면 공개 draft를 다시 계산한다. 비어 있는 결과는 명시적 draft_clear로 전송하고, 채널은 비어 있지 않은 기존 progress card를 표시한다. 일반 빈 draft 입력은 여전히 거부한다. 별도 다음 generation이 thinking으로 시작할 때는 이전에 공개한 문구를 새 공개 text까지 유지하는 기존 표시 동작을 보존한다. 같은 mapper 입력으로 1.0.2와 1.5 양쪽을 실행해 이 경계를 확인했으며, 같은 generation 안의 block 교체와 구분한다.

## Foreground 하위 작업의 재시작

unsafe codemode의 waiter가 죽었다고 conversation-owned 하위 작업까지 취소하면 안 된다. 새 CapabilityTask에는 native `abandonOnRestart` 정책을 적용한다. 이미 저장된 flag 없는 task는 실제 pi.tool 부모와 AssistantEntry의 codemode 호출, restart 횟수·unsafe intent를 확인해 pre-intent 실행과 safe waiter 재실행을 막는다. 독립 safe capability 재실행과 명시적 foreground 취소는 유지한다.

`durable15-foreground-restart`는 실제 committed MemoryStorage를 얼린 뒤 reopen하여 독립 safe 재실행과 legacy 방식 pre-intent admission을 검증한다. 후자는 1.5에서 구 admission 방식을 재현한 것이며 구버전 DB라고 부르지 않는다. 별도로 패치된 1.0.2의 실제 foreground SIGKILL DB를 1.5로 열어 같은 child 한 개·runner 한 개·completed 결과를 확인했다. `DINOBOT_CRASH_INITIAL_FIXTURE=<1.0.2 checkout>/test/fixtures/codemode-crash.ts bun test test/codemode-crash.test.ts -t "SIGKILL at foreground"`로 재현하며 recovery는 항상 현재 checkout을 사용한다.

## CPU·메모리 비교

Windows/Bun 1.4.3, 동일 Ryzen 5 7500F 환경에서 `script/bench/durable-streaming.ts`를 양쪽 버전에 수정 없이 실행했다. 실제 Harness·파일 SQLite를 사용하며 대화당 입력 128KiB, 답변 128KiB, 병렬 도구 4개×8KiB다. 동시성별 독립 프로세스 3회와 warmup을 사용하고, 매회 transcript·도구 병렬 실행·저장 후 reopen 값·임시 디렉터리 정리를 확인했다.

아래는 중앙값이다. CPU는 해당 worker process의 user+system 시간이고, RSS는 10ms 표본 및 측정 구간 양끝의 최대값이다.

| 동시 대화 | 버전 | 소요 ms | CPU ms | 표본 최대 RSS MiB | Storage.commit 호출 |
|---|---|---:|---:|---:|---:|
| 1 | 패치된 1.0.2 | 239.18 | 78 | 97.76 | 25 |
| 1 | 패치된 1.5.0 | 253.31 | 94 | 95.86 | 18 |
| 8 | 패치된 1.0.2 | 330.71 | 219 | 140.55 | 201 |
| 8 | 패치된 1.5.0 | 345.66 | 298 | 142.14 | 138 |

commit 호출은 28%/31% 줄었지만 이 측정에서 CPU 개선은 관찰되지 않았다. CPU 범위는 동시성1에서 47–141ms→63–218ms, 동시성8에서 203–219ms→203–328ms다. 3회 표본·Windows timer/GC 변동이므로 작은 차이의 통계적 유의성을 주장하지 않는다. 전체 프로세스 lifetime maxRSS 중앙값은 각각 98.11→95.86MiB, 140.64→142.29MiB이며 setup/warmup도 포함한다.

별도 관찰 어댑터 테스트의 같은 9,800자 답변에서는 native incremental payload가 19,000자, root-replacement fallback이 약206,240자였다. 이 수치는 어댑터 이벤트 직렬화량이며 위 CPU·RAM 결과나 실제 네트워크/UI 성능 개선으로 대신 설명하지 않는다. 벤치마크에는 실제 provider network, UI, compaction, cancellation, crash recovery가 포함되지 않는다.

## Native process 검증 경계

Linux에서 실제 SIGKILL, SQLite reopen, 실행 중 Bash 취소, 고아 프로세스 종료 뒤 fence 해제, DAG/검증 작업 재개를 실행했다. Windows ZIP 전용 경계 3개도 별도로 통과했다. Windows native containment의 boot identity 관련 2개 실패는 패치된 1.0.2에서도 재현된 환경/기존 문제이며, Windows 전체 suite 통과로 보고하지 않는다.

**기존 POSIX 한계는 남아 있다.** canonical receipt 및 재조정의 quiescent는 기록된 process group이 비었다는 증거다. 자식이 setsid로 새 session/group을 만들면 전체 자손의 종료 증거가 아니다. 격리 Linux에서 같은 probe를 패치된 1.0.2와 1.5.0에 실행해, 원래 group의 canonical/quiescent 뒤 escaped child가 새 파일 쓰기를 수행하는 것을 양쪽 모두 확인했다. 따라서 이 결과를 Linux 전체 process-tree containment 또는 악의적인 자손에 대한 자원 fence 보장으로 해석하면 안 된다. 이번 전환이 새로 만든 회귀는 아니지만, 해결된 보안 속성도 아니다.
