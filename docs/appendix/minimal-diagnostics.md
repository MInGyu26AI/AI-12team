# 최소 검사 진단 기록

진단은 `syncup.conflict_checks`의 `diagnostics` JSONB 열에 최신 시도만 둔다. 같은 업그레이드(`team_upgrades.sql`)가 진행 기록용 `progress` 열도 만든다. 진단용 별도 서비스·테이블·API·화면·AI 호출은 없다. `(team_id, card_id)`가 작업 식별자이며 기존 RLS가 그대로 적용된다.

## 저장하는 값

| 값 | 의미 |
|---|---|
| version / attempt | 진단 형식 버전 1 / 현재 쌍의 시도 번호. 다음 쌍은 1부터 센다 |
| started_at / finished_at | 시작·종료 Unix 초. 진행 중이면 종료 null |
| elapsed_ms | 단조 시계로 잰 실행 시간. 중단 복구는 null |
| candidate_count | 이번 시도에서 비교하는 기존 유효 결정 수. 한 쌍씩 비교하므로 0(첫 결정) 또는 1이다. 전체 진행은 `progress`와 보드의 `conflictCheckProgress`를 본다 |
| checked_count | 반환된 해당 카드의 중복 없는 유효 대상 ID 개수. 실패·부분 실패·미제공·형식 오류는 null. 정상 빈 비교만 0 |
| outcome | running / complete / needs-review / retry-pending / retry-exhausted / check-failed / interrupted |
| policy_sha256 | 프로세스가 처음 검사할 때 계산한 충돌·판정 소스, 충돌 프롬프트, 적용 한도, 제공자 설정의 지문. 외부 주입 engine은 null |
| requested_models | 구성된 chat/decisions 모델 식별자의 SHA-256. 알 수 없으면 null |
| methods | 정상 반환에서 관측한 decisions/chat/rule만 기록 |

진단에는 원문, 인용, 카드 본문, 오류 메시지, 키, 토큰, URL, 모델 응답 전체, 후보 ID 목록을 기록하지 않는다. 후보 ID는 `progress`에만 있다. 모델 지문은 요청 설정의 동일성 비교용이며 제공자가 실제 실행한 모델의 버전 증명은 아니다. 클라이언트에 model 속성이 없으면 추측하지 않고 null로 남긴다.

engine이 complete를 돌려줘도 `checked_count`가 그 쌍의 후보 수와 다르면 완료로 치지 않고 check-failed로 남긴다. 사용자 정의 engine이 비교 결과를 생략한 경우도 같다(checked_count는 null). 앞 쌍이 성공하고 뒤 쌍이 실패하면 진단에는 실패한 쌍만 남고, 완료한 쌍 수는 `progress`에 남는다.

## 저장 시점과 재시도

- 작업 획득 트랜잭션에서 running 요약을 저장한 뒤 AI를 실행한다. 종료 요약은 기존 상태/충돌 결과와 같은 트랜잭션으로 저장한다.
- 기존 attempts와 lease 시각을 확인한 작업만 종료 기록을 갱신한다. 늦은 이전 worker가 새 시도를 덮어쓸 수 없다.
- 통신 실패는 쌍마다 최초 시도를 포함해 3회까지 자동으로 시도한다. 확신도가 낮은 판정은 다시 묻지 않고 needs-review로 둔다.
- 수동 재시도는 이전 요약을 비우고, 다음 실행이 새 요약을 만든다. 장기 이력이나 모델 요청 재생은 지원하지 않는다.
- 실행 중 프로세스가 사라지면 lease(3분)가 끝난 뒤 진행 기록(`progress.ids`)이 있는 쌍은 시도 수를 0으로 되돌려 이어서 다시 시도한다. 중단 횟수에는 상한이 없고, 진단은 다음 시도가 시작될 때까지 running으로 남는다.
- interrupted는 progress 열이 생기기 전부터 running이던 행에만 기록된다. 이 행은 failed가 되어 수동 재시도를 기다린다. finished_at은 중단을 발견한 시각이고, checked_count·elapsed_ms는 추측하지 않고 null로 둔다.
- 정책/모델 메타데이터는 클라이언트 준비 후 종료 요약에 들어간다. 실행 도중 강제 종료되면 시작 요약의 null이 남을 수 있다.

## 기존 DB 업그레이드

코드 배포 전에 기존 관리 연결 환경에서 실행한다. 자격 증명을 명령 인자나 보고서에 넣지 않는다.

```sh
python3 team_admin.py migrate-integration
```

기존 integration 테이블이 있더라도 `team_upgrades.sql`을 적용한다. `ADD COLUMN IF NOT EXISTS`이므로 반복 실행 가능하며, 승인 카드·검사 상태·RLS는 보존한다. 신규 `init`에도 같은 SQL이 적용된다. API 시작 검사는 diagnostics·progress 열이 jsonb·NOT NULL로 있는지 확인하고 없으면 시작을 거부한다.

진단 조회는 기존 관리자 DB 도구로 한다. 보드 응답에 자동 노출하지 않는다.

```sql
SELECT team_id, card_id, state, attempts, diagnostics
FROM syncup.conflict_checks;
```

## 검증

```sh
python3 -B check_minimal_diagnostics.py
```

`python3 run_checks.py team` 묶음에도 들어 있다. 테스트는 일회용 PostgreSQL 17 컨테이너, 로컬 HTTP, 합성 모델/개인정보 표식만 사용한다. 외부 AI 호출은 하지 않는다. 반복 업그레이드·민감 원문 배제·성공/실패 건수·재시도·중단·늦은 worker·RLS를 검사한다.

이 문서는 팀 서버 충돌 검사의 진단만 다룬다. 로컬 개인정보 게이트는 [local-privacy-gate.md](local-privacy-gate.md)에 있다.
