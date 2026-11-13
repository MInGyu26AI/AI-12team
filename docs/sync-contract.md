# 계정 동기화 약속 ("프로젝트만 수집")

ChatGPT 동기화 갈래 1~8이 함께 지키는 약속입니다. 설계와 이유는 [design-chatgpt-sync.md](design-chatgpt-sync.md)에 있습니다(17장이 확정 사항). **이 문서와 설계 문서가 어긋나면 이 문서를 따릅니다.**

- 기준 커밋은 `6342111`(확장 0.2.7)입니다. 갈래는 이 약속 커밋 위에서 시작합니다.
- 약속은 리드만 바꿉니다. 갈래가 약속을 바꿔야 하면 리드에게 요청합니다.
- 구현 전 확인(P1~P11) 결과로 약속이 바뀔 수 있습니다. 바뀌면 리드가 이 문서와 관련 갈래에 알립니다.
- 이번 판은 시연(11/15 동결)에 맞춰 줄인 범위입니다. 미룬 것은 9장에 이유와 함께 적었습니다.

## 1. 약속 파일

| 파일 | 내용 | 구현 갈래 |
|---|---|---|
| `shared/collector.ts` | `CollectedMessage.createdAt?`·`origin?`·`turnId?`, `MessageOrigin` | 1, 2 |
| `shared/bridge.ts` | `ExtStatus.syncWindows?`·`accountSync?`, `SyncWindow`, `AccountSyncState`, `ExtSettingsPatch.accountSync?`, `EXT_SYNC_NOW`·`SyncNowParams`·`SyncNowResult` | 1, 3, 7 |
| `shared/chatgpt-conversation.ts` | 원본 타입, `normalizeConversation`, `turnsInWindows`. 지금은 Error를 던지는 자리표시입니다 | 2 |
| `extension/lib/messages.ts` | `BgRequest`의 `syncNow`·`syncSet`, 탭 메시지 `TabSyncRequest`·`TabSyncResult`·`TabSyncError` | 2, 3, 4, 5 |
| `extension/lib/chatgpt-sync/state.ts` | `SyncState`, `syncStateItem`, 팀 고정값 | 3 (4는 읽기만) |
| `extension/tests/fixtures/chatgpt/*.json` | 합성 픽스처와 기대값 | 2, 8 |

## 2. 메시지 필드 (`CollectedMessage`)

| 필드 | 화면 경로 | 동기화 경로 |
|---|---|---|
| `id` | 지금 그대로 | `chatgpt:<message.id>` |
| `site` | `chatgpt` | `chatgpt` |
| `conversationId` | 대화 id | 대화 id |
| `origin` | 보내지 않음 (= `screen`) | `sync` |
| `createdAt` | 보내지 않음 | 메시지 시각 (6장 "시각") |
| `turnId` | 보내지 않음 | 그 턴의 사용자 메시지 id (접두사 없음) |
| `collectedAt` | 보낸 시각 | **`createdAt`과 같은 값** |
| `conversationTitle` | 지금 그대로 | 보내지 않음 |

동기화 경로의 `collectedAt`을 `createdAt`과 같게 두는 이유가 있습니다. 분류기(`ai/syncup_ai/classify.py`의 `_when`·`source_of`)는 `collectedAt`을 프롬프트 시각과 출처 라벨로 씁니다. 그래서 따라잡기로 가져온 옛 대화에도 실제 대화 시각이 찍혀야 합니다. 받은 시각은 수집기 `intake.received`에 따로 남습니다.

## 3. 수집기 RPC (갈래 1, `collector/`)

모두 추가 동작이라 옛 확장과 웹은 그대로 동작해야 합니다. 시험은 `checks/check_sync_intake.py`에 둡니다. `checks/run_checks.py` 등록은 리드가 합칠 때 합니다.

### 3-1. `collection.configure`의 `accountSync`

