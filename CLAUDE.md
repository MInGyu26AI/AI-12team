# 싱크업 (SyncUp) - 팀 AI 메모리

## 1. 서비스 개요
- 팀원들이 각자 ChatGPT·Claude 등과 나눈 대화에서 팀에 필요한 정보(결정·조사·할 일)를 자동으로 골라내고,
  본인이 승인한 것만 팀 결정 보드에 공유하며, 팀 결정끼리 어긋나면 충돌을 경고하는 서비스
- 타깃: 무료 AI를 섞어 쓰는 대학생 해커톤·팀플 팀
- 핵심 차별점: (1) 결정 충돌 감지 (2) 본인 승인 후 공유 (3) 설치 부담 없이 비개발자도 사용
- 2026 인공지능학과 대학 연합 해커톤 출품작. 11/8 중간 보고서 MVP, 11/16 최종 제출

## 2. 팀 역할
- 김단비: 프론트엔드 - 크롬 확장 프로그램 + 팀 웹 화면 + 배포 + 중간 보고서 총괄
- 김하은: 백엔드 A(AI) - 분류 프롬프트, 카드 JSON 형식, 충돌 판정
- 김동균: 백엔드 B(서버) - 팀 서버 API, DB, Mac 로컬 수집기(Native Messaging host), 배포
- 김민규: 기획/디자인 - Figma 화면 디자인, 분류 기준표, 샘플 대화·정답표

## 3. 전체 구조 (데이터 흐름)
1. 사용자가 확장 프로그램 팝업에서 로컬 수집기에 연결된 등록 팀을 확인하고, 프로젝트 주제·수집 종료 시각을 정한 뒤 자동 수집을 켬 (수집할 로컬 프로젝트는 수집기 실행 때 지정)
2. Content Script가 ChatGPT 화면에서 설정 기간 중 새로 완료된 발화(사용자·AI)를 자동 추출
3. Background Service Worker가 Native Messaging으로 발화를 동균님의 Mac 로컬 수집기에 전달
4. 로컬 수집기가 웹 발화 + 선택한 프로젝트의 Codex·Claude Code 발화를 전처리하고, 필요한 발췌만 외부 AI로 분류
5. 분류된 후보 카드는 '개인 검토함'(웹 /review, 비공개)에 표시 → 사용자가 확인·수정·승인
6. 승인한 카드와 근거 발췌만 로컬 전송 대기열을 거쳐 팀 서버로 전송 → 서버가 충돌 검사 (8장)
7. 팀 웹(Next.js)에서 팀 결정 보드와 충돌 경고를 보고 해결

## 4. 기술 스택
- 확장 프로그램: Chrome Extension Manifest V3, WXT, React, TypeScript, Tailwind
  - Content Script(ChatGPT DOM 추출), Background Service Worker, Native Messaging, chrome.storage
- 팀 웹: Next.js(App Router), TypeScript, Tailwind, shadcn/ui, lucide-react, Pretendard 폰트, sonner(토스트)
- 파일 처리: JSZip (ChatGPT 내보내기 zip을 브라우저 안에서 열기)
- 배포: 웹은 Vercel(Root Directory = web, 환경변수 NEXT_PUBLIC_USE_MOCK), 확장 프로그램은 개발자 모드로 직접 설치해 시연(팝업 설정의 "개인 검토함 주소"에 Vercel 주소 입력)
- 확장 배포: https://syncup-live-murex.vercel.app/install 에서 zip 내려받기 → 개발자 모드 설치. 확장을 고치면 extension/package.json 버전을 올리고 `cd extension && npm run zip:web` 후 웹 재배포

## 5. 폴더 구조
- /extension : WXT 확장 프로그램
- /web : Next.js 팀 웹
- /shared : 두 프로젝트가 같이 쓰는 타입 정의(카드, 충돌 등)와 목업 데이터
- /ai : 분류·충돌 판정 AI 모듈 (하은님)
- /scanner : Codex·Claude Code 대화 기록을 읽는 Rust 스캐너
- /collector : Mac 로컬 수집기·개인 검토함, /server : 팀 서버, /contract : 둘이 함께 쓰는 형식, /checks : 검사 (동균님, 실행·검사 방법은 README.md)
- /docs : 분류 기준, 구조·실행·팀 서버·개인정보 문서 (검증 기록은 팀 노션)

## 6. 데이터 형식 (코드는 /shared/types.ts)
**분류 기준은 [docs/classification.md](docs/classification.md)를 따른다.** (관련성 → 소주제 → 표시, 민감정보 별도 검사, 분류 예시 22개)

