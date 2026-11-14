# 팀 서버

팀원이 승인한 카드를 팀별로 저장하고, 새 결정을 기존 결정과 충돌 검사하는 API다. 데이터는 PostgreSQL `syncup` 스키마에 둔다.
사용자·팀·연결 키는 `server/team_admin.py`로만 관리한다. 명령은 모두 저장소 루트에서 실행한다.

## 준비

- 팀 서버 전용 빈 PostgreSQL DB (검사는 PostgreSQL 17)
- Python 3.11 이상, `python3 -m pip install -r server/requirements.txt`
- 충돌 검사용 AI 설정 ([ai/README.md 설정](../ai/README.md#설정))
- DB 연결은 환경 변수로만 준다. 원격 DB는 연결 주소에 `sslmode=verify-full`과 믿을 CA를 둔다.

| 변수 | 쓰는 곳 | 계정 |
|---|---|---|
| `SYNCUP_ADMIN_DATABASE_URL` | `team_admin.py` | 관리 계정. 역할·스키마 생성과 RLS 우회(슈퍼유저 또는 `BYPASSRLS`) 권한 |
| `SYNCUP_DATABASE_URL` | `team_server.py`, `cloud_server.py` | `syncup_api` (설치 때 만듦) |

API는 `SYNCUP_ADMIN_DATABASE_URL`이 보이면 시작하지 않는다.

## 처음 설치

```sh
umask 077
python3 -c 'import secrets; print(secrets.token_urlsafe(32))' > /안전한/api-db-password.key   # 24자 이상
python3 server/team_admin.py init --api-password-file /안전한/api-db-password.key
python3 server/team_admin.py user --name '이서준'        # 새 사용자 ID 출력
python3 server/team_admin.py team --name '싱크업'        # 새 팀 ID 출력
python3 server/team_admin.py member --user <사용자 ID> --team <팀 ID>
python3 server/team_admin.py token --user <사용자 ID> --output /안전한/개인연결.key
```

- `init`은 한 트랜잭션에서 `syncup_api` 로그인 역할(슈퍼유저·RLS 우회·역할/DB 생성·복제 권한 없음)을 만들고 `server/`의 SQL 세 파일을 적용한다. 같은 서버에 그 역할이 있거나 DB에 `syncup` 스키마가 있으면 아무것도 바꾸지 않고 실패한다. 기존 DB는 [업그레이드](#기존-db-업그레이드)를 한다.
- 사용자·팀 ID는 만들 때 한 번만 출력되고, 목록을 보여 주는 명령은 없다. `member`·`token`·`revoke-tokens`에 쓰니 적어 둔다. 잊었으면 관리 계정으로 `SELECT id, name FROM syncup.users`(팀은 `syncup.teams`)를 조회한다.
- 한 사용자가 여러 팀에 속할 수 있다.
- `token`은 키를 새 파일(권한 600)에만 쓰고, 파일이 이미 있으면 멈춘다. 유효 기간은 기본 30일, `--days`로 1~90일. 만료되면 새로 발급하고 수집기를 새 키 파일로 다시 시작한다.
- 키 파일은 본인만 읽을 수 있게 전달한다. 그렇지 않으면 수집기가 읽지 않는다.

## 권한 회수

```sh
python3 server/team_admin.py member --user <사용자 ID> --team <팀 ID> --revoke   # 그 팀 소속만 끔
python3 server/team_admin.py revoke-tokens --user <사용자 ID>                    # 키 모두 폐기
```

- 소속은 `--revoke` 없이 다시 실행하면 되살아난다. 폐기한 키를 되살리는 명령은 없다.
- 서버는 요청마다 키와 소속을 확인하므로 회수 뒤 첫 요청부터 401·403이다. 처리 중인 요청, 내려받은 사본, 승인된 카드, 서버 백업에는 미치지 않는다.

## 서버 실행

`SYNCUP_DATABASE_URL`에 `syncup_api` 연결 주소를 넣고 켠다. 비밀번호는 `api-db-password.key`의 값이다.

```sh
export SYNCUP_DATABASE_URL='postgresql://syncup_api:<비밀번호>@<호스트>/<DB 이름>'
env -u SYNCUP_ADMIN_DATABASE_URL python3 server/team_server.py --port 8878
```

- 기본 포트는 8878. `127.0.0.1`에만 열고, Host가 `127.0.0.1:<포트>`가 아니면 400이다 (`localhost`도 400).
- 시작할 때 `ai/.env`를 읽는다. 셸에 있는 값이 우선한다.
- 시작 전에 DB 계정 권한·팀 테이블·RLS·진단·진행 열을 검사하고, 맞지 않으면 사용법 줄과 원인 한 줄을 출력하고 종료 코드 2로 멈춘다.
- 다른 기기에서 쓰려면 [클라우드 이미지](#클라우드-이미지)를 쓴다. 이 서버를 그대로 열려면 앞에 HTTPS 프록시를 두고 Host를 `127.0.0.1:<포트>`로 바꿔 넘긴다. 프록시·인증서·접속 제한 설정은 이 저장소에 없다.

## 한 기기에서 써 보기

Docker로 PostgreSQL을 띄워 이 Mac에서 팀 서버까지 돌려 본다. 컨테이너를 멈추면 데이터도 지워진다.

1. DB를 띄우고 관리 계정 주소를 넣는다. DB가 뜰 때까지 몇 초 기다린다.
   ```sh
   export POSTGRES_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
   docker run --rm -d --name syncup-db -e POSTGRES_PASSWORD -e POSTGRES_DB=syncup \
     -p 127.0.0.1:5432:5432 postgres:17-alpine
   export SYNCUP_ADMIN_DATABASE_URL="postgresql://postgres:$POSTGRES_PASSWORD@127.0.0.1:5432/syncup"
   ```
2. 같은 셸에서 [처음 설치](#처음-설치) 명령을 차례로 실행한다.
3. API 주소를 넣고 서버를 켠다.
   ```sh
   export SYNCUP_DATABASE_URL="postgresql://syncup_api:$(cat /안전한/api-db-password.key)@127.0.0.1:5432/syncup"
   env -u SYNCUP_ADMIN_DATABASE_URL python3 server/team_server.py --port 8878
   ```
4. 수집기를 `--team-api http://127.0.0.1:8878`과 발급한 키 파일로 켠다 ([running.md](running.md#수집기-실행)).

## 클라우드 이미지

호스팅 서비스의 관리형 HTTPS 뒤에서 도는 이미지다.

```sh
docker build -f Dockerfile.cloud .
```

- `server/cloud_server.py`가 `0.0.0.0:$PORT`에서 받는다. 루트가 아닌 사용자(65534)로 돈다.
- `Dockerfile.cloud`의 `COPY`와 `.dockerignore` 허용 목록에 적은 파일만 들어간다. 로컬 DB·키·검사·`ai/.env`는 없다.

| 환경 변수 | 내용 |
|---|---|
| `SYNCUP_DATABASE_URL` | `syncup_api` 연결. `sslmode=verify-full`이 없으면 시작하지 않는다 |
| `SYNCUP_PUBLIC_HOST` | 공개 호스트 이름 (소문자, 포트·경로 없이). 없으면 `RENDER_EXTERNAL_HOSTNAME` |
| `PORT` | 기본 10000 |
| AI 설정 | 이미지에 `ai/.env`가 없으므로 호스팅 서비스의 환경 변수로 준다 |

- Host 헤더가 공개 호스트 이름 하나와 정확히 같아야 받는다.
- `GET /healthz`는 DB에 3초 안에 닿으면 200 `{"ready": true}`, 아니면 503 `{"ready": false}`. 준비 여부 말고는 내보내지 않는다. 이 경로만 Railway 점검 호스트 `healthcheck.railway.app`도 받는다.
- TLS: 이미지는 `server/supabase-ca.crt`(Supabase Root 2021 CA)를 `PGSSLROOTCERT`로 쓴다. 다른 DB 제공자면 그 CA 파일을 `COPY`·`.dockerignore`에 더하고 연결 주소의 `sslrootcert`로 지정한다.
- Supabase Auth와 Data API는 쓰지 않는다. 사용자와 연결 키는 `syncup` 스키마에 둔다.
- 설정이 틀리면 접속 정보나 드라이버 오류 문구 없이 고정된 원인 한 줄만 출력하고 멈춘다.

## API 요청

모든 요청에 `Authorization: Bearer <연결 키>`가 필요하다. 표의 `…`는 `/teams/{팀}`이다.

| 요청 | 하는 일 · 응답 |
|---|---|
| `GET /me` | 연결한 사용자와 소속 팀 |
| `GET …/items` · `…/items/{카드}` | 승인 카드 최근 200장 · 한 장 |
| `POST …/items` | 본인이 승인한 카드 한 장 추가. 같은 내용을 다시 보내면 200이고 한 번만 저장한다. 403 다른 사람 이름, 409 같은 카드 ID에 다른 내용 |
| `GET …/board` · `…/history` | 보드 카드와 검사 상태 · 종료된 결정까지 |
| `GET …/conflicts` · `…/conflicts/history` | 처리 전·논의 중 충돌 · 전체와 처리 기록 |
| `GET …/todos/done` | 완료 표시한 할 일 ID |
| `POST …/conflicts/{충돌}/resolve` | 충돌 처리 (`resolution`, `resolutionNote`). 409 이미 끝난 충돌 |
| `POST …/items/{카드}/done` | 할 일 완료 표시 (`done`) |
| `POST …/items/{카드}/retry-check` | 실패한 충돌 검사 다시 시작. 시도 횟수와 진단을 비운다. 409 실패 상태가 아님 |
| `GET …/repo` | 팀 상태 파일의 GitHub 저장 상태 ([아래](#github-레포-저장)). 연결 안 된 팀은 `{"linked": false}` |
| `GET …/settings` · `POST …/settings` | 팀이 함께 쓰는 설정 ([아래](#팀-설정)). POST는 보낸 칸만 바꾸고 나머지는 둔다 |
| 공통 | 401 키 없음·틀림·만료·폐기, 사용자 비활성 · 403 그 팀 소속 아님 · 503 DB에 닿지 못함 |

## GitHub 레포 저장

팀 하나의 상태 파일([SYNCUP.md·syncup.json](team-state.md))을 GitHub 레포 루트에 커밋한다. 코드는 `server/repo_sync.py`(언제·무엇을), `server/github_repo.py`(GitHub API 호출).
어느 팀을 어느 레포에 저장할지는 서버 환경 변수로만 정한다. 요청으로는 바꿀 수 없다.
레포가 Public이면 결정·할 일 내용, 결정 이유, 충돌 처리 이유, 팀 이름, 요청한 사람 이름이 공개 커밋 기록에 영구히 남는다. 원문 발췌·출처·승인자 ID·AI가 쓴 충돌 이유는 넣지 않는다.

| 환경 변수 | 내용 |
|---|---|
| `SYNCUP_GITHUB_TEAM` | 저장할 팀 ID (`team_admin.py team`이 출력한 uuid) |
| `SYNCUP_GITHUB_REPO` | `owner/name` (예 `MInGyu26AI/AI-12team`) |
| `SYNCUP_GITHUB_BRANCH` | 저장할 브랜치. 없으면 `main`. 브랜치는 미리 있어야 한다 |
| `SYNCUP_GITHUB_TOKEN` | 그 레포 하나만 고른 Fine-grained 토큰, 권한 Contents: Read and write |

- 셋(`TEAM`·`REPO`·`TOKEN`)을 모두 비우면 저장하지 않는다. 일부만 있거나 형식이 틀리면 서버가 시작하지 않는다 (토큰은 출력하지 않음).
- 그 팀의 승인·충돌 처리·할 일 체크 요청이 성공하거나 충돌 검사가 판정을 하나 이상 기록하면, 10초 동안 다른 변경이 없을 때 DB에서 파일을 다시 만든다. 그 사이의 변경은 커밋 하나로 묶는다. 변경이 계속 와도 첫 변경 뒤 60초 안에는 저장한다.
- 브랜치의 두 파일과 내용이 같으면 커밋하지 않는다. 사이에 다른 사람(또는 다른 서버 인스턴스)이 같은 브랜치에 푸시했으면 DB에서 파일을 다시 만들어 새 머리 위에 커밋한다. 브랜치 보호 규칙이 거절하면(422) 다시 시도하지 않고 `failed`로 남긴다.
- 커밋 메시지는 바뀐 내용과 요청한 사람으로 만든다. 카드를 승인한 사람에만 '승인'을 붙인다. 예: `SyncUp: MVP 범위 결정 변경 외 1건 (김단비 승인, 이서준)`. 충돌 검사가 찾은 충돌은 이름 없이 `SyncUp: DB 충돌 확인 필요`. 저장에 실패한 묶음의 사람은 다음 커밋에 함께 적는다.
- GitHub 오류는 팀 API 응답에 영향을 주지 않는다. 진단 로그에는 단계·오류 종류·HTTP 상태만 남고, 다음 변경 때 다시 저장한다. GitHub가 다른 곳으로 리다이렉트하면 토큰은 따라가지 않는다.
- `GET …/repo` 응답의 `repo`: `linked`, `repo`, `branch`, `files`, `state`(`unknown` 시작 뒤 아직 확인 안 함 / `saved` / `unchanged` / `failed`), `pending`(저장 대기·진행 중), `commit`(`sha`, `url`, `at`), `httpStatus`(실패 때), `checkedAt`(epoch 초). 로컬 수집기 RPC `team.repo`가 같은 응답을 준다.
- 상태는 메모리에만 있다. 서버를 다시 켜면 `unknown`이고, 그 팀의 첫 요청(보드 조회 등 무엇이든)이 바로 한 번 저장해 연결을 확인한다. 재시작 때문에 기다리던 저장이 끊겼어도 그때 다시 맞춰진다.

## 팀 설정

팀원 누구나 읽고 바꾸는 팀 단위 설정이다. 표는 `syncup.team_settings`(팀당 한 행, `team_upgrades.sql`), 코드는 `server/team_settings.py`.

| 칸 | 내용 |
|---|---|
| `topic` | 프로젝트 주제 (1200자 이하). 모든 팀원의 로컬 수집기가 분류 기준으로 쓴다 |
| `goal` · `scope` | 팀 목표 · 범위 (각 500자 이하). `syncup.json`의 `team`에 들어간다 |
| `rules` | 규칙 목록 (20개 이하, 각 200자 이하) |
| `updatedBy` · `updatedAt` | 마지막으로 바꾼 팀원 ID와 시각. 아무도 저장한 적 없으면 `null` |

- 다른 팀의 설정은 읽지도 바꾸지도 못한다(RLS). 바꾼 사람은 요청한 본인으로만 기록된다.
- 로컬 수집기는 `collection.configure`로 바뀐 주제를 받으면 이 API에 먼저 올리고, 올리지 못하면 저장하지 않는다. 30초마다 팀 주제를 읽어 따라간다. 아무도 저장하지 않은 팀이면 그 수집기의 주제를 팀 주제로 올린다. 이 API가 없는 예전 서버(404)에서는 주제가 예전처럼 각자 PC에만 남는다.
- 로컬 수집기 RPC `team.settings`(읽기)와 `team.updateSettings`(`topic`·`goal`·`scope`·`rules` 중 일부)가 같은 요청을 중계한다.
- 이 표를 쓰는 서버는 표가 없으면 시작하지 않는다. 배포 전에 [아래](#기존-db-업그레이드) `migrate-integration`을 먼저 실행한다. 표가 생겨도 예전 서버는 그대로 동작한다.

## 기존 DB 업그레이드

예전 코드로 만든 DB는 새 코드를 배포하기 전에 API 쓰기를 멈추고 [백업](#백업과-복구)을 확인한 뒤 관리 계정으로 한 번 실행한다.

```sh
python3 server/team_admin.py migrate-integration
```

`syncup.conflict_checks`가 없으면 `team_decisions.sql`을 적용하고, 그다음 늘 `team_upgrades.sql`을 적용한다. 한 트랜잭션이라 중간에 실패하면 아무것도 바뀌지 않는다. 두 번 실행해도 되고, 승인 카드·검사 상태·RLS는 그대로 둔다.

## 백업과 복구

서버는 승인 카드를 자동으로 지우지 않고, 지우는 관리 명령도 없다. 백업 일정은 이 저장소에 없으니 호스팅 DB 쪽에서 확인한다.
백업에는 승인 내용과 키의 SHA-256 값이 들어 있다. 공개 저장소·로그·공유 문서에 두지 않는다.

```sh
pg_dump --format=custom --schema=syncup --file=/안전한/syncup.dump   # 서버와 같은 메이저 버전
createdb syncup_restore                                              # 복구는 새 빈 DB에
pg_restore --exit-on-error --dbname=syncup_restore /안전한/syncup.dump
```

- 접속 대상은 `PGSERVICE`(또는 `PGHOST`·`PGDATABASE`·`PGUSER`)로, 비밀번호는 본인만 읽는 `.pgpass`로 준다. `.pgpass`만으로는 접속 대상이 정해지지 않는다. 운영 DB를 지우거나 `--clean`을 쓰지 않는다.
- 역할은 덤프에 들어가지 않는다. 다른 PostgreSQL 서버에 복원하려면 같은 권한의 `syncup_api`와 원래 소유자 역할을 먼저 만든다.
- 백업 뒤에 회수한 소속·키는 복원하면 되살아난다. API를 열기 전에 [권한 회수](#권한-회수)를 다시 하고, 두 계정으로 서로 다른 팀 카드가 보이지 않는지 확인한다.

## 충돌 검사 진단 기록

`syncup.conflict_checks`의 `diagnostics` 열(JSON)에 카드마다 마지막 시도 하나만 둔다. 진단은 API·화면·보드 응답에 나가지 않고, 관리 계정으로 조회한다. 끝나지 않은 검사를 찾을 때:

```sql
SELECT team_id, card_id, state, attempts, detail, diagnostics->>'outcome' AS outcome
FROM syncup.conflict_checks WHERE state <> 'complete';
```

- 진단과 진행 기록(`progress` 열)에는 대화 원문·인용·카드 내용·오류 메시지·키·URL·모델 응답이 없다. 비교할 카드 ID는 `progress`에만 있다.
- 표준 오류에는 단계·오류 종류·HTTP 상태·팀/카드 ID 해시 앞 12자만 적는다. 요청 로그는 남기지 않는다.

## 보안 범위

- 팀 범위: 서버가 소속을 확인하고, DB도 RLS로 요청한 팀의 행만 보여 준다. 앱 코드에 조건이 빠져도 다른 팀 행은 읽히지 않는다.
- `syncup_api`는 키 테이블을 읽지 못하고, 소속을 바꾸거나 승인 카드·충돌 처리 기록을 고치거나 지울 수 없다.
- DB에는 연결 키의 SHA-256 값만 둔다. 무엇이 팀 서버와 외부 AI로 가는지는 [privacy.md](privacy.md)에 있다.
- 활성 팀원은 모두 같은 권한이다. 읽기 전용 역할, 초대·관리 웹 화면, SSO는 없다.
- 다루지 않는 것: 같은 OS 계정의 악성 프로그램, 연결 키 탈취, DB 관리자 계정 침해. 팀 검색·첨부파일은 기능이 없다.

검사: `python3 checks/run_checks.py team` ([README 검사](../README.md#검사))
