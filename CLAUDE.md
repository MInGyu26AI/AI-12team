# 싱크업 (SyncUp) - 팀 AI 메모리

## 1. 서비스 개요
- 팀원들이 각자 ChatGPT·Claude 등과 나눈 대화에서 팀에 필요한 정보(결정·조사·할 일)를 자동으로 골라내고,
  본인이 승인한 것만 팀 결정 보드에 공유하며, 팀 결정끼리 어긋나면 충돌을 경고하는 서비스
- 타깃: 무료 AI를 섞어 쓰는 대학생 해커톤·팀플 팀
- 핵심 차별점: (1) 결정 충돌 감지 (2) 본인 승인 후 공유 (3) 설치 부담 없이 비개발자도 사용
- 2026 인공지능학과 대학 연합 해커톤 출품작. 11/8 중간 보고서 MVP, 11/16 최종 제출

## 2. 팀 역할
- 김단비(나): 프론트엔드 - 크롬 확장 프로그램 + 팀 웹 화면 + 배포 + 중간 보고서 총괄
- 김하은: 백엔드 A(AI) - 분류 프롬프트, 카드 JSON 형식, 충돌 판정
- 김동균: 백엔드 B(서버) - 팀 서버 API, DB, Mac 로컬 수집기(Native Messaging host), 배포
- 김민규: 기획/디자인 - Figma 화면 디자인, 분류 기준표, 샘플 대화·정답표

## 3. 전체 구조 (데이터 흐름)
1. 사용자가 확장 프로그램 팝업에서 최초 1회 팀 코드로 가입, 수집 기간·허용 사이트·로컬 프로젝트 설정 후 '수집 시작'
2. Content Script가 ChatGPT 화면에서 설정 기간 중 새로 완료된 발화(사용자·AI)를 자동 추출
3. Background Service Worker가 Native Messaging으로 발화를 동균님의 Mac 로컬 수집기에 전달
4. 로컬 수집기가 웹 발화 + 선택한 프로젝트의 Codex·Claude Code 발화를 전처리하고, 필요한 발췌만 외부 AI로 분류
5. 분류된 후보 카드는 확장 프로그램의 '개인 검토함'(비공개)에 표시 → 사용자가 확인·수정·승인
6. 승인한 카드와 근거 발췌만 팀 서버(/items/approve)로 전송 → 서버가 충돌 검사
7. 팀 웹(Next.js)에서 팀 결정 보드와 충돌 경고를 보고 해결

※ 승인 전 분석·후보 조회는 로컬 수집기 담당이라 팀 서버 /analyze는 사용하지 않음

## 4. 기술 스택
- 확장 프로그램: Chrome Extension Manifest V3, WXT, React, TypeScript, Tailwind
  - Content Script(ChatGPT DOM 추출), Background Service Worker, Native Messaging, chrome.storage
- 팀 웹: Next.js(App Router), TypeScript, Tailwind, shadcn/ui, lucide-react, Pretendard 폰트, sonner(토스트)
- 파일 처리: JSZip (ChatGPT 내보내기 zip을 브라우저 안에서 열기)
- 배포: 웹은 Vercel, 확장 프로그램은 개발자 모드로 직접 설치해 시연

## 5. 폴더 구조
- /extension : WXT 확장 프로그램
- /web : Next.js 팀 웹
- /shared : 두 프로젝트가 같이 쓰는 타입 정의(카드, 충돌 등)와 목업 데이터

## 6. 데이터 형식 (하은님·동균님과 최종 확정 필요, 우선 이 형식으로 목업 개발)
```
Card {
  id: string
  category: "결정" | "조사" | "할 일" | "제안" | "개인"
  topic: "서비스명" | "타깃 사용자" | "핵심 기능" | "MVP 범위" | "기술 스택" | "역할 분담" | "일정·마감" | "발표 구성" | "기타"
  content: string          // 핵심 내용 요약
  evidence: string         // 대화 원문 발췌
  speaker: "user" | "ai"   // 근거 문장의 화자
  source: "chatgpt-web" | "codex" | "claude-code" | "paste" | "export"
  author: string           // 팀원 이름
  assignee?: string        // 할 일일 때
  due?: string             // 할 일일 때
  createdAt: string
  status: "candidate" | "approved" | "dismissed"
}
Conflict {
  id: string
  topic: string
  cardA: Card
  cardB: Card
  judgement: "같음" | "변경" | "충돌"
  reason: string
  resolution?: "keep-existing" | "adopt-new" | "both-valid"
  resolutionNote?: string
}
```
규칙: AI가 추천만 한 내용은 '제안'으로 분류(사용자가 동의해야 '결정')