### 출력 형식(JSON) — 분류 기준표 4장
| 필드 | 설명 | 값 예시 | 필수 여부 |
|---|---|---|---|
| sentence | 원문 문장(또는 나눈 일부) | 브라우저 확장도 MVP에 넣자. | 관련만 |
| relevance | 관련성: related / personal | related | 필수 |
| subtopic | 소주제: 주제·목표 / 자료 조사 / 작업·결과물 / 역할·일정 / 과제 조건·피드백 / 발표·제출 / 기타 | 작업·결과물 | 관련만 |
| tag | 표시: decision(결정) / todo(할 일) / research(조사) / none(제안) | decision | 관련만 |
| topic_key | 세부 주제 (보드 묶음·충돌 비교 순서, 기존 이름 먼저) | MVP 범위 | 관련만 |
| is_new_topic | 기존 세부 주제 목록에 없는 새 주제인지 | false | 관련만 |
| content | 정리된 내용 한 줄 | 브라우저 확장 = MVP 포함 | 관련만 |
| reason | 결정 이유 (있으면) | 대화 자동 수집이 있어야 시연 효과가 큼 | 선택 |
| owner | 결정자 또는 할 일 담당자 | 이서준 | 결정·할 일 |
| due | 할 일 기한 (YYYY-MM-DD, 없으면 null) | null | 할 일 |
| is_change | 기존 결정을 바꾸는 표현인지 | true | 결정 |
| source | 출처 (AI 종류·시간, 링크, 사람) | ChatGPT, 2026-11-06 21:10 | 필수 |
| masked | 민감정보를 가렸는지 | false | 필수 |
| confidence | 분류 확신도 (0~1). 0.6 미만이면 확인 필요 | 0.85 | 필수 |

- 개인(personal)은 sentence를 저장하지 않고 relevance만 남긴다 (+ 필수 필드 source·masked·confidence).
- 한 문장에 여러 내용이 있으면 나눠서 카드 여러 장으로 만든다 (예: 결정 + 할 일).
- tag=none(제안)은 subtopic·topic_key가 없을 수 있고(null), 공유 후보에서 제외한다.
- 예시 JSON:
  `{"sentence":"브라우저 확장도 MVP에 넣자.","relevance":"related","subtopic":"작업·결과물","tag":"decision","topic_key":"MVP 범위","is_new_topic":false,"content":"브라우저 확장 = MVP 포함","reason":null,"owner":"이서준","due":null,"is_change":true,"source":"ChatGPT, 2026-11-06 21:10","masked":false,"confidence":0.85}`

### 앱에서 덧붙이는 필드 (AI 출력에는 없음)
- `id: string` — 카드 식별자
- `status: "candidate" | "approved" | "dismissed"` — 개인 검토함 승인 상태

충돌 경고 형식은 /shared/types.ts의 `Conflict`를 따른다.

### 화면 규칙 (디자인 기준: 김민규님 피그마 6개 화면)
- 화면: 1 첫 화면(/) · 2 팀 만들기(/team/new) · 3 대화 수집(/collect, 백업 입력 /collect/paste) · 4 승인함(/review) · 5 충돌 경고(보드의 '확인하기' 모달, 목업 모드는 승인 직후에도) · 6 팀 결정 기록(/board) · 확장 설치(/install)
- 승인함: 공유 후보(결정·조사·할 일)는 확신도 0.6 이상이면 기본 체크. 개인은 "개인 N개 제외"로만(내용 저장 안 함), tag=none(요청·제안·AI 답변)은 접어서 숨김
- confidence < 0.6이면 "확인 필요" 배지, masked=true면 "민감정보 가림" 배지, is_change=true인 결정은 "변경" 배지
- 팀 결정 기록: 왼쪽 topic_key 필터 · 가운데 결정 타임라인(최신순, 충돌 카드 빨간 테두리) · 오른쪽 할 일 체크 + 조사·참고. 맨 위 충돌 배너 → 충돌 모달
- 충돌 모달: '충돌'은 기존 유지 / 새 결정으로 변경 / 둘 다 유효 / 팀에 논의 요청(resolution "discuss", 경고 유지). '변경'은 예(새 결정 채택) / 아니오(기존 유지)와 '기존 안 확인하기'. 어느 쪽이든 처리 이유(선택)를 남길 수 있음
- 색 (피그마, /shared/theme.css 토큰): 브랜드·결정=남색 #4F46E5, 조사=초록, 할 일=주황, 개인=회색, 충돌=빨강, 변경=주황빛(승인함 배지)
- 팀 보드 충돌 알림 3단계 (shared/labels.ts alertLevel·ALERT_LEVEL, 토큰 alert-*): 충돌=빨강 / 확인 필요=노랑(Conflict.confidence < 0.6) / 변경=파랑
- 확장은 1분마다 team.conflicts를 확인해 새 미해결 충돌을 시스템 알림 + 빨간 아이콘 배지로 알림(누르면 /board). 이미 알린 충돌은 다시 알리지 않음

