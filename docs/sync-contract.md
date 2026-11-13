# 계정 동기화 약속 ("프로젝트만 수집")

ChatGPT 동기화 갈래 1~10이 함께 지키는 약속입니다. 설계와 이유는 [design-chatgpt-sync.md](design-chatgpt-sync.md)에 있습니다(17장이 확정 사항). 이 문서와 설계 문서가 어긋나면 이 문서를 따르고, 리드에게 알립니다.

- 기준: 확장 0.2.7, 커밋 `6342111`. 이 약속 커밋 위에서 갈래를 시작합니다.
- 이 문서를 바꿀 수 있는 사람은 리드뿐입니다. 갈래는 약속을 바꾸지 않고, 바꿔야 하면 리드에게 요청합니다.
- 구현 전 확인(P1~P11)의 결과로 약속이 바뀔 수 있습니다. 바뀌면 리드가 이 문서와 관련 갈래에 알립니다.

## 1. 약속 파일

| 파일 | 내용 | 구현 갈래 |
|---|---|---|
| `shared/collector.ts` | `CollectedMessage`의 `createdAt?`·`origin?`·`turnId?`, `MessageOrigin` | 1(수집기), 4(보냄) |
| `shared/bridge.ts` | `ExtStatus.syncWindows?`·`accountSync?`, `SyncWindow`, `AccountSyncState`, `ExtSettingsPatch.accountSync?`, `EXT_SYNC_NOW`·`SyncNowParams`·`SyncNowResult` | 2, 5, 9 |
| `shared/chatgpt-conversation.ts` | 원본 타입, `normalizeConversation`, `turnsInWindows` (빈 함수) | 3 |
| `extension/lib/messages.ts` | `BgRequest`의 `syncNow`·`syncSet`, 탭 메시지 `TabSyncRequest`·`TabSyncResult`·`TabSyncError` | 4, 5, 6, 7 |
| `extension/lib/chatgpt-sync/state.ts` | `SyncState`, `syncStateItem`, 팀 고정값 | 5 (6은 읽기만) |
| `extension/tests/fixtures/chatgpt/*.json` | 합성 픽스처와 기대값 | 3, 4, 10 |

## 2. 메시지 필드 (`CollectedMessage`)

| 필드 | 화면 경로 | 동기화 경로 |
|---|---|---|
| `id` | 지금 그대로 | `chatgpt:<message.id>` |
| `site` | `chatgpt` | `chatgpt` |
| `conversationId` | 대화 id | 대화 id |
| `origin` | 보내지 않음 (= `screen`) | `sync` |
| `createdAt` | 보내지 않음 | `create_time`을 ISO로 바꾼 값 (UTC `Z`) |
| `turnId` | 보내지 않음 | 그 턴의 사용자 메시지 id (접두사 없음) |
| `collectedAt` | 보낸 시각 | 보낸 시각 |
| `conversationTitle` | 지금 그대로 | 보내지 않음 |

## 3. 수집기 RPC (갈래 1·2, `collector/`)

모두 추가 필드입니다. 옛 확장과 웹은 그대로 동작해야 합니다. 시험은 `checks/check_sync_intake.py`(갈래 1)와 `checks/check_sync_settings.py`(갈래 2)에 둡니다.

### 3-1. `turns.append` (갈래 1)

**받는 인자.** `{messages, flush?, account?}`

- `account`: 계정 해시(sha256 hex 64자)입니다. `origin='sync'` 메시지가 하나라도 있으면 필수입니다.

**`clean_message` 검사 (C2).**

- `origin`은 없거나 `'screen'` 또는 `'sync'`여야 합니다. 그 밖의 값이면 `invalid_message`입니다.
- `origin='sync'`이면 다음을 모두 지켜야 합니다. 어기면 `invalid_message`로 격리합니다.
  - `createdAt`: 시간대가 있는 ISO 문자열
  - `turnId`: 1~1200자 문자열
  - `site`: `'chatgpt'`
