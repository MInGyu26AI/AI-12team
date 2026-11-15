# 통합본 로그인·배포 준비 (2026-11-16)

운영 웹 주소는 `https://syncup-ashen.vercel.app`이다. 웹 가입은 PC 설치 없이 GitHub로 시작한다. 대화 수집·개인 승인함·팀 보드는 같은 계정으로 연결한 PC와 확장이 필요하다.

## 포함한 변경

- 기존 제출 통합본에 저장소 연결 후속 수정, 승인 전 개인 알림, AI 확인 필요 판정, Figma 화면을 병합했다. 수집 경계·초대·문서 가져오기와 제거된 팀 목표/범위/규칙 UI 정책을 유지했다.
- 로그인 버튼을 실제 가입 API와 PKCE 콜백에 연결했다. 검증된 GitHub 표시 이름을 사용하며, 사용자 식별에는 GitHub 숫자 ID만 사용한다.
- 로그인 복귀 경로를 제한하고 세션 만료·로그아웃 실패를 처리한다. 웹 계정 UUID와 PC 계정 UUID 및 팀 소속이 일치해야 실제 앱 화면을 연다. 이름 일치는 인증 근거가 아니다.
- GitHub 저장소 확인·연결·해제 UI와 노션 저장 연결 진입점을 복구했다. 공개 저장소는 팀 기록 공개 동의를 서버에서 검사한다.
- 확장 0.2.20과 설치 앱 빌드 기본 주소를 ashen으로 맞췄다. 이전 기본 주소는 확장 설정을 읽을 때 새 주소로 이전하며 사용자 지정 주소는 유지한다.
- 운영 빌드는 mock·demo·로컬 연결 및 잘못된 운영 주소를 거부한다. `/api/release`로 확장 버전·데이터 모드·웹 주소·배포 커밋만 확인할 수 있다.
- 새 AI 엔진의 확인 필요 응답을 서버 진단에도 `needs-review`로 기록하며, 실제 검사한 쌍 수를 보존한다.

## 확인한 범위

- 웹 196개, 확장 577개, AI 120개, 가입·권한 8개 통과.
- 전체 local/team 36개 검사 묶음에서 33개 최초 통과. 실패했던 로컬 실행 경로, 팀 통합/복구 33개, 진단 10개는 수정 후 별도로 재실행해 통과했다. GitHub 저장소 및 노션 저장은 격리 PostgreSQL과 모의 외부 API로 검증했다.
- 운영 환경값으로 웹 production 빌드·타입 검사 통과, 확장 빌드·타입 검사 통과.
- 실제 GitHub OAuth로 격리된 로컬 DB에 로그인, 내 팀 표시, PC 미연결 차단 안내, 로그아웃을 브라우저에서 확인했다. 운영 DB 로그인 종단 검증과 구분한다.
- Supabase의 기존 ashen `/auth/callback`을 유지하고 누락된 `https://syncup-ashen.vercel.app/start/callback?flow=*`를 추가해 저장된 목록에서 확인했다.

## 재배포 순서

1. 선택한 최종 커밋의 CI 설치파일 검사 결과를 확인한다. Apple Silicon·Intel·Windows 패키지는 해당 커밋으로 다시 생성해야 한다. 0.2.19 설치파일을 새 버전으로 표시하지 않는다.
2. 운영 DB를 백업한 뒤 최종 커밋의 `server/team_onboarding.sql`을 반영한다. 이번 변경은 `onboarding_account` 응답에 계정 UUID를 추가한다. 기존 가입 테이블이 있다는 사실만으로 이 변경이 적용된 것은 아니다. 기존 사용자·팀·소속 수와 역할 권한을 전후 비교한다.
3. 운영 API를 같은 커밋으로 갱신한다. 현재 고정된 이전 API는 표시 이름 생략 로그인 및 새 웹 계정 계약을 모두 지원하지 않는다.
4. 새 설치파일을 검증된 릴리스로 공개한 뒤 다운로드 환경변수를 지정한다. Vercel의 ashen 프로젝트에 웹을 배포한다. Root Directory는 `web`, 상위 `shared`를 포함한다.
5. `/api/release`가 `dataMode=real`, 확장 `0.2.20`, ashen 주소와 의도한 커밋을 반환하는지 확인한다. GitHub 로그인→팀 생성/초대→PC 연결→개인 검토→승인→팀 보드까지 운영에서 확인한다.

```dotenv
NEXT_PUBLIC_USE_MOCK=false
NEXT_PUBLIC_DEMO_MODE=false
NEXT_PUBLIC_LOCAL_BRIDGE=false
NEXT_PUBLIC_SUPABASE_URL=https://gmwvivrmmzsrpdwdfeul.supabase.co
SYNCUP_WEB_ORIGIN=https://syncup-ashen.vercel.app
SYNCUP_TEAM_API_URL=https://syncup-api-production-36de.up.railway.app
```

운영의 `SYNCUP_CONNECTION_FILE`은 제거한다. 세 `NEXT_PUBLIC_DESKTOP_*_URL`에는 새 릴리스에서 실제 존재하는 설치파일 주소를 넣는다. 서버 비밀키를 웹 환경변수로 복사하지 않는다.

## 아직 배포 검증으로 남는 것

이 문서는 운영 웹/API/새 설치파일의 공개 완료를 뜻하지 않는다. 운영 웹은 별도 배포 담당자가 적용한다. Intel·Windows 실기기 최초 설치, 실제 노션·구글 계정 권한 및 새 운영 웹 전체 흐름은 미검증이다. 설치 앱 서명·공증은 별도 작업이며 자동 분류에는 로컬 개인정보 모델과 개인 OpenAI API 키가 필요하다.
