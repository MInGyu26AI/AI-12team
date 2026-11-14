# 구조와 데이터 흐름

수집기·팀 서버·공용 계약·스캐너가 어떻게 이어지는지 정리한다.
실행은 [running.md](running.md), 팀 서버 운영은 [team-server.md](team-server.md), 개인정보 처리는 [privacy.md](privacy.md)에 있다.

## 1. 전체 흐름

```text
ChatGPT 화면 → 확장 → Native Messaging ─┐
웹 백업 입력(붙여넣기·내보내기 파일) ───┤ 로컬 RPC (확장 경유 또는 /api/local)
Codex·Claude Code 기록 → Rust 스캐너 ───┤
                                       ▼
Mac 로컬 수집기 (개인 DB <상태 폴더>/private.sqlite)
  발화 검사·저장 → 대화별 N턴 묶음 → 기기 안 개인정보 검사
  → 허용된 문장만 외부 AI 분류 (ai/) → 비공개 후보
  → 승인함(/review)에서 승인 → 전송 대기열 (내용·목적지 고정)
                                       ▼ HTTPS · 개인 연결 키
팀 서버 (PostgreSQL)
  키·소속·RLS 확인 → 승인 카드 저장 → 새 결정을 기존 결정과 한 쌍씩 충돌 검사 (ai/)
                                       ▼ team.* 로컬 RPC
팀 결정 기록(/board): 결정 타임라인 · 충돌 경고 · 할 일
```

## 2. 실행 모드

| | 통합 모드 (`--integrated`) | 팀 연결 단독 모드 |
|---|---|---|
| 입력 | 확장, 웹 백업 입력, Codex·Claude Code | Codex·Claude Code |
| 분류 | `batch_classification` → `ai/` | `standalone_classifier`가 OpenAI를 직접 부름 |
| 검토 화면 | 승인함(`/review`), Python 검토함 | Python 검토함 |
| 승인 형식 | v2 (공개 카드 필드 포함) | v1 (문구·근거·화자) |
| 충돌 검사 | 결정 카드가 대상 | 대상 아님 |

## 3. 로컬 수집기 처리 단계

통합 모드 기준. 모듈은 `collector/` 아래.