- `createdAt`과 `turnId`는 화면 경로에서 와도 형식이 맞으면 저장합니다.
- 저장하는 필드는 지금 허용 목록에 `createdAt`, `origin`, `turnId`를 더한 것입니다.

**계정 확인 (C7).** 다음 경우에는 저장 없이 오류를 돌려줍니다. 오류 문구는 `동기화 계정이 다릅니다.`입니다.

- `origin='sync'` 메시지가 있는데 동기화가 꺼져 있을 때
- `account`가 `accountSync.account`와 다를 때

이 경우에는 같은 호출에 든 화면 메시지도 받지 않습니다. 확장은 동기화 메시지를 화면 메시지와 따로 보냅니다.

**창 판단 (C3).**

1. `origin='sync'` 메시지를 (`conversationId`, `turnId`)로 묶습니다.
2. 턴 안 `createdAt`의 최소와 최대가 같은 동기화 창 한 구간 `[start, end)` 안에 있어야 받습니다(`end=null`이면 지금까지).
3. 창 밖 턴은 저장하지 않고, 격리하지도 않습니다. 응답의 `outsideWindow`에 턴 수를 셉니다.

**중복 (C4).** 비교는 `turn_intake.py`처럼 가린 뒤의 본문으로 합니다.

- **C4-a.** 같은 intake id인데 origin이 다르면 중복으로 봅니다. 격리하지 않고, 먼저 저장된 행을 남깁니다. 저장된 행에 origin이 없으면 `screen`으로 봅니다. origin이 같고 본문이 다르면 지금처럼 `message_changed`로 격리합니다.
- **C4-b.** 동기화 턴의 사용자 메시지(`chatgpt:<turnId>`)가 화면 경로로 이미 저장돼 있으면, 같은 대화에서 그 행 뒤에 화면 경로 assistant 행이 있는지 봅니다.
  - 있으면 그 턴 전체를 받지 않습니다. `skippedTurns`에 셉니다.
  - 없으면 답변만 받습니다. 질문은 C4-a로 중복입니다.
  - "그 행 뒤"는 intake 행 순서(rowid)로 판단합니다.
- **C4-c.** 화면 경로 행이 아직 묶이지 않았고(`job IS NULL`) 동기화 메시지가 같은 id면, 그 행에 `createdAt`만 채웁니다. 본문은 바꾸지 않습니다.

**응답.** 지금 필드에 다음을 더합니다.

```
{ newMessages, queued, intakeIssues, outsideWindow: int, skippedTurns: int }
```

화면 경로 호출에서는 둘 다 0입니다.

**C5 정렬 (권장, 갈래 1).** `batch_queue.unbatched_turns`에서 대화 안 순서를 정합니다.

- 정렬 기준: `createdAt`(날짜) → 없으면 `collectedAt` → 같으면 rowid
- 이미 묶인 행은 다시 묶지 않습니다.
- 묶음은 `turnId`가 있으면 그것으로 턴을 나눕니다(`ai/syncup_ai/batch.py` 동작 그대로).

### 3-2. `collection.configure` (갈래 2, C6)

`CONFIGURABLE`에 `accountSync`를 더합니다. 값은 `{enabled: bool, account?: str}`입니다.

| 요청 | 처리 |
|---|---|
| 켬 `{enabled: true, account}` | `account`는 sha256 hex 64자여야 합니다. 이미 다른 계정으로 켜져 있으면 `먼저 동기화를 끄세요.`로 거절합니다. 같은 계정으로 다시 켜면 아무 일도 하지 않습니다. 수집 중이 아니어도 켤 수 있지만, 창은 수집 기간과 겹치는 부분만 열립니다. |
| 끔 `{enabled: false}` | 지금 열린 구간을 닫습니다. |

- 켠 구간과 끈 구간은 새 표 `account_sync(start REAL, end REAL NULL, account TEXT)`에 기록합니다(`pipeline_schema`).
- 상태 폴더당 이 표 하나를 씁니다. 팀을 바꿔도 지우지 않습니다. 창 계산은 지금 세션의 수집 기간과 겹치는 부분만 씁니다.