## 7. 기능 목록과 우선순위
### [MVP 11/8 필수]
A. 확장 프로그램 팝업
  - 로컬 수집기에 연결된 등록 팀·사용자 확인 (실제 모드는 관리자가 등록, 팀 코드 가입은 웹 목업 모드만)
  - 프로젝트 주제·소주제, 분류 묶음 크기, 수집 종료 시각 설정 (로컬 프로젝트는 수집기 실행 때 지정)
  - 이후 '자동 수집' 켜기/끄기 스위치, 다음 분류까지 쌓인 대화 수와 '싱크 맞추기'(개인 검토함 상단에도 같은 버튼, 검토함에 들어올 때 자동 1회), 검토 대기 카드 수, 마지막 수집 시각, '개인 검토함 열기'
B. ChatGPT 대화 자동 추출
  - 설정 기간 중 새로 완료된 발화 단위로 추출(대화마다 버튼 누를 필요 없음)
  - 사이트별 추출 코드는 파일을 분리(ChatGPT 화면 구조가 바뀌면 그 파일만 수정)
C. 로컬 수집기 연동 (분류는 김하은님 ai/ — 확장 코드는 하은님 규칙에 맞춘다)
  - Background에서 Native Messaging RPC(turns.append·candidates.list)로 발화 전달, 수집기 연결이 실패하면 팝업·화면에 오류를 알림(목업 분류로 대체하지 않음)
  - 대화 횟수 기준: 질문+답변 = 1턴, 10턴마다 분류(묶기는 ai/syncup_ai/batch.py, shared/batch.ts의 TURNS_PER_BATCH로 고정 — 화면에서 바꾸지 않고, 수집기에 다른 값이 남아 있으면 확장이 기본값으로 되돌림). 수동 보내기(싱크 맞추기·싱크업에 보내기·선택한 내용 보내기)는 수집 중일 때만 되고 남은 것까지 보냄. 일시중지·종료 때는 보내지 않고 로컬에 뒀다가 다시 수집하면 다음 묶음에 합침
  - 민감정보 가림 규칙(ai/syncup_ai/mask.py = shared/classify.ts mask, shared/mask-cases.json으로 함께 검사), 충돌 판정은 팀 서버의 ai/syncup_ai/conflict.py (shared/conflict.ts는 목업 모드용 근사)
  - 분류 완료 시 팝업의 후보 수 갱신 (배지는 공유 후보만 셈)
D. 승인함 (웹 /review — 확장이 모은 후보 + 붙여넣기 후보, 본인만 보는 비공개 화면)
  - 후보를 결정·할 일·조사(tag)로 표시, 출처와 원문(sentence) 확인·수정
  - 체크한 카드만 승인(로컬 RPC candidates.approve) → 팀 서버로 전송 (8장)
  - 백업 입력 1: 대화 붙여넣기 입력창 (자동 추출 실패 시)
  - 백업 입력 2: ChatGPT 내보내기 zip 또는 conversations.json 업로드
    → JSZip으로 브라우저 안에서 열고, 대화 목록(제목·날짜)에서 팀 관련 대화만 선택
    → 원본 파일은 서버에 보내지 않고, 붙여넣기와 같은 로컬 전처리·승인 절차를 거침
E. 팀 웹
  - 팀 결정 기록: topic_key 필터 · 결정 타임라인 · 할 일 체크 (위 화면 규칙)
  - 충돌 경고: 같음/변경/충돌/무관 중 변경·충돌을 경고(CONFLICT_ON_CHANGE). '충돌'은 두 결정과 근거 문장을 나란히 표시, '변경'은 새 결정만 보이고 기존 안은 눌러서 확인
    선택지는 위 화면 규칙의 충돌 모달, 처리는 로컬 RPC team.resolve
  - 팀 기록 복사: 팀 결정 기록을 AI에 붙여넣기 좋은 텍스트로 변환해 클립보드 복사
F. 상태·에러 처리
  - 로컬 수집기 연결 끊김, 분류 실패, 공유 실패, 충돌 검사 대기를 구분해서 표시