`CONFIGURABLE`에 `accountSync`를 더합니다. 값은 `{enabled: bool, account?: str}`입니다. 상태는 `integration_settings`의 options JSON에 `accountSync: {enabled, account, since}`로 저장합니다(`read_options`·`write_options`). 새 표는 만들지 않습니다.

- **켜기** `{enabled: true, account}`
  - `account`는 소문자 hex 64자여야 합니다. 아니면 `동기화 계정 오류`를 냅니다.
  - `since`에 지금 시각(Unix 초)을 넣고 `account`를 저장합니다. 이미 켜져 있으면 `since`를 바꾸지 않고 `account`만 덮어씁니다.
  - 계정이 맞는지는 확장이 확인합니다(5장). 수집기는 저장만 합니다.
- **끄기** `{enabled: false}`
  - `enabled=false`로 바꾸고 `since=null`로 둡니다. `account`는 남깁니다.

### 3-2. `collection.status`의 `syncWindows`·`accountSync`

`accountSync`는 `{enabled, account, since(ISO|null)}`입니다. 한 번도 켠 적 없으면 `null`입니다.

`syncWindows` 계산은 갈래 1이 `collector/collection_settings.py`의 `sync_windows(c, session)` 하나로 만듭니다. `turns.append`도 같은 함수를 씁니다.

1. 꺼져 있으면 `[]`입니다.
2. 바탕 구간은 `[max(세션 시작, since), settings.end)`입니다.
3. 바탕 구간에서 `pauses` 표의 구간을 뺍니다. `pauses`는 `storage.py`에 있고, `collection_session.set_paused`와 `collection_settings._set_end`가 기록합니다. `end IS NULL`인 일시정지는 `[start, ∞)`로 봅니다.
4. 남은 조각을 시작 순으로 늘어놓고, 길이 0인 조각은 뺍니다.

모든 조각은 반열린 구간 `[start, end)`이고 `end`는 늘 값이 있습니다. 수집 중이면 마지막 조각의 끝은 수집 종료 시각입니다.

### 3-3. `turns.append`

**서명은 바꾸지 않습니다.** `{messages, flush?}`이고 `local_rpc.py`도 고치지 않습니다.

**`clean_message` (C2).** 새 필드는 `MESSAGE_FIELDS`(필수)에 넣지 않습니다. `roleGuessed`처럼 값이 있을 때만 검사하고 저장합니다.

- `origin`: 없거나 `'screen'`·`'sync'`입니다.
- `createdAt`: 시간대가 있는 ISO 문자열입니다.
- `turnId`: 1~1200자 문자열입니다.
- `origin='sync'`이면 `createdAt`·`turnId`가 필수이고 `site='chatgpt'`여야 합니다.
- 어기면 지금처럼 `invalid_message`로 격리합니다.

**처리 순서.** 한 호출 안에서 이 순서대로 합니다.

1. `clean_message`. 틀린 메시지는 격리합니다(지금 그대로).
2. **C3 창 판단.** `origin='sync'` 메시지를 (`conversationId`, `turnId`)로 묶습니다.
   - 턴 안 `createdAt`의 최소와 최대가 `sync_windows`의 같은 조각 `[start, end)` 안에 있어야 합니다(`start ≤ 최소`, `최대 < end`).
   - 창 밖 턴은 저장하지도 격리하지도 않고 `outsideWindow`에 셉니다. 창 밖 턴은 아래 단계를 거치지 않습니다.
