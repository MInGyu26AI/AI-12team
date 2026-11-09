# DB 운영 및 복구 기준

## 현재 구현과 검증

- 통합 모드 로컬 SQLite 17개 테이블: 기존 14개 + privacy_results, privacy_jobs, privacy_overrides. 앱을 실행하면 시작 직후 첫 보존 정리(`retention.py`)가 retention_jobs를 더해 18개가 된다.
- PostgreSQL syncup 스키마 10개 테이블. conflict_checks에 diagnostics·progress JSONB(NOT NULL DEFAULT '{}') 열이 있다(`team_upgrades.sql`). 진단은 최신 시도만 저장한다.
- API 계정 syncup_api: NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, NOCREATEROLE, NOREPLICATION, 다른 역할 상속 없음. 9개 팀 테이블 RLS+FORCE RLS. tokens 직접 읽기 권한 없음. 승인 원문과 충돌 이력 UPDATE/DELETE 권한 없음.
- check_db_operations.py: 데이터가 채워진 SQLite 14→17 반복 업그레이드, 승인 outbox 보존, 백업 복원 후 재업그레이드 일치. PostgreSQL 10개 테이블에 합성 데이터를 넣고 진단 컬럼을 두 번 업그레이드하여 기존 모든 행 보존. pg_dump/pg_restore 결과의 행·컬럼·정책·권한·제약 일치. 복원 DB에 실제 API CLI를 두 번 시작/종료해 승인 카드 유지 확인.
- 합성 계정 격리, 승인 ACK 유실 후 재전송, 구성원/토큰 권한 회수, DB 일시정지→503→복구 후 중복 방지 검사 통과. 실제 클라우드·서로 다른 물리 기기 검증은 별도다.

## 새 DB 초기화와 기존 DB 업그레이드

1. 운영 대상과 서버 버전을 먼저 확인한다. 별도 프로젝트/DB를 사용한다. Data API는 이 서버가 사용하지 않으므로 비활성화한다. Supabase Auth와 기존 SyncUp 사용자/토큰 체계는 서로 다르다.
2. 새 DB만: [팀 서버 사용법](../../팀_서버_사용법.md)의 관리자 초기화를 따른다. init은 기존 DB에 재실행하지 않는다.
3. 기존 DB: API 쓰기를 중지하고 백업을 확인한 뒤 `python3 team_admin.py migrate-integration`. 하나의 트랜잭션에서 실행하며 두 번 실행해도 진단·진행 열을 중복 생성하지 않는다. 임의로 변경된 모든 스키마를 자동 복구하는 도구는 아니다. 누락 테이블/컬럼/정책은 카탈로그 대조 후 별도 처리한다.
4. API에는 제한 계정 SYNCUP_DATABASE_URL만 전달한다. 관리자 환경변수를 제거하고 서버를 시작한다. 진단·진행 열 업그레이드가 빠져 있으면 API가 시작을 거부한다.
5. `team_server.py`(CLI)의 바인딩과 HTTPS 프록시 조건은 [팀 서버 사용법](../../팀_서버_사용법.md)에 있다. 클라우드 이미지(`Dockerfile.cloud` → `cloud_server.py`)는 관리형 HTTPS 인그레스 뒤에서 `0.0.0.0:$PORT`에 바인딩하고 정확한 공개 호스트(`SYNCUP_PUBLIC_HOST`, 없으면 `RENDER_EXTERNAL_HOSTNAME`)만 받는다. 예외로 `GET /healthz`는 Railway 점검 호스트(`healthcheck.railway.app`)도 받는다. `SYNCUP_DATABASE_URL`에 `sslmode=verify-full`이 없으면 시작하지 않는다. 이미지에 들어 있는 CA는 Supabase 공개 CA(`PGSSLROOTCERT=/app/supabase-ca.crt`)뿐이다. Supabase DB는 연결 문자열에 `sslrootcert`가 필요 없고, 다른 제공자는 그 제공자의 CA를 `sslrootcert`로 지정해야 한다. DB 생성만으로 API 배포나 외부 접근이 완료되지는 않는다.
6. 실제 사용자 대화를 옮기기 전에 가짜 계정 두 개/팀 두 개로 승인·중복 재전송·권한 회수·재시작을 수행한다. 다른 기기에서 같은 HTTPS API에 연결해 검증한 별도 결과를 남긴다.

## 백업과 복구 절차

- PostgreSQL: psql/pg_dump 버전을 서버와 맞추고 `PGSERVICE`/소유자 전용 .pgpass 등으로 인증한다. `pg_dump --format=custom --schema=syncup --file=/private/backup/syncup.dump`를 실행한다. 백업에는 승인 내용·토큰 해시도 들어가므로 공개 저장소/로그에 넣지 않는다.
- 새 빈 DB에 제한 역할을 먼저 생성하고 `pg_restore --exit-on-error --dbname=syncup_restore /private/backup/syncup.dump`로 복원한다. 운영 DB를 지우거나 --clean을 실행하지 않는다. 관리자 소유권과 syncup_api 권한을 유지한다.
- 검사에서는 동일 임시 PostgreSQL 클러스터의 별도 DB로 복원했다. 다른 클러스터로 옮길 때는 역할 생성·소유자 매핑·비밀번호의 안전한 재설정도 필요하며 이번 검사로 검증한 범위가 아니다.
- 복원 후 표/행수/컬럼/제약/RLS/정책/GRANT를 원본과 대조하고 `team_access.verify_database`를 제한 계정으로 실행한다. 두 계정으로 서로 다른 팀 데이터가 보이지 않는지 확인한다.
- SQLite: 수집기와 전송을 멈춘 뒤 sqlite3.Connection.backup으로 일관된 복사본을 만든다. 실행 중인 DB 파일만 일반 복사하지 않는다. 별도 경로로 복원하고 integrity_check='ok', foreign_key_check=빈 결과를 확인한 다음 원본 대신 연결한다. 원본을 덮어쓰지 않는다.
- 복구 후 철회된 사용자·토큰·삭제 요청을 복구 시점 이후 기록과 재대조한다. 백업으로 권한 회수 이전 상태를 되살릴 수 있으므로 확인 전 API를 공개하지 않는다.

