# 싱크업 팀 웹 (Next.js)

승인함(`/review`), 대화 수집(`/collect`), 팀 결정 기록(`/board`)과 소개·설치 화면이다. 웹·확장 공용 타입과 표시 규칙은 `../shared`에 있다.

## 모드 (`.env.example`)

| 변수 | 값 | 동작 |
|---|---|---|
| `NEXT_PUBLIC_USE_MOCK` | `true` | 예시 데이터 데모. 팀 보드는 이 브라우저(localStorage)에 저장하고, 붙여넣은 대화는 브라우저 안 규칙 분류기(`shared/classify.ts`)로 분류한다. 실제 승인 증거가 아니다. |
| | `false` (기본) | 실제 모드. 로컬 수집기 RPC로 후보를 읽고 팀 서버에 승인한다. 팀과 사용자는 관리자가 미리 등록한다. |
| `NEXT_PUBLIC_LOCAL_BRIDGE` | `false` (기본) | 브라우저 확장(web-bridge 콘텐츠 스크립트)을 거쳐 로컬 수집기에 닿는다. |
| | `true` | 웹 서버의 `/api/local`이 로컬 수집기에 직접 중계한다. `collector/local_web.cjs`로만 실행한다. |

## 실행

```sh
npm ci
npm run dev        # http://localhost:3000
npm run lint
npm run build      # 빌드 결과는 .next-integration (next.config.ts distDir)
npm test           # 승인함 후보·체크 계산, 승인 요청, 공유 폴러, /api/local 실패 응답 시험 (node:test)
```

로컬 브리지로 검증할 때는 저장소 루트에서 실행한다. 자세한 순서는 [docs/running.md](../docs/running.md)에 있다.

```sh
SYNCUP_CONNECTION_FILE=/절대/경로/개인-상태/connection.json node collector/local_web.cjs
```

## 구조

- `src/app/(marketing)`: 첫 화면·소개·이용 방법·확장 설치
- `src/app/(app)`: 대화 수집·승인함·팀 결정 기록, 목업 모드의 팀 만들기·참여
- `src/lib/api`: 팀 결정 기록 API (`mock.ts` 목업, `real.ts` 로컬 수집기 RPC)
- `src/lib/local-collector.ts`: 로컬 수집기 상태를 화면 전체가 나눠 쓰는 폴러
- `src/lib/rpc.ts`: 로컬 수집기 RPC (확장 경유 또는 `/api/local`)