3. **C4-b 화면이 받은 턴.** 사용자 메시지 `chatgpt:<turnId>`의 intake 행이 이미 있는지 봅니다.
   - 행이 없으면 4로 갑니다.
   - 같은 대화에서 그 행보다 rowid가 큰 화면 경로(origin 없음 또는 `screen`) assistant 행이 있으면, 이 턴 전체를 받지 않고 `skippedTurns`에 셉니다.
   - 그런 행이 없고 사용자 행이 아직 묶이지 않았으면(`job IS NULL`), 그 행의 message JSON에 `turnId`만 채웁니다. 본문은 바꾸지 않습니다. 그다음 답변만 4로 보내고, 질문은 4에서 중복이 됩니다.
     - 이유: `ai/syncup_ai/batch.py:19-20`은 `turnId`가 같은 발화끼리만 한 턴으로 묶습니다. 질문 행에 `turnId`가 없으면 질문과 답이 갈라집니다.
   - 사용자 행이 이미 묶였으면 이 턴을 받지 않고 `skippedTurns`에 셉니다. 질문은 이미 분류됐고, 답만 따로 넣으면 질문 없는 턴이 됩니다.
4. **C4-a 저장.** 메시지마다 지금 `store_messages`처럼 처리합니다. 같은 intake id가 이미 있을 때만 판단이 바뀝니다.
   - origin이 다르면(없음 = `screen`) 중복입니다. 격리하지 않고 먼저 저장된 행을 남깁니다.
   - origin이 같고 본문·화자가 다르면 지금처럼 `message_changed`로 격리합니다.

**응답.** 지금 필드에 다음을 더합니다. 화면 경로 호출에서는 모두 0입니다.

```
{ newMessages, queued, intakeIssues, outsideWindow: int, skippedTurns: int, newTurns: int }
```

- `newTurns`는 새로 저장된 메시지가 하나 이상인 동기화 턴 수입니다.
- `queued`는 지금 의미 그대로입니다(`bool(clean)`).

## 4. 탭 메시지 (갈래 2가 답하고 갈래 3이 부름)

타입은 `extension/lib/messages.ts`에 있습니다.

- 콘텐츠 스크립트(`ai-chat.content.ts`)는 `type`이 `sync.`로 시작하는 메시지만 `extension/lib/sites/chatgpt-api.ts`에 넘기고, `sendResponse`로 답합니다.
- 응답에는 매번 `account`를 붙입니다. 값은 `sha256(UTF-8(session.user.id))`의 소문자 hex입니다. 필드는 P6 결과에 따라 바뀔 수 있습니다.

| 요청 | 탭이 하는 일 | `data` |
|---|---|---|
| `sync.session` | `GET /api/auth/session` | `null` |
| `sync.projects` | `GET /backend-api/gizmos/snorlax/sidebar` | `SyncProject[]` |
| `sync.projectPage` | `GET /backend-api/gizmos/{gizmoId}/conversations?cursor=` | `{items, nextCursor}` |
| `sync.conversation` | `GET /backend-api/conversation/{id}` → `normalizeConversation` → `turnsInWindows` → `CollectedMessage[]` | `{messages, inProgress, skippedNoTime}` |

**필수 필드.** 아래 필드가 없거나 타입이 다르면 `shape_changed`입니다. `normalizeConversation`이 던진 Error도 `shape_changed`입니다.

| 응답 | 필수 필드 |
|---|---|
| 세션 | `accessToken`, `user.id`. `accessToken`이 없으면 `logged_out` |
| 사이드바 | `items[].gizmo.gizmo.id`, `items[].gizmo.gizmo.display.name` |
| 프로젝트 대화 목록 | `items[].id`, `items[].update_time` |
| 대화 상세 | `mapping` |

**인증.**
- `accessToken`을 메모리에 두고 `Authorization: Bearer`로 붙입니다.
- 401을 받으면 토큰을 한 번 다시 받아 다시 시도합니다. 그래도 401이면 `logged_out`입니다.

**오류 분류.**

| 응답 | 오류 |
|---|---|
| 429 | `rate_limited`. `Retry-After` 초를 `retryAfterSec`에 넣습니다 |
| 403, 봇 확인 HTML | `forbidden` |
| 404 | `not_found` |
| fetch 예외, 5xx | `network` |

**`updateTime`.** 숫자(초)와 ISO 문자열이 섞여 옵니다. 둘 다 ISO로 바꿉니다.

