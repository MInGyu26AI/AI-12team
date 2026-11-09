# 싱크업 Chrome 확장

ChatGPT 화면에서 새로 끝난 대화를 읽어 Mac 로컬 수집기(Native Messaging host `com.syncup.collector`)로 보내고,
개인 검토함 웹이 로컬 수집기를 부를 수 있게 중계한다. 분류·개인정보 검사·팀 공유는 로컬 수집기가 한다.
전체 연결 순서는 저장소 루트의 `통합_사용법.md` 4장에 있다.

## 빌드와 설치

```sh
npm ci
npm run build      # .output/chrome-mv3
npm test           # 시험 (vitest, 가짜 browser API)
```

1. `chrome://extensions` 에서 개발자 모드를 켜고 `.output/chrome-mv3` 를 불러온다.
2. 표시된 확장 ID 로 저장소 루트에서 `python3 prepare_native.py --extension-id <ID> --connection <connection.json> --output <새 폴더>` 를 실행하고,
   만들어진 `com.syncup.collector.json` 을 Chrome 의 NativeMessagingHosts 폴더에 등록한다.
3. 팝업에서 프로젝트 주제와 개인 검토함 주소를 저장한다. 웹 브리지는 그 주소의 페이지에만 답한다.
   로컬에서 고친 웹으로 시험할 때는 "로컬 개발 주소 쓰기"를 누르거나 `.env` 에 `WXT_WEB_URL=http://localhost:3000` 을 넣고 빌드한다.

## 웹에 배포 ZIP 올리기

확장을 고치면 `package.json` 버전을 올린 뒤 `npm run zip:web` 을 실행하고 웹을 다시 배포한다.
`web/public/syncup-extension.zip` 과 `web/src/lib/extension-release.json` 이 바뀐다. `npm test` 가 두 파일의 버전을 확인한다.

## 폴더

- `entrypoints/background.ts`: 요청 출처 확인, 로컬 수집기 호출, 30초마다 상태 새로 고침, 우클릭 메뉴
- `entrypoints/ai-chat.content.ts`: ChatGPT 화면의 자동 수집 · "싱크업에 보내기" 버튼
- `entrypoints/web-bridge.content.ts`: 개인 검토함 웹 ↔ 로컬 수집기 RPC 중계 (`shared/bridge.ts`)
- `entrypoints/popup/`: 팝업 (설정 화면 · 수집 상태 화면)
- `lib/collector-rpc.ts` · `lib/collector-status.ts` · `lib/append-turns.ts`: 로컬 수집기 호출, 상태를 확장 저장소로 옮기기와 팝업 오류, 발화 200개씩 보내기
- `lib/auto-collect.ts` · `lib/chat-overlay.ts` · `lib/selection.ts`: 새 메시지 자동 수집(기준선), 채팅 화면 버튼과 안내, 드래그 선택 보내기
- `lib/settings.ts` · `lib/web-url.ts` · `lib/messages.ts`: 확장 저장소 값, 개인 검토함 주소와 신뢰 범위, 확장 내부 메시지 형식
- `lib/sites/`: 사이트별 대화 추출. ChatGPT 화면 구조가 바뀌면 `lib/sites/chatgpt.ts` 의 `SELECTORS` 만 고친다
- `tests/`: vitest 시험. `wxt/testing` 의 가짜 browser 위에서 background 를 띄우고 로컬 수집기 응답은 가짜로 바꾼다
- `scripts/chatgpt-diagnose.js`: ChatGPT 탭 콘솔에 붙여넣는 셀렉터 진단 도구 (결과에 대화 앞부분이 나오니 공유 전에 가린다)