| 단계 | 하는 일 | 모듈 |
|---|---|---|
| 스캔 | 수집 기간 안에 끝난 새 턴의 사용자 발화·최종 답변 발췌 | `collection_loop.watch` → `scanner_runner.scan` |
| 받기 | 검사·가림(`ai/syncup_ai/mask.py`) 뒤 저장. 형식 오류·같은 ID의 바뀐 내용은 따로 보관 | `turn_intake` |
| 묶기 | 대화마다 N턴(기본 10, 1~50)을 작업 하나로. `flush`는 덜 찬 묶음도 ([턴 세기](../ai/README.md#2-대화-횟수-기준-묶기)) | `batch_queue` |
| 개인정보 검사 | 허용·제외·보류로 나눔 | `local_privacy` |
| 분류 | 허용된 문장만 외부 AI로. 직전에 `outbound_guard`와 수집 세션을 다시 확인 | `batch_classification` |
| 후보 | 관련(related)이고 표시가 제안(none)이 아닌 카드만 후보로. 실패하면 `failed_new`, 원문 보존 | `batch_classification` |
| 승인 | 소속 재확인, 내용·목적지(서버·사용자·팀)를 고정해 `outbox`에 | `candidate_review`, `delivery.approve` |
| 전송 | 1초마다 한 건씩 ([재시도](running.md#실패와-중단)) | `delivery.deliver` |
| 정리 | 기간 지난 원문·백업 ([보존](privacy.md#6-보존-7일)) | `retention` |

### 수집 루프

- `collection_loop.watch`는 한 번 처리하고 2초 쉰다. 수집 중일 때만 스캔·받기·분류한다.
- 분류는 한 번에 하나만 돈다. AI를 기다리는 동안 잠금을 잡지 않아 설정 변경·일시중지를 받는다.

## 4. 로컬 RPC

- 요청 `{version: 1, method, params}`, 응답 `{ok: true, result}` 또는 `{ok: false, error}`. 형식·조건 오류 400. 로컬 저장소 문제, 팀 서버 연결 실패와 팀 서버의 HTTP 오류(401·403·404·409 포함)는 503. 인증 실패는 403이고 본문은 `{error}`뿐이다(`ok` 없음).
- 통합 모드 수집기는 루프백 `POST /rpc`와 `connection.json`(주소·비밀값)을 만든다. Host `127.0.0.1:<포트>`, `Origin` 없음, 맞는 `Bearer` 비밀값만 받는다.

| 메서드 | 하는 일 |
|---|---|
| `collection.status` | 설정, 단계별 개수, 최근 묶음 20개, 로컬 모델 상태. 로컬 DB만 읽음 |
| `collection.configure` | 팀·주제·소주제·묶음 크기·종료 시각·자동 수집. 팀을 바꾸면 소속 확인 |
| `collection.pause` | 자동 수집 끄기 |
| `collection.flush` | 덜 찬 묶음까지 분류 대기로 |
| `turns.append` | 발화 1~200개 저장 |
| `intake.issues` | 처리하지 않은 보관 입력 |
| `intake.retry` | 고친 발화를 새 입력(`site: manual`)으로 분류 대기에 |
| `intake.dismiss` | 보관 입력을 제외로 기록 |
| `privacy.list` | 보류 묶음과 제외 발화 |
| `privacy.exclude` | 보류 묶음의 발화를 다음 검사에서 뺌 |
| `privacy.recheck` | 저장된 모델 판정을 지워 다시 검사 |
| `candidates.list` | 후보와 전송 상태 |
| `candidates.update` | 후보 수정, 화자 확인. 근거는 AI가 받은 발화 안에서만, AI 발화가 근거인 결정·할 일은 거절 |
| `candidates.dismiss` | 후보 제외 |
| `candidates.approve` | 1~100장 승인. 추정 화자는 먼저 확인. 하나라도 실패하면 전부 취소 |
| `jobs.retry` | 분류 실패 묶음을 지금 세션에서 다시 대기로 |
| `delivery.retry` | 멈춘(`blocked`) 전송을 같은 내용·목적지로 다시 넣음. 시도 횟수는 새로 셈 |
| `team.*` (`board`·`history`·`conflicts`·`conflictHistory`·`done`·`resolve`·`setDone`·`retryCheck`) | 연결된 팀의 팀 서버 API(`/teams/{팀}/…`)로 중계. 응답의 `team_id`가 다르면 오류 ([API 요청](team-server.md#api-요청)) |

- 목록은 현재 팀 것만 돌려준다. `intake.retry`·`intake.dismiss`·`privacy.exclude`·`privacy.recheck`·`candidates.approve`는 요청의 `teamId`가 현재 팀과 같아야 하고, `jobs.retry`·`delivery.retry`는 `teamId`를 주면 확인한다. `collection.configure`의 `teamId`는 팀 변경이고, 나머지는 `teamId`를 보지 않고 연결된 팀에 대해 처리한다.
- `collection.flush`·`turns.append`·`intake.retry`·`jobs.retry`는 수집 중일 때만 된다.

## 5. 팀 서버와 충돌 검사

v2 결정 카드(tag=decision)만 검사 대기(`conflict_checks`)에 들어간다.

### 충돌 검사가 도는 방식

- 상시 작업자는 없다. 팀 경로 요청이 성공하면 팀마다 작업자 하나를 띄우거나 깨운다. 남은 검사가 없으면 끝난다.
- 새 결정을 그보다 먼저 저장된 유효(`active`·`review`) 결정과 한 쌍씩 비교한다. 경고는 두 결정이 모두 유효할 때만 저장하고 새 결정을 `review`로 바꾼다. 검사 중에도 보드에 나온다.
- 진행 위치를 `conflict_checks.progress`에 저장해서, 서버를 다시 켜도 그 위치부터 이어 한다. 진행 중인 검사는 정책 지문(`contract/diagnostics.py`)이 바뀌면 첫 쌍부터 다시 하고, 끝난 검사는 다시 돌지 않는다.
- 통신 실패는 몇 번 저절로 다시 한다. 그래도 안 되거나, 확신도가 낮거나, 그 밖의 실패면 `failed`가 된다. 팀원이 `team.retryCheck`로 진행 위치부터 다시 시작한다.

### 결정 상태와 충돌 처리

- 결정 상태(`record_states`)의 `review`는 처리 전·논의 중 경고의 새 결정이다. 보드는 `active`·`review`만, 이력은 전부 보여 준다.
- `team.resolve`: `keep-existing`은 새 결정을 `rejected`, `adopt-new`는 기존 결정을 `superseded`로. `both-valid`는 둘 다 유지, `discuss`는 경고를 열어 둔다.
- 처리 기록은 처리자·메모와 함께 `conflict_events`에 쌓인다. 같은 선택·메모를 다시 보내면 성공한다. 그 밖의 변경은 처리 전이거나 `discuss`인 경고에서만 된다 (끝난 경고는 메모만 달라도 409).

## 6. 폴더와 진입점

폴더 설명·담당과 검사 실행은 [README.md](../README.md), `ai/`·`web/`·`extension/`은 각 README, `shared/`는 [CLAUDE.md](../CLAUDE.md) 5장에 있다. 수집기의 단계별 모듈은 [3절](#3-로컬-수집기-처리-단계)에 있다.

| 폴더 | 진입점 |
|---|---|
| `collector/` | `app.py` 수집기 실행(`run`) · `prepare_native.py` 확장 연결 파일 생성 · `native_host.py` Chrome이 `syncup-native`(Windows는 `syncup-native.cmd`)로 띄우는 Native Messaging 호스트 · `local_web.cjs` 확장 없는 로컬 웹 실행기 · `syncup_entry.py` Windows 묶음 `syncup.exe`의 진입점, 빌드는 `windows_bundle.py` ([windows.md](windows.md)) |
| `server/` | `team_server.py` 팀 API(`127.0.0.1`에서만) · `cloud_server.py` 호스팅용, `/healthz` · `team_admin.py` 관리 CLI · `team_schema.sql`·`team_decisions.sql`·`team_upgrades.sql` 기본 테이블·RLS, 결정·충돌 테이블, 업그레이드 |
| `contract/` | 없음. 수집기와 팀 서버가 import해서 쓴다 |
| `scanner/` | `src/main.rs` OS 확인, 인자, Codex·Claude Code 스캐너 실행 |