**밖으로 내보내지 않는 것.** 원본 JSON, 제목, 토큰은 탭 밖으로 내보내지 않습니다. 보관한 대화도 목록에 그대로 담고, 거르는 일은 패스가 합니다.

**본문 길이.** 20000자가 넘으면 19999자까지 남기고 끝에 `…`을 붙입니다. 수집기 한도는 `turn_intake.py`의 `MAX_MESSAGE_TEXT`입니다.

## 5. 동기화 상태와 패스 (갈래 3)

상태는 `extension/lib/chatgpt-sync/state.ts`의 `SyncState`이고, 팀 고정값도 같은 파일에 있습니다. 패스는 수집기를 `rpc`로 직접 부릅니다. 기존 `append-turns.ts`는 쓰지 않습니다(`account`·창 결과가 없고 끝에 `refresh`를 부르기 때문입니다).

**`syncSet`.** 팝업에서만 받습니다.

- **켬**
  1. `sync.session`으로 계정 해시를 받습니다.
  2. `rpc('collection.status')`에 `accountSync` 키가 없으면 옛 수집기로 보고 거절합니다.
  3. `collection.configure({accountSync: {enabled: true, account}})`를 보냅니다.
  4. `SyncState`에 `enabled`, `project`, `account`, `enabledAt`, `mode='idle'`을 저장합니다.
  5. 패스를 한 번 돌립니다. 결과는 `{ok: true, result: SyncState}`입니다.
- **끔:** `{enabled: false}`를 보내고, `mode='off'`로 두고, 알람을 지웁니다.

**실패 문구.** 켬이 실패하면 `{ok: false, error}`로 돌려줍니다. 팝업은 받은 문구를 그대로 보여 줍니다.

| 경우 | 문구 |
|---|---|
| 응답하는 chatgpt.com 탭 없음 | `chatgpt.com 탭을 하나 열어 두세요` |
| `logged_out` | `ChatGPT에 로그인하세요` |
| 옛 수집기 | `수집기를 새 버전으로 바꾸면 쓸 수 있어요` |
| 수집기 오류 | 수집기가 준 문구 그대로 |
| 프로젝트를 고르지 않음 | `프로젝트를 고르세요` |

**`syncProjects`.** 팝업에서만 받습니다. 대표 탭에 `sync.projects`를 보내 `SyncProject[]`를 돌려줍니다. 탭이 없거나 로그아웃이면 위 표의 문구를 씁니다. 동기화가 꺼져 있어도 됩니다(켜기 전에 고르므로).

**`teamRecord`.** 채팅 화면과 팝업에서 받습니다. 수집기에 `team.board`와 `team.conflicts`를 부르고 `{board, conflicts}`(`TeamRecordRaw`)를 그대로 돌려줍니다. 수집기 오류 문구는 그대로 넘깁니다. 처리는 갈래 3(`background.ts`)이 하고, 변환은 갈래 5(`team-record.ts`)가 합니다.

**대표 탭.**
- 콘텐츠 스크립트가 응답하는 chatgpt.com 탭을 고릅니다. 활성 탭을 먼저 고르고, 없으면 마지막으로 응답한 탭입니다.
- 요청마다 20초 시간 제한이 있습니다.
- 응답이 없거나 채널이 닫히면 `network`로 봅니다.

**패스.** 한 번에 하나만 돕니다.

1. **멈춤 확인.** 아래 경우에는 `mode='stopped'`로 두고 끝냅니다.
   - 수집이 일시정지됐거나 끝남: `collection_paused`
   - 탭 없음: `no_tab`
   - 로그아웃: `logged_out`
   - `sync.session`의 `account`가 `SyncState.account`와 다름: `account_mismatch`
   - `shape_changed`
