# 최소 검사 진단 기록

서버의 기존 `syncup.conflict_checks` 행에 `diagnostics` JSONB 하나를 추가한다. 최신 시도만 보관하며 별도 서비스, 테이블, API, 화면, AI 호출은 추가하지 않는다. `(team_id, card_id)`가 작업 식별자이며 기존 RLS가 그대로 적용된다.

## 저장하는 값

| 값 | 의미 |
|---|---|
| version / attempt | 진단 형식 버전 1 / 현재 재시도 묶음의 시도 번호 |
| started_at / finished_at | 시작·종료 Unix 초. 진행 중이면 종료 null |
| elapsed_ms | 단조 시계로 잰 실행 시간. 중단 복구는 null |
| candidate_count | 같은 팀의 현재 비교 범위에 포함된 기존 유효 결정 수. 기존 AI `_is_decision` 조건 재사용 |
| checked_count | 반환된 해당 카드의 중복 없는 유효 대상 ID 개수. 실패·부분 실패·미제공·형식 오류는 null. 정상 빈 비교만 0 |
| outcome | running / complete / needs-review / retry-pending / retry-exhausted / check-failed / interrupted |
| policy_sha256 | 프로세스 시작 시 읽은 충돌·판정 소스, 충돌 프롬프트와 적용 한도의 지문. 외부 주입 engine은 null |
| requested_models | 구성된 chat/decisions 모델 식별자의 SHA-256. 알 수 없으면 null |
| methods | 정상 반환에서 관측한 decisions/chat/rule만 기록 |

원문, 인용, 카드 본문, 오류 메시지, 키, 토큰, URL, 모델 응답 전체, 후보 ID 목록은 추가 기록하지 않는다. 모델 지문은 요청 설정의 동일성 비교용이며 제공자가 실제 실행한 모델의 버전 증명은 아니다. 현재 OpenAIResponses 객체처럼 model 속성이 없으면 추측하지 않고 null로 남긴다.

`checked_count`는 진단 값이고 판정 정책을 바꾸지 않는다. 서버는 기존 전체 검사 완료 계약을 계속 사용한다. 사용자 정의 engine이 complete만 돌려주고 비교 결과를 생략하면 outcome은 complete, checked_count는 null이다. 중간 배치까지 성공하고 뒤에서 실패한 경우 기존 engine은 부분 결과를 반환하지 않으므로 그 건수를 추측하지 않는다.

## 저장 시점과 재시도

- 작업 획득 트랜잭션에서 running 요약을 저장한 뒤 AI를 실행한다. 종료 요약은 기존 상태/충돌 결과와 같은 트랜잭션으로 저장한다.
- 기존 attempts와 lease 시각을 확인한 작업만 종료 기록을 갱신한다. 늦은 이전 worker가 새 시도를 덮어쓸 수 없다.
- 통신 실패의 최대 3회 정책과 저확신의 수동 확인 정책은 변경하지 않는다.
- 수동 재시도는 이전 요약을 비우고, 다음 실행이 새 요약을 만든다. 장기 이력이나 모델 요청 재생은 지원하지 않는다.
- 실행 중 프로세스가 사라지면 기존 lease 만료 처리에서 interrupted로 기록한다. 실제 종료 시각·진행 건수·소요 시간은 복원할 수 없어 추측하지 않는다. finished_at은 중단을 발견한 시각이다.
- 정책/모델 메타데이터는 클라이언트 준비 후 종료 요약에 들어간다. 실행 도중 강제 종료되면 시작 요약의 null이 남을 수 있다.

## 기존 DB 업그레이드

코드 배포 전에 기존 관리 연결 환경에서 실행한다. 자격 증명을 명령 인자나 보고서에 넣지 않는다.

```sh
python team_admin.py migrate-integration
```

기존 integration 테이블이 있더라도 `team_diagnostics.sql`을 적용한다. `ADD COLUMN IF NOT EXISTS`이므로 반복 실행 가능하며, 승인 카드·검사 상태·RLS는 보존한다. 신규 `init`에도 같은 SQL이 적용된다. API 시작 검사는 jsonb/not-null 컬럼 존재를 확인하고 누락 시 시작을 거부한다. 이 명령은 운영 DB에 이번 작업에서 실행하지 않았다.

진단 조회는 기존 관리자 DB 도구로 한다. 보드 응답에 자동 노출하지 않는다.

```sql
SELECT team_id, card_id, state, attempts, diagnostics
FROM syncup.conflict_checks;
```

## 검증

```sh
python -B check_minimal_diagnostics.py
```

테스트는 일회용 PostgreSQL 17 컨테이너, 로컬 HTTP, 합성 모델/개인정보 표식만 사용한다. 외부 AI 호출은 하지 않는다. 반복 업그레이드·민감 원문 배제·성공/실패 건수·재시도·중단·늦은 worker·RLS를 검사한다.

이 기능은 서버 검사 진단에 한정된다. Claude의 로컬 보호 게이트와 그 모델 품질, 다른 대화의 Decisions 응답 검증은 별도 작업이다. 이 문서를 근거로 그 기능까지 완료로 표시하지 않는다.