### 3-3. `collection.status` (갈래 2, C8)

다음 둘을 더합니다(`ExtStatus` 타입).

- `syncWindows`
  - 계산: [세션 시작, 종료 시각) ∩ `account_sync` 구간들 − 일시정지 구간들. 시작 순으로 정렬하고, 빈 구간은 뺍니다.
  - 일시정지 구간은 `collection_settings`가 이미 기록하는 것을 씁니다.
  - 지금 열린 구간의 `end`는 `null`입니다. 단, 수집 종료 시각이 미래라도 지금이 수집 중이 아니면 `end`에 지금 시각을 넣습니다.
  - 한 번도 켠 적이 없으면 `[]`입니다.
- `accountSync`: `{enabled, account, since}`. 한 번도 켠 적이 없으면 `null`입니다.

`turns.append`의 C3 판단은 같은 계산 함수를 씁니다. 함수는 갈래 2가 `collector/collection_settings.py`에 `sync_windows(c, session)`으로 만듭니다. 갈래 1은 이 이름으로 가져다 씁니다. 갈래 2가 합쳐지기 전에는 같은 서명의 임시 함수로 시험합니다.

### 3-4. 옛 수집기

확장은 `collection.status`에 `syncWindows`가 없으면 동기화를 켜지 못하게 합니다. 이때 팝업 안내 문구는 "수집기를 새 버전으로 바꾸면 쓸 수 있어요"입니다.

## 4. 탭 메시지 (갈래 4가 답하고 갈래 5가 부름)

타입은 `extension/lib/messages.ts`에 있습니다.

- 콘텐츠 스크립트(`ai-chat.content.ts`)는 `type`이 `sync.`로 시작하는 메시지만 `extension/lib/sites/chatgpt-api.ts`에 넘기고, `sendResponse`로 답합니다.
- 응답마다 `account`(세션 사용자 식별자의 sha256 hex)를 붙입니다.

| 요청 | 탭이 하는 일 | `data` |
|---|---|---|
| `sync.session` | `GET /api/auth/session`. 토큰이 없으면 `logged_out` | `null` |
| `sync.projects` | `GET /backend-api/gizmos/snorlax/sidebar`. 이름과 id만 꺼냅니다 | `SyncProject[]` |
| `sync.projectPage` | `GET /backend-api/gizmos/{gizmoId}/conversations?cursor=` | `{items, nextCursor}` |
| `sync.conversation` | `GET /backend-api/conversation/{id}` → `normalizeConversation` → `turnsInWindows(windows)` → `CollectedMessage[]` | `{messages, inProgress, skippedNoTime}` |

**인증.**
- `accessToken`을 메모리에 두고 `Authorization: Bearer`를 붙입니다.
- 401이면 토큰을 한 번 다시 받고 다시 시도합니다. 그래도 401이면 `logged_out`입니다.

**오류 분류 (`TabSyncError`).**

| 응답 | 오류 |
|---|---|
| 429 | `rate_limited` (`Retry-After` 초를 `retryAfterSec`에) |
| 403, 봇 확인 HTML | `forbidden` |
| 404 | `not_found` |
| JSON 모양이 기대와 다름 (필수 필드 없음, 타입 다름) | `shape_changed` |
| fetch 예외, 5xx | `network` |

**밖으로 내보내지 않는 것.** 원본 JSON, 제목, 토큰은 탭 밖으로 내보내지 않습니다.

`isArchived`인 대화는 탭이 목록에 그대로 넣습니다. 거르는 것은 패스(갈래 5)의 일입니다.

## 5. 동기화 상태와 패스 (갈래 5)

상태는 `extension/lib/chatgpt-sync/state.ts`의 `SyncState`이고, `storage.local`의 `chatgptSync` 키에 둡니다. 팀 고정값도 같은 파일에 있습니다.

**`syncSet` 처리.** 백그라운드가 받습니다.