2. **창 읽기.** `rpc('collection.status')`의 `syncWindows`를 읽습니다. 비었으면 끝냅니다.
3. **대상 고르기.** `pending`이 비었으면 고른 프로젝트 목록을 쪽마다 읽습니다.
   - 실효 커서는 `max(syncWindows[0].start, cursor)`입니다(날짜로 비교).
   - 커서보다 오래된 항목이 나오면 다음 쪽은 읽지 않습니다.
   - `updateTime ≥ 실효 커서`이고 보관되지 않은 대화를 `pending`에 넣습니다. 같은 id는 한 번만 넣습니다.
   - 이때 `pendingPassStartedAt`에 지금 시각을 적습니다.
4. **대화 상세.** `pending` 앞에서부터 최대 20건을 `sync.conversation(id, syncWindows)`로 받습니다. 요청 사이에는 1~2초를 무작위로 둡니다.
   - 받은 메시지는 200개씩 `rpc('turns.append', {messages})`로 보냅니다. `flush`는 보내지 않습니다.
   - `outsideWindow`와 `newTurns`를 더합니다.
   - 끝난 대화는 `pending`에서 뺍니다.
   - `not_found`인 대화는 건너뜁니다.
   - `inProgress`이거나 `network` 오류인 대화는 이번 패스의 "남김"으로 표시하고 `pending`에서 뺍니다.
5. **커서.** 커서는 아래 셋이 모두 맞을 때만 `pendingPassStartedAt − 10분`으로 올립니다.
   - `pending`이 비었습니다.
   - 이 묶음에서 "남김"이 하나도 없었습니다.
   - `rate_limited`나 `forbidden` 없이 끝났습니다.

   커서를 못 올리면 다음 패스가 같은 범위를 다시 봅니다. 수집기가 중복을 거릅니다.
6. **쉼.**
   - `rate_limited`: `retryAfterSec`, 없으면 30분 동안 `mode='rest'`
   - `forbidden`: 120분 동안 `mode='rest'`

   쉬는 동안의 알람과 `syncNow`는 패스를 건너뜁니다.

**알람.**
- 알람 이름은 `chatgpt-sync`이고 5분마다 울립니다.
- `background.ts`의 `onAlarm`(지금 76-77행)은 알람 이름으로 나눕니다. `refresh` 30초는 그대로 둡니다.
- 서비스 워커가 시작될 때 켜져 있는데 알람이 없으면 다시 만듭니다.
- 브라우저를 시작할 때(`onStartup`) 패스를 한 번 돌립니다.

**`syncNow`.**
- 확장 안의 `BgRequest` `syncNow`와 웹 브리지의 `rpc` `method === EXT_SYNC_NOW`가 같은 함수로 갑니다.
- 받는 출처는 채팅 화면(`fromChat`), 팝업, 신뢰한 웹 출처입니다. `background.ts`의 출처 확인(16-20행)에 `syncNow`를 더합니다. 웹 요청은 수집기로 넘기지 않습니다.

처리 순서:

1. 패스를 돌리고 결과를 `sync`에 담습니다.

   | 상태 | `sync` 값 |
   |---|---|
   | 꺼짐 | `off` |
   | 쉼 | `resting` |
   | 탭 없음 | `no-tab` |
   | 이미 도는 중 | `busy` (끝날 때까지 기다리지 않음) |
   | 그 밖의 멈춤·예외 | `failed` |
   | 정상으로 돔 | `ran` |

2. `sync` 값과 상관없이, 수집 중이면 `collection.flush`를 부릅니다. 수집 중이 아니면 `flushed=false`이고 `blockedReason`에 `sendBlockedReason` 문구를 넣습니다.
3. 결과는 `SyncNowResult`입니다.

## 6. 공용 파서 규칙 (갈래 2)

기준은 픽스처입니다. `conversation-basic.json`을 넣으면 `expected-basic.json`, `conversation-in-progress.json`을 넣으면 `expected-in-progress.json`이 나와야 합니다.

**줄기.**
- `current_node`에서 `parent`를 따라 올라간 뒤 뒤집습니다.
- `current_node`가 없으면 자식이 없는 노드 가운데 `create_time`이 가장 늦은 것을 끝점으로 씁니다.
- 연결이 돌면 Error입니다.

