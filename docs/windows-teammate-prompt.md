# Windows 팀원용 설치·검증 프롬프트

Windows PC가 있는 팀원에게 보내는 안내다. 아래 상자 안의 글을 그 PC의 AI 코딩 도구(Claude Code, Codex 등)에 그대로 붙여 넣는다. 사람이 직접 따라 해도 된다. 확인 단계의 원본은 [windows.md 4절](windows.md#4-실제-pc-검증-목록)이다. 단계가 바뀌면 이 프롬프트도 함께 고친다.

보내기 전에 준비할 것:
- 팀 서버 주소, 그 팀원의 개인 연결 키 파일(`server/team_admin.py token`, [team-server.md](team-server.md)), 팀 ID. 키 파일은 1:1 대화처럼 그 사람만 받는 경로로 따로 보낸다. 이 프롬프트나 저장소에는 넣지 않는다.
- 이 문서가 든 브랜치를 팀 저장소에 올리고, 그 브랜치의 `windows-collector` 실행이 끝났는지 확인한다. 아래 상자의 `<브랜치>`를 그 이름으로 바꾼다.

```text
너는 내 Windows PC에서 SyncUp 로컬 수집기를 설치하고, Windows에서만 확인할 수 있는 항목을 검증하는 일을 돕는다. 명령은 하나씩 보여 주고, 실행 결과를 보고 다음으로 넘어간다. 내가 직접 해야 하는 일(클릭, 키 입력, Chrome 조작, 대화 입력)은 그때마다 나에게 부탁한다.

## 지켜야 할 것
- 저장소에 커밋하거나 push하지 않는다. 파일은 읽기만 하고, 결과는 저장소 밖에 쓴다.
- API 키와 팀 연결 키를 화면 출력, 결과 문서, 명령 인수에 쓰지 않는다. OpenAI 키는 명령 프롬프트에서 `set OPENAI_API_KEY=...`로만 넣는다. 연결 키는 내 사용자 폴더 바로 아래 파일(`%USERPROFILE%\syncup-team.key`)로만 둔다.
- 결과 문서에는 내 사용자 이름이 들어간 경로를 `<사용자>`로 바꿔 적는다.
- Chrome 설정은 com.syncup.collector 등록 외에는 바꾸지 않는다. 다른 프로그램을 설치해야 하면 먼저 나에게 묻는다.
- 수집할 대화는 시험용 내용만 쓴다. 분류를 위해 외부 AI로 보낼 수 있다.

## 1. 받기
1. 저장소 https://github.com/MInGyu26AI/AI-12team 의 브랜치 `<브랜치>`를 받는다. Git이 있으면 아래 명령을 쓰고, 없으면 GitHub에서 그 브랜치를 Code → Download ZIP으로 받는다.
   git clone --branch <브랜치> https://github.com/MInGyu26AI/AI-12team.git
2. 같은 저장소의 Actions → windows-collector에서 그 브랜치의 가장 최근 성공한 실행을 연다. Artifacts의 `syncup-windows-x64`를 **브라우저로** 받는다(GitHub 로그인 필요). 그래야 SmartScreen 반응을 볼 수 있다. 압축을 `%LOCALAPPDATA%\SyncUp`에 푼다. `syncup.exe`와 `_internal` 폴더가 같이 있어야 하고, 나중에 이 폴더를 옮기면 6단계를 다시 한다.
3. 먼저 읽는다: 저장소의 `docs\windows.md`(2절 "Windows에서 알아 둘 것", 4절 검증 목록 1~16단계가 이번 일의 기준), `docs\running.md`의 "ChatGPT 프로젝트 동기화".
4. 내가 준 연결 키 파일이 사용자 폴더 바로 아래에 있는지 확인한다. Codex를 쓰는 PC면 `icacls "%USERPROFILE%\syncup-team.key"` 결과에 `CodexSandboxUsers`가 있는지 보고, 있으면 `icacls "%USERPROFILE%\syncup-team.key" /reset`으로 되돌린다.

## 2. 검증
`docs\windows.md` 4절의 단계를 순서대로 한다. 각 단계에서 "할 일"을 실행하고 "기대 결과"와 비교한다. 표의 `<팀>`은 `--team-api <팀 서버 주소> --team-token-file %USERPROFILE%\syncup-team.key --team-id <팀 ID>`다. 정리하면 다음과 같다.
- 1단계: 브라우저로 받은 묶음의 `syncup.exe` 실행. SmartScreen과 Defender의 반응을 기록한다.
- 2~4단계: 단독 모드 실행. 검토함 주소는 직접 연다. Codex·Claude Code로 대화 1턴씩 한다. 키나 Ollama가 없으면 보류되어 검토함에 안 보이는 것이 정상이다. 상태 줄에 `대화 기록 확인 실패`가 나오면 뒤의 종류를 그대로 적는다.
- 5단계: `--integrated` 실행. 실패하면 나온 문구를 그대로 적는다.
- 6~9단계: `web\public\syncup-extension.zip`(0.2.11 이상) 확장 설치, `syncup.exe native-setup`, 출력된 `reg add` 실행, Chrome 재시작 후 팝업 확인, ChatGPT 화면 수집.
- 10~13단계: ChatGPT 프로젝트 동기화. 시험용 ChatGPT 프로젝트를 쓰고, 11단계는 휴대폰 등 다른 기기에서 그 프로젝트에 대화한다.
- 14~16단계(선택)는 내가 원할 때만 한다. 15단계는 사용자 이름에 한글이 있을 때 꼭 한다. Python 3.11 이상이 있으면 저장소 폴더에서 아래 두 검사를 돌리고 마지막 줄(OK 또는 FAILED)을 적는다. 받은 묶음의 `syncup.exe`와 `_internal`은 저장소의 `dist\syncup\`에 복사해 둔다.
  python checks\check_windows_support.py
  python checks\check_windows_bundle.py
단계가 실패하면 멈추고 아래 "실패했을 때"의 자료를 모은 뒤 다음 단계로 갈지 나에게 묻는다.

## 실패했을 때 모을 것
- 실행한 명령과 출력 전체(키는 지운다).
- Chrome 연결 문제면 `chrome://extensions`의 SyncUp 확장 "오류" 내용, `reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.syncup.collector` 출력, `%USERPROFILE%\syncup-native\syncup-native.cmd` 내용, Chrome을 `--enable-logging --v=1`로 다시 실행했을 때 `%LOCALAPPDATA%\Google\Chrome\User Data\chrome_debug.log`에서 native 또는 SyncUp이 들어간 줄.
- 수집 문제면 검토함 상태 줄 문구, 수집기 창의 `collection_scan` 줄(`detail` 포함), `%USERPROFILE%\.codex\sessions` 아래 새 파일이 생겼는지, `%USERPROFILE%\.claude\projects\` 아래 폴더 이름.
- 동기화 문제면 팝업 상태 줄 문구 전체.

## 결과 보고
`%USERPROFILE%\Desktop\윈도우_검증_결과_<날짜>.md`에 다음을 쓰고, 그 파일을 동균 님에게 보낸다.
1. 환경: Windows 버전(`winver`), 표시 언어, `chcp` 결과, 사용자 이름에 한글이 있는지(예/아니오만), Chrome 버전, 확장 버전, Codex·Claude Code 버전, Python 버전(있으면), 받은 아티팩트의 실행 번호나 커밋, OpenAI 키·Ollama 유무.
2. 표: 단계 번호 | 결과(통과/실패/건너뜀) | 근거(출력 한두 줄 또는 스크린샷 파일 이름) | 메모.
3. 실패한 단계의 자료(위 목록).
4. 15단계 두 검사의 마지막 줄(했다면).
5. 끝나고 `reg delete HKCU\Software\Google\Chrome\NativeMessagingHosts\com.syncup.collector /f`로 등록을 지웠는지 여부.
```

받은 결과는 [windows.md 5절](windows.md#5-검증-기록)에 날짜·환경과 함께 옮기고, 4절 상태 줄과 6절을 고친다.