## 7. 기능 목록과 우선순위
### [MVP 11/8 필수]
A. 확장 프로그램 팝업
  - 최초 1회 팀 코드 가입·로그인 계정 확인
  - 수집 기간, 허용 사이트, 로컬 프로젝트 설정
  - 이후 수집 상태, 종료 시각, 미검토 카드 수 표시, '수집 시작' / '일시중지' 버튼
B. ChatGPT 대화 자동 추출
  - 설정 기간 중 새로 완료된 발화 단위로 추출(대화마다 버튼 누를 필요 없음)
  - 사이트별 추출 코드는 파일을 분리(ChatGPT 화면 구조가 바뀌면 그 파일만 수정)
C. 로컬 수집기 연동
  - Background에서 Native Messaging으로 발화 전달, 후보 카드 조회
  - 분류 완료 시 팝업의 후보 수 갱신
D. 개인 검토함 (확장 프로그램 내부의 비공개 승인 화면)
  - 후보를 결정·조사·할 일로 표시, 출처와 화자별 근거 확인·수정
  - 체크한 카드만 /items/approve로 전송
  - 백업 입력 1: 대화 붙여넣기 입력창 (자동 추출 실패 시)
  - 백업 입력 2: ChatGPT 내보내기 zip 또는 conversations.json 업로드
    → JSZip으로 브라우저 안에서 열고, 대화 목록(제목·날짜)에서 팀 관련 대화만 선택
    → 원본 파일은 서버에 보내지 않고, 붙여넣기와 같은 로컬 전처리·승인 절차를 거침
E. 팀 웹
  - 팀 결정 보드: 주제별·시간순 목록, 분류 필터 탭
  - 충돌 경고: 충돌한 두 결정과 근거 문장을 나란히 표시,
    '기존 결정 유지 / 새 결정 채택 / 둘 다 유효' 선택 + 처리 이유 입력 → /conflicts/{id}/resolve
  - 팀 기록 복사: 팀 결정 기록을 AI에 붙여넣기 좋은 텍스트로 변환해 클립보드 복사
F. 상태·에러 처리
  - 로컬 수집기 연결 끊김, 분류 실패, 공유 실패, 충돌 검사 대기를 구분해서 표시

### [11/9 ~ 11/15 확장]
- Claude·Gemini 웹 채팅 지원 추가
- '팀 기록 불러오기': 팀 결정 기록을 AI 입력창에 자동으로 채우기(전송은 사용자가 직접)

## 8. 팀 서버 API (동균님과 형식 확정 전까지 목업으로 개발)
- POST /items/approve : 승인한 카드와 근거 발췌 전송
- GET  /board?team={code} : 팀 결정 보드 조회
- GET  /conflicts?team={code} : 충돌 목록 조회
- POST /conflicts/{id}/resolve : 충돌 해결(resolution, resolutionNote)
- API 주소는 환경변수로 관리 (웹: NEXT_PUBLIC_API_URL)

## 9. 개인정보·보안 원칙 (반드시 지킬 것)
- 최초 설정에서 자동 수집 범위와 외부 AI 전송을 사용자에게 안내
- 설정한 종료 시각에는 새 발화 수집과 외부 전송을 중단
- 팀 서버에는 본인이 승인한 카드와 확인한 근거 발췌만 전송, 원본 대화 전체는 보내지 않음
- API 키 등 비밀값은 .env에만 두고 .gitignore에 추가 (깃허브 레포가 Public)

## 10. 시연 시나리오 (11/8까지 이 흐름이 끝까지 동작해야 함)
한 번 설정 → ChatGPT 웹·코딩 도구 대화에서 후보 자동 생성 → 한 장만 승인
→ 동료 팀 보드에 그 한 장만 표시 → 충돌 경고 확인·해결 → 종료 시각 후 수집 중단

## 11. 개발 방식
- 백엔드가 준비되기 전에는 /shared의 목업 데이터와 가짜 API로 화면부터 완성
- Native Messaging, 팀 API 연결부는 인터페이스로 분리해서 목업 ↔ 실제 연결을 쉽게 교체
- 디자인은 김민규님의 Figma 기준, 나오기 전에는 shadcn/ui 기본 스타일로 개발
- 작업 단위마다 실행 확인 후 커밋