**빼는 메시지.**
- 역할이 user도 assistant도 아닌 것
- `recipient`가 **있고**(undefined가 아님) null도 `'all'`도 아닌 것
- `content_type`이 `code`, `execution_output`, `tether_*`, `user_editable_context`, `model_editable_context`, `thoughts`, `reasoning_recap`인 것
- `is_visually_hidden_from_conversation`이나 `is_thinking_preamble_message`가 참인 것
- 아래 본문 규칙을 적용한 뒤에도 본문이 공백뿐인 것 (역할 상관없음)

**본문.**
1. 문자열 part를 `\n`으로 잇습니다.
2. `multimodal_text`면 `audio_transcription` part의 `text`도 넣습니다.
3. 그 밖에 문자열이 아닌 part가 N개(1 이상)면 맨 앞에 `[첨부 N개]` 줄을 둡니다.
4. 본문이 비면 `metadata.model_dil_v2.fallbackMarkdown`을 씁니다.
5. `content_references[].matched_text`를 모두 지우고 앞뒤 공백을 다듬습니다.

**턴.**
- 사용자 메시지마다 새 턴을 엽니다. `turnId`는 그 사용자 메시지의 id입니다.
- 첫 사용자 메시지 앞에 답변이 있으면, 첫 답변 id를 `turnId`로 하는 턴으로 묶습니다.
- 답변 노드가 여러 개여도 합치지 않습니다.

**완료.** 턴의 마지막 assistant 메시지로 판단합니다.
- `status === 'in_progress'`면 미완료입니다.
- 그 밖에는 아래 셋 가운데 **하나라도** 참이면 완료입니다. `status`의 다른 값은 판단에 쓰지 않습니다.
  - `metadata.is_complete === true`
  - `end_turn === true`
  - `metadata.finish_details.type`이 `stop`, `interrupted`, `max_tokens` 가운데 하나
- 답변이 없는 턴은 미완료입니다.
- 마지막 턴이 미완료면 `inProgress = true`입니다. 이 규칙은 P7 결과에 따라 바뀔 수 있습니다.

**시각.**
- `createdAt = new Date(Math.round(create_time * 1000)).toISOString()`입니다.
- 메시지 하나라도 시각이 없으면 그 턴의 `start`·`end`는 `null`입니다.

**`turnsInWindows(turns, windows)`.** 다음을 모두 만족하는 턴만 남깁니다.
- 완료된 턴
- 시각이 있는 턴
- `start`와 `end`가 같은 조각 `[start, end)` 안에 있는 턴

**확장이 보내는 값.** 탭 클라이언트가 정규화 결과를 `CollectedMessage`로 바꿉니다.
- 메시지 id에 `chatgpt:` 접두사를 붙입니다.
- `origin='sync'`로 둡니다.
- `collectedAt`은 `createdAt`과 같은 값입니다.

**웹 내보내기 (갈래 2).** `web/src/lib/chatgpt-export.ts`도 이 파서를 씁니다(`normalizeConversation`만, `turnsInWindows`는 쓰지 않음).
- `readChatGPTExport`의 결과 모양(`ExportConversation`, `Utterance`)과 정렬은 그대로 둡니다.
- 시각이 없는 메시지는 지금처럼 대화 시각, 그다음 지금 시각으로 채웁니다.
- 생성 중·미완료 턴도 내보내기에서는 그대로 넣습니다(파일은 이미 끝난 대화라서).
- 바뀌는 결과: 도구·생각·숨김 메시지가 빠지고, 첨부만 있는 사용자 메시지가 `[첨부 N개]`로 들어오고, 인용 표시가 지워집니다. 웹 시험에 이 차이를 하나씩 넣습니다.

## 7. 갈래와 파일

다른 갈래의 파일은 고치지 않습니다. 필요하면 리드에게 요청합니다.

