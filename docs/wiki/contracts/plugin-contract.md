# 플러그인 턴 종료 계약

- `PluginToolCall.conversationId`: 호스트가 부여한 호출 대화 ID. `subagents()`는 그 대화의 committed 작업자 상태를 읽는다. 직접 호출과 codemode 모두 같은 경계를 쓴다.
- `PluginInstance.onTurnEnd(turn)`: 최상위 대화의 최종 답 시점에 호출한다. `turn`은 conversationId, cwd, subagents, openHumanAsks, runningDagRuns를 담는다. 첫 비어 있지 않은 문자열이 호스트 이어 가기 메시지가 된다.
- `loadPlugin`은 훅의 this를 보존한다. 훅이 없는 기존 플러그인은 변하지 않는다. 예외는 보고하고 턴 종료를 허용한다.
- 입력당 최대 3회이며 도구 호출 없이 이어 간 턴 뒤에는 중단한다. 서브에이전트 대화에는 호출하지 않는다. 호스트 wake는 원래 입력의 예산을 이어 쓴다.
- `maxDurationMs`는 codemode 대기 예산이다. PM 검사는 최대 900초이며 도구 예산은 945초, 전체 셀 상한 960초 이내다.

[PM 구조](../architecture/pm.md) · [ADR 0105](../decisions/0105-pm-ledger-plugin.md)