### [11/9 ~ 11/15 확장]
- Claude·Gemini 웹 채팅 지원 추가
- '팀 기록 불러오기': 팀 결정 기록을 AI 입력창에 자동으로 채우기(전송은 사용자가 직접)

## 8. 팀 서버 API
- 승인한 카드는 로컬 전송 대기열을 거쳐 POST /teams/{id}/items로 올라간다. 충돌 검사는 팀 서버가 저장 뒤 비동기로 하므로 실제 모드의 승인 응답에는 충돌이 없다 (보드의 검사 진행·충돌 배너로 확인)
- 웹의 TeamApi(web/src/lib/api/types.ts)는 로컬 RPC를 부른다: 승인 candidates.approve, 조회 team.board·team.history·team.conflicts·team.conflictHistory·team.done, 처리 team.resolve·team.setDone·team.retryCheck
- 로컬 수집기는 team.* 요청을 연결된 팀의 /teams/{id}/... 경로로 넘긴다 (collector/team_relay.py, 경로 목록은 server/team_server.py)
- 충돌 처리 resolution: keep-existing | adopt-new | both-valid | discuss (+ resolutionNote)
- 팀 상태 파일(SYNCUP.md·syncup.json) GitHub 저장: 팀 서버가 변경 뒤 자동 커밋(server/repo_sync.py). 웹은 로컬 RPC team.repo(= GET /teams/{id}/repo)로 저장 상태·마지막 커밋을 읽는다 (shared/repo.ts). 화면: 팀 보드 레포 상태 바·'팀 기록' 탭(레포의 SYNCUP.md, syncup.json 내려받기)·할 일 SU-n 배지와 'ID 복사'·결정 "레포 반영 ✓", 대화 수집 화면의 연결 상태, 확장 팝업 하단. 레포 연결은 서버 환경 변수로만 정하므로 입력 화면은 없다. 형식은 docs/team-server.md 'GitHub 레포 저장'. syncup.json 에 by_branch 가 있으면 팀 보드에 '브랜치' 필터(그 브랜치의 세부 주제 결정·SU-n 할 일만)
- 웹은 별도 API 주소를 쓰지 않는다. 실제 모드는 로컬 수집기 RPC로 팀 서버에 접근한다: 기본은 확장 경유, `NEXT_PUBLIC_LOCAL_BRIDGE=true`면 웹 서버의 `/api/local` 경유(서버 쪽 `SYNCUP_CONNECTION_FILE`·`SYNCUP_LOCAL_*` 필요). 목업 여부는 `NEXT_PUBLIC_USE_MOCK`

- 프로젝트 방향성 기준(팀 목표·범위·규칙, shared/criteria.ts): 확장 설정 화면과 목업 팀 만들기에서 선택 입력, 팀 보드 맨 위 고정(목업은 팀 값, 실제 모드는 syncup.json team). 수집기 collection.configure 가 아직 teamGoal·teamScope·teamRules 를 받지 않아 확장은 저장만 한다

## 9. 개인정보·보안 원칙 (반드시 지킬 것)
- 안내 문구는 "프로젝트 대화만 가져오고, 내가 승인한 것만 팀에 공유합니다" 중심. "개인 대화를 AI가 걸러 준다"처럼 들리는 표현은 쓰지 않는다 (기기 안 개인정보 검사는 보조 장치)
- 최초 설정에서 자동 수집 범위와 외부 AI 전송을 사용자에게 안내
- 설정한 종료 시각에는 새 발화 수집과 외부 전송을 중단
- 팀 서버에는 본인이 승인한 카드와 확인한 근거 발췌만 전송, 원본 대화 전체는 보내지 않음
- API 키 등 비밀값은 .env에만 두고 .gitignore에 추가 (팀 레포 https://github.com/MInGyu26AI/AI-12team 은 Public — 비밀값은 절대 커밋하지 않음)

## 10. 시연 시나리오 (11/8까지 이 흐름이 끝까지 동작해야 함)
한 번 설정 → ChatGPT 웹·코딩 도구 대화에서 후보 자동 생성 → 한 장만 승인
→ 동료 팀 보드에 그 한 장만 표시 → 충돌 경고 확인·해결 → 종료 시각 후 수집 중단

## 11. 개발 방식
- 백엔드가 준비되기 전에는 /shared의 목업 데이터와 가짜 API로 화면부터 완성
- Native Messaging, 팀 API 연결부는 인터페이스로 분리해서 목업 ↔ 실제 연결을 쉽게 교체
- 디자인은 김민규님의 Figma 기준, 나오기 전에는 shadcn/ui 기본 스타일로 개발
- 작업 단위마다 실행 확인 후 커밋