| # | 갈래 | 고치는 파일 | 기대는 것 | 모델 |
|---|---|---|---|---|
| 1 | 수집기 | `collector/turn_intake.py`, `collector/collection_settings.py`, `collector/collection_status.py`, `checks/check_sync_intake.py` | 약속 | 리드 모델 |
| 2 | 탭 | `shared/chatgpt-conversation.ts`, `extension/lib/sites/chatgpt-api.ts`(새), `extension/entrypoints/ai-chat.content.ts`(`sync.*`만), `web/src/lib/chatgpt-export.ts`(공용 파서 사용), 시험 | 약속 | sonnet xhigh |
| 3 | 패스·스케줄러 | `extension/lib/chatgpt-sync/*`(`state.ts`의 타입은 약속), `extension/entrypoints/background.ts`, 시험 | 약속 (2·1은 가짜로 시험) | 리드 모델 |
| 4 | 팝업 | `extension/entrypoints/popup/*`, `extension/lib/settings.ts`, 시험. 프로젝트만 수집 스위치·프로젝트 고르기·동의 문구, 싱크 맞추기 버튼, "N회마다" 조절 제거, 화면 구조 경고 자리, 레포 상태 자리 | 약속 | sonnet xhigh |
| 5 | 채팅 화면 | `extension/lib/chat-overlay.ts`, `extension/lib/team-record.ts`(새), `shared/board-markdown.ts`(웹에서 옮김), `web/src/lib/board-markdown.ts`(공용을 다시 내보내기만), 시험 | 약속 | sonnet xhigh |
| 6 | 감지·알림 | `extension/lib/extract-health.ts`(새), `extension/lib/candidate-notice.ts`(새), `extension/wxt.config.ts`, 시험. 2·3을 합친 뒤에는 연결부(`ai-chat.content.ts`, `background.ts`, `collector-status.ts`)도 맡습니다 | 약속, 연결부는 2·3 | sonnet xhigh |
| 7 | 웹 | `web/src/app/(app)/review/page.tsx`, `web/src/app/(app)/collect/page.tsx`, `web/src/lib/rpc.ts`, 시험 | 약속 | sonnet xhigh |
| 8 | e2e | `~/.cache/syncup-e2e` (저장소 밖) | 1~6 | sonnet xhigh |

**e2e 시나리오(갈래 8).** 아래 넷만 가짜 서버로 만듭니다. 429·403 쉼은 갈래 3의 단위 시험에서 다룹니다.
1. 회의록 7장 시연 흐름: 프로젝트 대화 → 싱크 맞추기 → 후보 → 승인
2. 화면 경로와 겹치는 턴(C4-a·b)
3. 창 경계: 켜기 전 대화와 일시정지 중 대화가 들어오지 않음
4. 여러 대화를 동시에

**합치는 순서.** 1 → 2 → 3 → 4·5 → 6(연결부 포함) → 7 → 8. 합칠 때마다 다음 넷을 돌립니다.
- `npx tsc --noEmit -p extension`
- `cd extension && npx vitest run`
- `npm --prefix web test`
- 수집기 `checks/`

**공통 규칙.**
- `lib/sites/chatgpt.ts`와 `lib/auto-collect.ts`는 고치지 않습니다.
- 확장 버전(`extension/package.json`)과 ZIP은 리드가 마지막에 올립니다.
- `checks/run_checks.py` 등록도 리드가 합니다.
- `wxt build`는 `~/Documents` 밖 worktree에서만 돌립니다.
- `~/syncup-demo`와 `~/syncup-demo-run`은 건드리지 않습니다.
- 보고는 RULES.md 형식으로 합니다(내가 할 일 / 변경 사항 / 발견 사항). 팀원 원본 줄을 바꿨다면 표(파일, 줄, 이전, 이후, 이유)를 붙입니다.

## 8. 웹 쪽 결정 (11/13 동균 님: 넣음)