- **켬.**
  1. `sync.session`으로 계정 해시를 받습니다.
  2. 수집기에 `collection.configure({accountSync: {enabled: true, account}})`를 보냅니다.
  3. 성공하면 `SyncState`에 `enabled`, `project`, `account`, `enabledAt`을 저장하고 패스를 한 번 돌립니다.
- **끔.** 수집기에 `{enabled: false}`를 보내고, 상태를 `off`로 바꾸고, 알람을 지웁니다.

**패스.** 설계 3장의 "동기화 패스"를 따르되, 기본 목록 대신 고른 프로젝트 목록만 읽습니다(17-2).

- 커서 = max(동기화 창 시작, 마지막 완료 패스 시작 − 10분)
- 창은 매 패스 시작 때 `collection.status`의 `syncWindows`로 받습니다.
- 동기화 메시지는 `turns.append({messages, account})`로 200개씩 나눠 보냅니다. 화면 메시지와 섞지 않습니다.

**알람.** 이름은 `chatgpt-sync`입니다.

- `background.ts`의 `onAlarm`은 알람 이름으로 나눕니다. `refresh` 30초는 그대로 둡니다.
- 서비스 워커가 시작할 때 알람이 없으면 다시 만듭니다.

**touch.** 화면 경로 `collect` 요청을 받으면 `lastTouchAt`을 적고, 5초 뒤 패스를 한 번 돌립니다. 이미 예약돼 있으면 다시 예약하지 않습니다.

**`syncNow` 처리.** 확장 안의 `BgRequest`와 웹 브리지의 `rpc` `method: 'ext.syncNow'`가 같은 함수로 갑니다.

1. 켜져 있고 쉼이 아니면 패스를 한 번 돌립니다. 이미 돌고 있으면 `busy`이고, 그 패스가 끝날 때까지 기다리지 않습니다.
2. 수집 중이면 `collection.flush`를 부릅니다.
3. `SyncNowResult`를 돌려줍니다.

웹 브리지의 요청은 이미 `isTrustedWebOrigin`으로 거른 것만 백그라운드에 옵니다. 백그라운드는 `method === EXT_SYNC_NOW`이면 수집기로 넘기지 않고 직접 처리합니다.

## 6. 공용 파서 규칙 (갈래 3)

픽스처 `conversation-basic.json` → `expected-basic.json`이 기준입니다.

**줄기.** `current_node`에서 `parent`를 따라 올라가 뒤집습니다.
- `current_node`가 없으면 자식이 없는 노드 가운데 `create_time`이 가장 늦은 것을 끝점으로 씁니다.
- 연결이 돌면 Error입니다.

**빼는 메시지.**
- 역할이 user·assistant가 아닌 것
- `recipient`가 null도 `all`도 아닌 것
- `content_type`이 `code`, `execution_output`, `tether_*`, `user_editable_context`, `model_editable_context`, `thoughts`, `reasoning_recap`인 것
- `is_visually_hidden_from_conversation`이나 `is_thinking_preamble_message`가 참인 것
- 본문이 공백뿐인 assistant 메시지 (`fallbackMarkdown`이 있으면 그것을 본문으로 쓴 뒤 판단)

**본문.**
1. 문자열 part를 `\n`으로 잇습니다.
2. `multimodal_text`이면 `audio_transcription` part의 `text`도 넣습니다.
3. 문자열이 아닌 나머지 part 수 N이 1 이상이면 맨 앞에 `[첨부 N개]` 줄을 둡니다.
4. 본문이 비면 `metadata.model_dil_v2.fallbackMarkdown`을 씁니다.
5. `content_references[].matched_text`를 모두 지우고 앞뒤 공백을 다듬습니다.

**턴.**
- 사용자 메시지마다 새 턴을 엽니다. `turnId`는 그 사용자 메시지 id입니다.
- 첫 사용자 메시지 앞의 답변은 첫 답변 id를 `turnId`로 하는 턴입니다.
- 답변 노드가 여러 개여도 합치지 않습니다.

**완료.** 턴의 마지막 assistant 메시지로 판단합니다.