## 보존 정책 — 로컬 항목은 확정·구현(2026-11-08 사용자 확정), 서버 항목은 제안

| 대상 | 기간 | 현재 동작/예외 |
|---|---|---|
| 개인 원문·문맥 (로컬) | **정리 완료 후 7일 — 확정·구현** | `retention.py`가 앱 시작 직후와 실행 중 1시간마다 정리한다. 정리 완료의 조건은 세 가지다. 분류가 끝났고(`jobs.state='done'`), 그 묶음의 카드가 모두 공유됐거나 버려졌고, outbox에 대기·차단 건이 없다. 이 조건을 처음 확인한 시각부터 7일이 지나면 `intake`·`job_context`·`jobs.evidence`의 원문과 `privacy_jobs` 정리본, 버린 후보의 인용을 비운다. 행은 남긴다. **미승인·보류·분류 실패·묶이지 않은 수집 중 입력·전송 대기/차단은 기간과 상관없이 지우지 않는다.** 승인된 카드와 payload는 팀 기록이라 남긴다. |
| 개인 판정 캐시·처리된 격리 입력 (로컬) | **작성·처리 후 7일 — 확정·구현** | 판정 캐시(`privacy_results`)는 묶음 상태와 상관없이 작성 후 7일이 지나면 행을 지운다. 판정 라벨과 원문 속 위치만 담고 원문은 없다. 처리된 격리 입력(`intake_issues`)은 처리 후 7일이 지나면 원문을 비운다. 처리하지 않은 격리 입력은 남긴다. |
| 로컬 마이그레이션 백업 | **작성 후 7일 — 확정·구현** | DB 옆의 `<db 이름>.*.bak.sqlite` 중 수정 시각이 7일 지난 파일만 지운다. 다른 이름의 파일과 링크는 건드리지 않는다. |
| 승인 팀 카드·변경 이력 | 프로젝트 종료 후 30일 (제안) | API는 append-only. 기록 거절/대체는 삭제나 철회가 아니다. 팀 합의와 관리자 삭제 절차 필요. |
| 서버 백업 | 매일 1회, 최근 7일 (제안) | 스케줄러 미설정. 제안 RPO 24시간/RTO 4시간은 운영 목표이며 측정 SLA가 아니다. 무료 제공자의 자동 백업을 가정하지 않는다. |
| 진단 | 최신 시도 1개 | 구현됨. 원문·전체 모델 응답·키를 기록하지 않는다. |

- 로컬 원문의 기간은 "세션 종료 후"가 아니라 "정리 완료 후"부터 센다. 수집 종료 시각은 24시간 안에서 계속 연장되므로, 세션 종료를 기준으로 하면 계속 쓰는 사용자의 원문은 지워지지 않는다.
- 정리된 발화가 다시 들어오면 이미 처리한 발화로 보고 건너뛴다. 그래서 원문이 격리 입력으로 다시 저장되지 않는다.
- 권한 회수는 이후 접근과 전송을 막을 뿐, 이미 승인된 팀 기록과 서버 백업을 지우지 않는다.
- privacy.exclude는 외부 전송에서 빼는 것이지 로컬 원문을 바로 지우는 것이 아니다. 해당 묶음이 정리된 뒤 7일 규칙을 따른다.
- 서버 쪽 삭제는 참조와 불변 트리거, 공유 사본과 백업 사본까지 고려한 별도 관리자 절차가 필요하다.

## 암호화와 남은 운영 조건

- 이 Mac: 2026-11-08 `fdesetup status`와 Data 볼륨 조회에서 FileVault On 확인. 이는 디스크 정지 상태 보호이며 로그인한 계정/프로세스의 DB 읽기를 막는 애플리케이션 암호화가 아니다.
- SQLite 파일 자체 암호화/SQLCipher/키 관리 구현 없음. 별도 의존성과 복구 키 설계를 추가하지 않았다. 다른 팀원 기기의 FileVault/BitLocker 여부는 미확인.
- 클라우드 DB 카탈로그, API 호스팅, HTTPS, 운영 비밀 주입, 백업 스케줄, 실제 2기기 검증은 관찰 결과가 있어야 완료 처리한다.
- 로컬 개인정보 모델 기본값은 `gemma4:e4b-it-qat`다([privacy-model-v3.md](privacy-model-v3.md)). 모델이 준비되지 않았거나 실패하면 해당 묶음을 보류한다.
- 과거 자연 발생 DB ConnectionTimeout 원인은 미확정. 클라이언트 연결 종료 후 중복 503 응답 방지는 수정되었지만 둘을 같은 문제로 보지 않는다.
