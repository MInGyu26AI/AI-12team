# 팀 상태 파일 (SYNCUP.md · syncup.json)

팀이 승인한 결정·할 일·조사와 충돌 상태를 모은 파일. 팀 서버가 레포 루트(main 브랜치)에 커밋한다.

- `SYNCUP.md` — 사람과 코딩 AI(Claude Code·Codex·Cursor)가 읽는 용도
- `syncup.json` — 프로그램이 읽는 용도 (웹 '팀 상태 파일 보기', 충돌 판정의 '현재 결정', 내보내기)
- 만드는 코드: [ai/syncup_ai/team_state.py](../ai/syncup_ai/team_state.py) (표준 라이브러리만), 테스트: `ai/tests/test_team_state.py`
- 사람은 두 파일을 직접 고치지 않는다 (다음 승인 때 덮어씀)

## 서버에서 부르는 법 (동균)

팀 서버의 [server/repo_sync.py](../server/repo_sync.py)가 이렇게 부르고 GitHub에 커밋한다. 설정은 [팀 서버 문서](team-server.md#github-레포-저장).

```python
from ai.syncup_ai.team_state import build_state, render_markdown, dumps

state = build_state(
    board(c, team_id, history=True),       # team_board.board — history=True 필수 (아래 '할 일 ID' 참고)
    conflicts(c, team_id, history=True),   # team_board.conflicts — 해결된 것도 넣어야 '최근 해결' 이 나옴
    done_todos(c, team_id),
    team={"name": ..., "goal": ..., "scope": ..., "rules": [...], "repo": ...},  # 프로젝트 방향성 기준. 없으면 생략
    members={user_uuid: "김단비", ...},      # owner 가 빈 결정에 승인자 이름을 넣을 때만 씀
    changed_at=...,                          # 충돌 처리·할 일 체크의 마지막 시각(epoch 초). 없으면 생략
)
files = {"syncup.json": dumps(state), "SYNCUP.md": render_markdown(state)}
```

- **언제**: 카드 승인, 충돌 해결, 할 일 체크, 충돌 검사가 끝난 뒤. 짧은 시간 안의 여러 건은 마지막에 한 번만 만들어 커밋 하나로.
- **안 바뀌었으면 커밋 안 함**: 같은 입력이면 글자까지 똑같이 나온다 (생성 시각 대신 마지막 변경 시각을 씀). 레포 파일과 같으면 건너뛰기.
- **커밋 메시지**: 서버가 바뀐 내용으로 만든다 (예: `SyncUp: MVP 범위 결정 변경 외 1건 (김단비 승인)`)
- 팀 서버는 RLS 때문에 요청한 사람 이름만 읽을 수 있어 `members`는 넘기지 않는다. owner 가 빈 결정은 결정자 없이 나간다.

## 할 일 ID (SU-n)

- 할 일 카드에 팀에 공유된 순서(board 순서 = received_at, id)대로 `SU-1`, `SU-2`, … 를 붙인다.
- 공유 카드는 지워지지 않으므로(append-only) 번호가 바뀌지 않는다. 단, **`history=True` 로 전체 카드를 넣어야** 함.
- 커밋 메시지·PR 제목에서 찾기: `find_todo_ids("[SU-3] 배포 페이지")` → `["SU-3"]`. 대소문자 무관, `SU-03`은 `SU-3`, `ISSU-3`·`SU-3a`는 무시.
- PR 이 머지되면 그 ID 의 할 일을 완료로 (`todo_states`).

## syncup.json 필드 (version 1)

| 필드 | 내용 |
|---|---|
| `syncup_version` | 형식 버전 (1) |
| `team` | `name`, `goal`, `scope`, `rules[]`, `repo` — 있는 것만 |
| `updated_at` | 마지막 변경 시각: 승인·충돌 처리·할 일 체크 중 가장 늦은 것 (KST ISO, 예 `2026-11-13T14:02+09:00`). 충돌 검사가 새로 찾은 충돌은 시각이 없어 넣지 않는다 |
| `summary` | `decisions`(현재 결정 수), `open_conflicts`, `todos`, `todos_done`, `research` |
| `open_conflicts[]` | `id`, `topic_key`, `judgement`, `reason`, `existing{card_id,content,owner}`, `new{…}`, `status`(open / discuss) |
| `decisions[]` | 세부 주제(topic_key)별 하나. `subtopic`, `status`(settled / review), `current[]`(최신이 앞, '둘 다 유효'면 여러 개), `history[]`(바뀜 superseded / 채택 안 됨 rejected) |
| 결정 한 건 | `card_id`, `content`, `reason`, `owner`, `decided_at`, `state` |
| `todos[]` | `id`(SU-n), `card_id`, `content`, `owner`, `due`, `topic_key`, `done` |
| `research[]` | `card_id`, `content`, `topic_key`, `subtopic`, `added_at` |
| `resolved_conflicts[]` | 최근 10건. 열린 충돌 필드 + `resolution`, `note` |
| `by_branch` (선택) | `add_branches`를 불렀을 때만. 브랜치 이름마다 `members`(커밋 작성자), `todos`(SU-n), `decisions`(세부 주제 이름) |

- 순서: `decisions` 는 소주제 순서(주제·목표 → … → 기타) 다음 topic_key 가나다순.
- **충돌 판정 연동 (하은)**: 새 결정은 같은 topic_key 의 `current[]` 와 비교한다.

## 레포가 Public 일 때 지키는 것

- 원문 발췌(`sentence`), 출처(`source`), 확신도, 승인자 uuid 는 **넣지 않는다**. 정리된 `content`·`reason`·이름만.
- 충돌의 `reason` 은 판정별 고정 문구다. chat 판정의 이유는 AI가 원문 발화를 인용해 쓸 수 있어 내보내지 않는다.
- 모든 글에 `mask_text` 를 한 번 더 적용 (연락처·이메일·API 키 등).
- 팀원 이름은 들어간다. 시연용 팀 레포(MInGyu26AI/AI-12team)는 Public 이므로 개인 사정이 담긴 카드는 승인하지 않도록 안내.

## 정할 것

- 원문 발췌를 SYNCUP.md 에 넣을지 (지금은 안 넣음 — Public 레포 기준)
- '확인 필요' 판정(조건부 결정)이 생기면 `open_conflicts[].judgement` 에 그대로 들어감 — 서버 판정 값과 맞추기
- 브랜치 정보를 어디서 읽을지 (GitHub API 의 브랜치별 커밋·열린 PR, 몇 분마다 / 싱크 맞추기 때)

## 선택 기능 (2차 최종 회의 10장)

### 브랜치별 관련 결정

```python
from ai.syncup_ai.team_state import add_branches

state = add_branches(state, [
    {"name": "feat/github-sync", "commits": [{"author": "donggyun", "message": "[SU-3] 레포 저장"}],
     "pulls": [{"title": "GitHub 저장 (SU-3)"}]},
])
```

- 참여자는 커밋 작성자, 할 일은 커밋 메시지·PR 제목의 SU-n, 결정은 그 할 일과 같은 세부 주제 + 브랜치 이름·메시지·PR 제목에 세부 주제 이름이 나오는 결정. AI 를 쓰지 않는다.
- 띄어쓰기는 무시하고(`MVP범위` = `MVP 범위`), 영어 주제 이름은 단어 경계로만 찾는다(`feedback` 은 `DB` 가 아님).
- SYNCUP.md 에 '브랜치별 관련 결정' 절이 생긴다.

### 결정·커밋 어긋남 알림

```sh
echo '{"commit": {"sha": "a1b2c3d", "message": "extension 폴더 추가", "author": "…", "files": ["extension/popup.tsx"]},
       "state": <syncup.json>}' | python -m syncup_ai commit-check
# → {"ok": true, "alerts": [{"commit", "topic_key", "decision", "owner", "judgement": "충돌|확인 필요", "reason", "confidence"}]}
```

- 현재 결정(최대 30개)과 비교해 어긋나는 것만 돌려준다. 외부 AI 가 필요하고, 실패해도 승인·저장 흐름에는 영향이 없다.
- 화면은 회의록 10장 '결정과 코드 충돌 알림'(결정 유지 / 결정 변경). 같은 커밋을 다시 묻지 않도록 판정한 sha 는 서버가 기억한다.