| 상태 | 판정 |
|---|---|
| `status === 'in_progress'` | 미완료 |
| `metadata.is_complete === true`, `end_turn === true`, `finish_details.type`이 `stop`·`interrupted`·`max_tokens` 중 하나 | 완료 |
| 그 밖의 경우 | 미완료 |

- 답변이 없는 턴은 미완료입니다.
- 미완료 턴이 마지막이면 `inProgress = true`입니다. P7 결과로 바뀔 수 있습니다.

**시각.**
- `create_time`(초)을 ISO(UTC, 밀리초까지 `toISOString`)로 바꿉니다.
- 메시지 하나라도 시각이 없으면 그 턴의 `start`와 `end`는 `null`입니다.

**`turnsInWindows`.**
- 완료됐고, 시각이 있고, `start`와 `end`가 같은 창 `[start, end)` 안에 있는 턴만 남깁니다.
- `end=null`인 창은 위쪽이 열려 있습니다.

**웹 내보내기 (`web/src/lib/chatgpt-export.ts`).**
- 이 파서로 바꿉니다. `Utterance` 모양과 정렬은 그대로 둡니다.
- 시각이 없는 메시지는 지금처럼 대화 시각, 그다음 지금 시각으로 채웁니다.
- 그래서 내보내기는 `turnsInWindows`를 쓰지 않습니다.

## 7. 갈래와 파일

다른 갈래의 파일은 고치지 않습니다. 필요하면 리드에게 요청합니다.

| # | 갈래 | 고치는 파일 |
|---|---|---|
| 1 | 수집기-접수 | `collector/turn_intake.py`, `collector/batch_queue.py`(C5), `checks/check_sync_intake.py` |
| 2 | 수집기-설정 | `collector/collection_settings.py`, `collector/collection_status.py`, `collector/pipeline_schema.py`, `checks/check_sync_settings.py` |
| 3 | 공용 파서 | `shared/chatgpt-conversation.ts`, `web/src/lib/chatgpt-export.ts`, 파서 시험 |
| 4 | 탭 클라이언트 | `extension/lib/sites/chatgpt-api.ts`(새), `extension/entrypoints/ai-chat.content.ts`(`sync.*`만), 시험 |
| 5 | 패스·스케줄러 | `extension/lib/chatgpt-sync/*`(`state.ts`의 타입은 약속), `extension/entrypoints/background.ts`, 시험 |
| 6 | 팝업 | `extension/entrypoints/popup/*`, `extension/lib/settings.ts`, 시험 |
| 7 | 채팅 화면 | `extension/lib/chat-overlay.ts`, `extension/lib/team-record.ts`(새), `shared/board-markdown.ts`(웹에서 옮김), `web/src/lib/board-markdown.ts`, 시험 |
| 8 | 감지·알림 | `extension/lib/extract-health.ts`(새), `extension/lib/candidate-notice.ts`(새), `extension/wxt.config.ts`, 시험 |
| 9 | 웹 | `web/src/app/(app)/review/page.tsx`, `web/src/app/(app)/collect/page.tsx`, `web/src/lib/rpc.ts`, 시험 |
| 10 | e2e | `~/.cache/syncup-e2e` (저장소 밖) |

**공통 규칙.**
- `lib/sites/chatgpt.ts`와 `lib/auto-collect.ts`는 아무 갈래도 고치지 않습니다.
- 갈래 8의 연결부(`ai-chat.content.ts`, `background.ts`, `collector-status.ts`)는 리드가 합칠 때 붙입니다.
- 확장 버전(`extension/package.json`)과 ZIP은 리드가 마지막에 올립니다.
- `wxt build`는 `~/Documents` 밖 worktree에서만 돌립니다.
- `~/syncup-demo`와 `~/syncup-demo-run`은 건드리지 않습니다.
- 보고는 내가 할 일 / 변경 사항 / 발견 사항 세 제목으로 합니다. 팀원 원본 줄을 바꿨으면 표(파일, 줄, 이전, 이후, 이유)를 붙입니다.