- **웹 내보내기:** 공용 파서로 바꿉니다(갈래 2, 6장 "웹 내보내기").
- **팀 기록 형식:** `boardToMarkdown`을 `shared/board-markdown.ts`로 옮깁니다(갈래 5). `web/src/lib/board-markdown.ts`는 공용 함수를 다시 내보내기만 해서 웹 import는 그대로 둡니다. 출력 문자열은 바꾸지 않습니다.
- **팝업 'GitHub 레포 상태' 자리:** 갈래 4가 `{name, lastSavedAt} | null`을 받는 표시 부품만 만듭니다. 데이터 출처(GitHub 연동, `feat/github-sync`)가 정해질 때까지 `null`을 넣어 아무것도 그리지 않습니다. 약속 타입은 더하지 않습니다.
- **갈래 7(웹):** 합치는 순서에 둡니다. Vercel 재배포가 있어야 사용자에게 닿습니다(단비 님 권한).

## 9. 다음 단계로 미룬 것 (11/13 동균 님 결정)

| 미룬 것 | 이번 판의 대신 | 다음 단계에서 할 일 | 지금 남는 한계 |
|---|---|---|---|
| 동기화 켬·끔 구간 기록(설계 4장) | `since` 하나 | `account_sync` 구간 표. 기존 상태 폴더에서도 생기도록 `ensure_pipeline_schema`의 이른 return 앞에 둡니다 | 껐다 켜면 창이 마지막으로 켠 시각부터만 열립니다. 앞서 켜 둔 동안의 대화는 그때 이미 받았으므로 동의 원칙은 지켜집니다. 다만 그때 못 받은 대화(탭이 없었음 등)는 다시 따라잡지 못합니다 |
| 수집기 계정 확인(C7) | 확장이 패스마다 계정을 비교합니다 | `turns.append`의 `account` 인자를 `local_rpc.py:50`부터 넘기고, 불일치를 거절합니다 | Chrome 프로필이 여럿이고 다른 확장 설치본이 같은 수집기를 쓰면, 다른 계정의 동기화가 섞일 수 있습니다 |
| C4-c 화면 행 시각 채우기 | `turnId`만 채웁니다(C4-b 답변만 받는 경우) | 묶이지 않은 화면 행에 `createdAt` 채우기 | 화면 경로 행은 서버 시각이 아니라 보낸 시각을 씁니다 |
| C5 시각 순 정렬(`batch_queue.unbatched_turns`) | rowid(도착) 순 | 대화 안을 `createdAt` → `collectedAt` → rowid 순으로 | 늦게 따라잡은 앞쪽 턴이 뒤에 붙을 수 있습니다(실시간 시연에서는 드묾) |
| 활발/조용 주기, touch, 쉼 두 배 늘리기 | 5분 고정, 싱크 맞추기, 쉼은 Retry-After·30분·120분 | 활발 2분(P5 통과 시 1분), 조용 5분, 화면 수집 뒤 5초 패스, 쉼 두 배(최대 2시간) | 휴대폰 대화는 최대 5분 늦게 들어옵니다. 429가 거듭되면 같은 간격으로 다시 시도합니다 |
| 분류기가 `createdAt`을 시각으로 쓰기 | 동기화 `collectedAt` = `createdAt` | `classify.py`의 `_when`이 `createdAt`을 우선하도록(하은 님 파일) | 없음. 받은 시각은 `intake.received`에 있습니다 |
| 스캐너와 창 경계 맞추기 | 수집기는 반열린 `[start, end)` | `scanner/src/review_db.rs:82-92`는 양끝 포함입니다. 한쪽으로 맞춥니다 | 경계에 정확히 걸친 턴은 두 경로에서 판정이 다를 수 있습니다 |
| 계정 전체 동기화, 고정 동반 탭, WebSocket 신호 | 프로젝트만 수집, 사용자 탭 | 설계 3·5장 | — |
