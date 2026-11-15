# 제출 통합본 배포

공식 웹: https://syncup-live-murex.vercel.app
팀 API: https://syncup-api-production-36de.up.railway.app
통합 PR: https://github.com/MInGyu26AI/AI-12team/pull/16
확장 버전: 0.2.19

## 포함 기능

- GitHub 직접 가입 → 새 팀 생성 → Mac·Windows 설치 앱 → PC 연결. 초대받은 팀원은 설치 후 원래 초대 링크로 돌아간다.
- 수집 시작 전 발화 제외, 마지막 답변 저장 후 중지, 팝업 읽기 진단 갱신, 최대 7일 종료 달력·타이머.
- GitHub 인증 복귀 페이지가 확장을 찾도록 웹 중계 스크립트를 document_start에 연결한다.
- 불확실한 충돌은 '확인 필요'로 남기고 나머지 비교를 계속한다(PR #8).
- 카카오톡 붙여넣기에서 화자를 고르고 내 글만 가져오기(PR #11).
- 파일 업로드와 로컬 노션·구글 문서 커넥터(PR #12). 웹 수집 화면에서 이 PC의 문서 연결 화면을 연다.
- 팀 목표·범위·규칙 입력과 보드 표시는 제거했다. 기존 저장 데이터 및 서버 계약은 보존했다.

## 반영 순서

1. 운영 Supabase의 `syncup` 스키마와 기존 데이터 수를 확인한다. `server/team_onboarding.sql`을 한 트랜잭션으로 적용한다. 새 테이블은 강제 RLS, API 역할의 직접 접근 금지, 처리 함수의 고정 search_path가 필요하다. 적용 후 테이블·함수 권한과 기존 사용자·팀·소속 수를 다시 확인한다.
2. 팀 API를 통합 소스로 배포한다. `Dockerfile.cloud`와 `.dockerignore`에 `server/onboarding.py`가 포함돼 있어야 한다. `/healthz` 200, 인증 없는 `/me` 및 `/onboarding` 401을 확인한다.
3. Supabase Redirect URLs에 `https://syncup-live-murex.vercel.app/start/callback?flow=*`를 추가한다. 기존 `/auth/callback` 및 필요한 기존 주소를 유지한다. 이 목록은 이번 작업의 최종 인계 기록에서 적용 여부를 확인한다.
4. Vercel Root Directory는 `web`, shared 디렉터리를 포함한 저장소 전체가 배포 소스다. `web/.env.example`의 운영 환경변수를 적용한다. 서비스 역할 키와 DB 접속 문자열은 웹에 넣지 않는다. NEXT_PUBLIC_USE_MOCK/NEXT_PUBLIC_LOCAL_BRIDGE는 false이며, SYNCUP_CONNECTION_FILE은 운영에서 비워 둔다.
5. desktop-installers CI에서 같은 소스의 Apple Silicon·Intel Mac·Windows x64 앱을 만든다. ZIP 안의 확장 manifest 버전과 공개 확장 ZIP이 0.2.19인지 확인한다. 공개 다운로드 URL 3개를 웹 환경변수로 지정하고 웹을 배포한다.
6. 새 사용자의 `/start` GitHub 가입→팀 생성, `/install` 설치, `/connect` PC 키, 수집 켜기→새 대화→개인 승인→팀 보드를 확인한다. 별도로 초대 링크 참여를 확인한다. 승인 전 카드는 팀에 없어야 한다.

## 검증과 제한

로컬: 확장 565개, 웹 184개 통과. 가입 7개, 동기화 접수 50개, 커넥터 66개, 설치 9개, DB 백업·복원 2개 통과. 전체 검사 38묶음 중 새 가입 테이블 시험 데이터 누락을 보완하고 실패했던 DB 검사를 재실행해 통과했다. 후속 변경이 영향을 주는 검사도 재실행했다.

웹 webpack production 빌드, 서버 Docker 빌드, 실제 Apple Silicon Mac 번들의 native host와 격리 DB 종단 검사를 통과했다. Mac 번들에서 노션·구글 문서 제공자 두 개가 로드되는 것도 확인했다. 인증과 외부 AI는 이 종단 검사에서 모의 서버를 사용했다.

노션·구글 API 통신은 가짜 서버로 검증했다. 실제 계정 연결, 문서 접근권한, Google OAuth 앱 검증은 별도다. 문서 연결 정보는 이 PC에만 저장한다. 자동 분류에는 Ollama와 개인 OpenAI API 키가 필요하다.

현재 설치 앱에는 개발자 배포 서명·Apple 공증이 없다. OS 빌드 및 자동 검사는 실기기 다운로드 후 설치 검증과 다르다. OS 경고를 우회하도록 자동 조치하지 않는다. 사용자용 일반 배포로 표현하기 전에 서명·공증 및 깨끗한 Mac·Windows 설치를 확인해야 한다.

## 되돌리기

웹과 팀 API는 직전 배포 `10c4884`로 되돌릴 수 있다. 새 가입 테이블은 기존 배포와 충돌하지 않으므로 롤백 과정에서 삭제하지 않는다. 설치 앱은 이전 등록을 백업하며 데이터와 연결 키를 지우지 않는다. 이미 공개한 릴리스 파일을 덮어쓰기보다 새 버전을 배포한다.
