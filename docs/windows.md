# Windows에서 쓰기

로컬 수집기는 macOS와 Windows에서 돈다. 이 문서는 Windows에서만 다른 점, 자동 검사, 실제 PC 검증 목록과 기록을 모은다. 공통 실행 순서는 [running.md](running.md), 팀 서버와 키 발급은 [team-server.md](team-server.md)에 있다. 팀원에게 보내는 설치·검증 안내는 [windows-teammate-prompt.md](windows-teammate-prompt.md)이다.

## 1. 현재 상태

- `collector/runtime.py`의 `ENABLED_PLATFORMS`와 `scanner/src/main.rs`의 `ENABLED_OS`에 Windows가 켜져 있다. Linux는 주석이다. `checks/check_portability.py`가 두 목록이 같은지 확인한다.
- 자동 검사는 GitHub Actions `windows-collector`(windows-2022, 영어 Windows)에서 돈다([3절](#3-자동-검사-github-actions-windows-collector)). 이 구조에서는 2026-11-14 커밋 `b7860da`로 154개가 통과했다(링크 생성 권한이 필요한 1개는 건너뜀).
- 실제 PC 검증: 2026-11-14 단비 님(Windows 11 Home 25H2, 한국어·코드 페이지 949, Chrome 157, 확장 0.2.2). 결과와 고친 것은 [5절](#5-검증-기록)에 있다. ChatGPT 프로젝트 동기화(확장 0.2.8 이후)는 Windows에서 아직 시험하지 않았다.

## 2. 설치와 실행

수집기는 팀 서버 연결 없이는 시작하지 않는다. 팀 서버 주소와 관리자에게 받은 개인 연결 키 파일이 필요하다.

### Python 없이: `syncup.exe` 묶음

`windows-collector` 워크플로가 만드는 아티팩트 `syncup-windows-x64`에는 `syncup.exe`와 `_internal` 폴더가 들어 있다. Python 3.12 런타임, Rust 스캐너, AI 프롬프트가 함께 묶여 있어서 Python·Rust를 따로 설치할 필요가 없다. 빌드는 `collector/windows_bundle.py`(PyInstaller)가 한다. 둘을 함께 `%LOCALAPPDATA%\SyncUp`처럼 옮기지 않을 위치에 푼다. 폴더를 옮기면 Chrome 연결 파일을 다시 만든다.

| 원본으로 실행 | 묶음으로 실행 |
|---|---|
| `python collector/app.py run ...` | `syncup.exe run ...` |
| `python collector/prepare_native.py ...` | `syncup.exe native-setup ...` |

옵션은 같다. `native-host`는 Chrome이 실행하는 것이라 직접 쓰지 않는다. 코드 서명이 없어 처음 실행할 때 SmartScreen 경고가 나올 수 있다. 빌드할 때마다 SHA-256이 달라지므로, 받은 아티팩트가 어느 커밋의 실행에서 나왔는지는 Actions 실행 화면에서 확인한다.

### 원본에서

Python 3.11 이상이 필요하다. 스캐너를 빌드하려면 rustup의 MSVC 도구 모음과, 번들 SQLite를 컴파일할 Visual Studio Build Tools의 C++ 빌드 도구가 필요하다. PowerShell에서 저장소 루트에서 실행한다. [running.md](running.md)의 `python3`는 `python`으로 바꿔 쓴다.

```powershell
cargo build --release --locked --manifest-path scanner/Cargo.toml
New-Item -ItemType Directory -Force bin
Copy-Item scanner\target\release\syncup-scanner.exe bin\
```

`.cargo/config.toml`이 C 런타임을 정적 링크한다. 그래서 `syncup-scanner.exe`는 Visual C++ 재배포 패키지 없이 실행된다.

### Windows에서 알아 둘 것

- **비공개 파일은 ACL로 지킨다.** macOS의 umask 077·권한 600 대신 `collector/windows_security.py`를 쓴다. 비어 있는 상태 폴더에는 현재 사용자와 SYSTEM만 들어오는 ACL을 설정하고, 안의 파일이 이를 물려받는다. 이미 파일이 있는 폴더는 ACL을 바꾸지 않고, 다른 계정이 접근할 수 있으면 시작을 거절한다. 연결 키 파일과 `connection.json`은 현재 사용자 소유인지, 현재 사용자·SYSTEM·Administrators·OWNER RIGHTS 밖의 계정이 들어올 수 없는지 확인한 뒤 읽는다. 상태 폴더는 ACL이 있는 NTFS 드라이브에 둔다.
- **키 파일은 사용자 폴더 바로 아래에 둔다**(예: `%USERPROFILE%\syncup-team.key`). OneDrive처럼 동기화되는 폴더는 피한다. Windows용 Codex를 쓰면 Codex가 만지는 폴더에 `CodexSandboxUsers` 읽기 권한이 붙고, 그 폴더에서 옮긴 파일에도 남는다. 이때 수집기는 `연결 키 파일에 다른 계정의 읽기 권한이 있습니다(예: Codex의 CodexSandboxUsers)…`로 멈춘다. 다음 명령으로 기본 권한으로 되돌린다.
  ```bat
  icacls "%USERPROFILE%\syncup-team.key" /reset
  ```
- **검토함은 저절로 열리지 않는다.** 수집기가 출력한 `개인 검토함 http://127.0.0.1:8876/` 주소를 브라우저에서 직접 연다.
- **단독 모드 검토함은 보류 작업을 보여 주지 않는다.** `OPENAI_API_KEY`나 로컬 개인정보 모델(Ollama)이 없으면 모든 발췌가 보류된다. 단독 모드(`--integrated` 없음)에는 보류 처리 화면이 없어 검토함은 "아직 후보가 없습니다"로 남는다([privacy.md 8장](privacy.md#8-알려진-한계)). 보류 목록은 통합 모드의 개인 검토함(`/review`)에서 본다.
- **로컬 웹 연결 링크는 한 번만 열 수 있다.** `collector/local_web.cjs`가 출력한 링크를 두 번째로 열면 "연결 링크가 만료되었거나 이미 사용되었습니다"가 나온다. 정상이다. 다시 열려면 실행기를 다시 시작해 새 링크를 받는다.
- **Chrome 연결은 레지스트리로 등록한다.** `native-setup`(원본은 `prepare_native.py`)은 출력 폴더에 `syncup-native.cmd`와 매니페스트를 만들고, 현재 사용자 레지스트리에 등록하는 명령을 출력한다. 관리자 권한은 필요 없다.
  ```bat
  reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.syncup.collector" /ve /t REG_SZ /d "<출력 폴더>\com.syncup.collector.json" /f
  ```
  `syncup-native.cmd`는 PC의 코드 페이지로 쓰고, 사용자 폴더 경로는 `%USERPROFILE%`로 바꿔 쓴다. 코드 페이지에 없는 문자가 든 경로(예: 영어 Windows의 한글 폴더)면 UTF-8로 쓰고 `chcp 65001`로 바꾼다. 압축을 푼 확장 폴더를 옮기면 확장 ID가 바뀌므로 연결 파일을 다시 만든다.
- **스캐너가 실패하면 원인 종류가 남는다.** 검토함 상태 줄에 `대화 기록 확인 실패 · codex: io PermissionDenied`처럼 실패한 부분(`codex`·`claude`)과 종류(`database`, `io <종류>`, `log format`)가 나온다. 수집기 로그의 `collection_scan` 줄 `detail`에는 스캐너 오류 출력의 끝부분(200자 이내)이 남는다. 스캐너는 경로나 대화 내용을 출력하지 않는다.

## 3. 자동 검사: GitHub Actions `windows-collector`

[.github/workflows/windows.yml](../.github/workflows/windows.yml)이 windows-2022(x64, 영어 Windows)에서 실행한다. GitHub 저장소에 올린 브랜치의 Actions 탭에서 Run workflow를 누르거나, `collector/`·`contract/`·`ai/`·`scanner/`·`checks/`·`.cargo/`를 바꾼 push와 PR에서 자동으로 돈다. 모든 단계는 앞 단계가 실패해도 계속 실행된다. 사용자처럼 `PYTHONUTF8` 없이 실행한다. 공개 저장소는 무료이고, 비공개 저장소는 계정의 포함 사용량을 쓴다(한 번에 약 4분).

| 단계 | Windows에서만 확인되는 것 |
|---|---|
| Build the Rust scanner | MSVC로 `syncup-scanner.exe` 빌드(번들 SQLite, C 런타임 정적 링크). `VCRUNTIME` 의존이 생기면 실패. 아티팩트 `syncup-scanner-windows-x64` |
| Package the app | PyInstaller로 `syncup.exe` 묶음(`collector/windows_bundle.py`). 아티팩트 `syncup-windows-x64` |
| `checks/check_windows_bundle.py` | 묶음을 Python 설정 없이 실행: 사용법, 가짜 팀 서버에 연결한 `syncup.exe run`이 한글 프로젝트의 가상 Codex·Claude Code 로그를 묶인 스캐너로 수집, 파이프 출력 UTF-8, `native-setup` → `cmd.exe` 실행기 → `native-host` 중계(`a & b 100%`, 한글 폴더) |
| Install Chrome for Testing, `checks/check_windows_chrome.py` | 실제 Chrome이 시험용 확장(`checks/windows_chrome_probe/`)의 `sendNativeMessage`를 받아 HKCU 레지스트리에서 host를 찾고 실행기를 직접 시작한다. 수집기 응답이 확장까지 돌아오고, Chrome이 쓴 명령줄을 기록한다. 일반 Chrome은 명령줄로 압축 해제 확장을 올리지 못해 Chrome for Testing을 쓴다 |
| `checks/check_windows_support.py` | 실제 ACL(상태 폴더 비공개, 다른 계정 허용 시 거절, 다른 계정이 읽을 수 있는 기존 폴더 거절), 키 파일 오류 문구, 원본 실행기의 `cmd.exe` 중계, 시간대 DB 없는 시작, BOM 키 파일, 포트 독점과 재시작 직후 재사용 |
| `checks/check_pipeline.py` | `connection.json`의 링크·Users 읽기 허용(ACL) 거절 |
| `checks/check_portability.py` | 실제 `.exe`로 한글·공백 경로 수집, 스캐너 실패 종류 출력, 환경 변수 대소문자, OS 게이트 |
| `checks/check_scanner_codex.py`, `checks/check_scanner_claude.py` | Windows 경로(`C:\...`, `\\?\` 정규화)에서 Codex·Claude Code 로그 수집 |
| `checks/check_sync_intake.py` | ChatGPT 프로젝트 동기화의 창·접수·중복 처리(수집기 쪽) |
| `checks/check_integrity.py` | `app.py run`, 가짜 팀 서버로 전송·재시도, 실제 `msvcrt` 잠금(같은 상태 폴더 중복 실행 차단), 재시작, 루프백 HTTP |

Chrome이 host를 시작하는 실제 명령줄(Chrome 157): `C:\Windows\system32\cmd.exe /d /s /c ""<실행기>.cmd" chrome-extension://<ID>/ --parent-window=0" < \\.\pipe\chrome.nativeMessaging.in.… > \\.\pipe\chrome.nativeMessaging.out.…`. 실행기 검사는 이 형식(파이프 제외)으로 실행한다.

## 4. 실제 PC 검증 목록

**상태: 2026-11-14에 1~11번을 예전 구조·확장 0.2.2로 확인했다([5절](#5-검증-기록)). 이 구조와 확장 0.2.11 이상으로 다시 해야 한다.** 동기화 단계(10~13)는 처음이다.

준비: Windows 10/11 x64, Chrome, Codex CLI 또는 Claude Code, 팀 서버 주소와 본인 연결 키 파일(사용자 폴더 바로 아래), 빈 시험 프로젝트 폴더. 묶음을 쓰면 Python은 필요 없다. 대화는 외부 AI로 갈 수 있으므로 시험용 내용만 쓴다. 아래 `<팀>`은 `--team-api <팀 서버 주소> --team-token-file %USERPROFILE%\syncup-team.key --team-id <팀 ID>`를 줄인 것이다.

| # | 할 일 | 기대 결과 | 남긴 이유 |
|---|---|---|---|
| 1 | **브라우저로** 아티팩트 `syncup-windows-x64`를 받아 `%LOCALAPPDATA%\SyncUp`에 풀고 명령 프롬프트에서 `syncup.exe` 실행 | 사용법이 나온다. SmartScreen이 막으면 "추가 정보 → 실행" 후 다시 묻지 않는다. Defender가 격리하지 않는다 | 지난번에는 `gh run download`로 받아 인터넷 표시(Zone.Identifier)가 없었고, SmartScreen 반응을 보지 못했다 |
| 2 | `syncup.exe run --project <시험 프로젝트> --state %USERPROFILE%\syncup-state\단독 <팀>` | `개인 검토함 http://127.0.0.1:8876/ · 팀 연결 확인됨`과 "브라우저는 저절로 열리지 않습니다" 안내가 나온다. 주소를 직접 열면 검토함이 보인다 | 실제 사용자 환경 |
| 3 | 그 프로젝트 폴더에서 새 Codex 세션으로 대화 1턴 | 키와 Ollama가 있으면 몇 초 안에 검토함에 후보가 생긴다. 없으면 보류되어 검토함은 "아직 후보가 없습니다"로 남는다(알려진 한계, 2절). 상태 줄에 `대화 기록 확인 실패`가 없어야 한다. 있으면 뒤의 종류(`codex: …`)를 적는다 | 실제 Codex의 Windows 로그(`%USERPROFILE%\.codex`). 지난번에 처음 설치하던 몇 분 동안 스캔 실패가 반복됐는데 원인이 남지 않았다. 이제는 종류가 남는다 |
| 4 | 같은 프로젝트에서 새 Claude Code 세션으로 대화 1턴 | 3과 같다. `%USERPROFILE%\.claude\projects\`의 폴더 이름이 프로젝트 경로에서 계산한 이름(`C--Users-...`)과 같다 | 실제 Claude Code의 Windows 폴더 이름 |
| 5 | 2를 끄고 `syncup.exe run --integrated --project <시험 프로젝트> --state %USERPROFILE%\syncup-state\통합 <팀>` | 팀 연결 확인 메시지와 함께 시작하고 상태 폴더에 `connection.json`이 생긴다. 키 파일 권한 문제면 일반 문구가 아니라 `icacls … /reset` 안내가 나온다(2절) | 지난번에는 Codex가 붙인 `CodexSandboxUsers` 권한 때문에 실패했고 원인이 가려졌다 |
| 6 | `web\public\syncup-extension.zip`(0.2.11 이상)을 풀어 `chrome://extensions` 개발자 모드에서 불러오고, 표시된 ID로 `syncup.exe native-setup --extension-id <ID> --connection %USERPROFILE%\syncup-state\통합\connection.json --output %USERPROFILE%\syncup-native` | 매니페스트 경로와 `reg add` 명령이 출력된다 | 7·8의 준비. 동기화는 0.2.8 이후 확장에만 있다 |
| 7 | 출력된 `reg add` 실행 후 `reg query HKCU\Software\Google\Chrome\NativeMessagingHosts\com.syncup.collector` | 기본값이 매니페스트 경로다 | 사람이 실행하는 등록 명령 |
| 8 | Chrome을 완전히 다시 시작하고 확장 팝업 열기 | 팀 이름이 보이고 수집기 오류가 없다. 콘솔 창이 깜빡이지 않는다. "Specified native messaging host not found"는 등록 문제, "로컬 수집기 연결 실패"는 5가 꺼졌거나 연결 파일 문제다 | CI는 Chrome for Testing과 시험용 확장으로 확인했다. 남은 것은 일반 Chrome과 실제 확장이다 |
| 9 | ChatGPT 화면에서 대화 몇 턴 후 팝업에서 "지금 분류하기" | 오류가 없다. 키와 모델이 있으면 검토 대기 카드가 늘고 출처 시각이 한국 시간이다 | 화면 수집 전체 흐름. 지난번에는 키가 없어 출처 시각을 보지 못했다 |
| 10 | chatgpt.com 탭을 연 채 팝업에서 '프로젝트만 수집'을 켜고 시험용 ChatGPT 프로젝트를 고른 뒤 동의 | 상태 줄이 `동기화: N분 전 · <프로젝트>`가 된다 | 동기화는 Windows에서 처음이다 |
| 11 | 휴대폰이나 다른 기기에서 그 프로젝트에 대화 1턴 후 팝업에서 '싱크 맞추기' | 오류가 없다. 키와 모델이 있으면 검토 대기 카드가 는다 | 다른 기기 대화가 이 PC 수집기로 들어오는지 |
| 12 | 수집기(5)를 끈 채 팝업에서 동기화 끄기, 그 뒤 수집기 다시 켜기 | 끌 때 `수집기에 끄기를 전하는 중이에요`가 나오고, 수집기를 켜면 사라진다 | 수집기와 확장이 따로 꺼지는 경우 |
| 13 | Chrome을 다시 시작하고 5분 넘게 기다리기 | 상태 줄의 "N분 전"이 5분 안쪽으로 갱신된다 | Windows에서 5분 주기가 다시 도는지 |
| 14 | (선택) `set SYNCUP_CONNECTION_FILE=%USERPROFILE%\syncup-state\통합\connection.json` 후 `node collector\local_web.cjs`, 출력된 링크를 두 번 열기 | 처음은 `/review`가 열리고, 두 번째는 만료 문구가 나온다. 실행기는 "한 번만 열 수 있습니다" 안내를 출력한다 | Windows에서는 웹 중계가 연결 파일 ACL을 아직 확인하지 않는다(단비 님 몫) |
| 15 | (선택) **한글 사용자 이름 계정**에서 2~8 반복, 저장소에서 `python checks\check_windows_support.py`와 `python checks\check_windows_bundle.py`(묶음을 `dist\syncup\`에 둔다) | 같은 결과, 두 검사 모두 OK | 한글 사용자 이름의 `%USERPROFILE%` 치환과 Claude 폴더 이름(글자마다 `-`)은 아직 실제로 돈 적이 없다 |
| 16 | (선택) Windows on ARM에서 1~4 | x64 묶음이 에뮬레이션으로 돈다 | ARM 실행 환경 |

끝나면 `reg delete HKCU\Software\Google\Chrome\NativeMessagingHosts\com.syncup.collector /f`로 등록을 지울 수 있다.

## 5. 검증 기록

### 2026-11-14 CI (이 구조, `feat/windows-local` `b7860da`)

windows-2022, Python 3.12, MSVC Rust, Chrome for Testing 157.0.8103.78. 6분 남짓 걸렸고 모든 단계가 첫 실행에 통과했다.

| 단계 | 시험 수 |
|---|---|
| `check_windows_bundle.py` (묶음, 가짜 팀 서버) | 3 |
| `check_windows_chrome.py` (실제 Chrome, 레지스트리, 명령줄) | 2 |
| `check_windows_support.py` (실제 ACL, 키 파일 문구, 스캐너 오류 기록, 실행기) | 30 |
| `check_pipeline.py` | 17 |
| `check_portability.py` (스캐너 실패 종류 포함) | 9 (1개 건너뜀) |
| `check_scanner_codex.py`, `check_scanner_claude.py` | 12, 18 |
| `check_sync_intake.py` (동기화 접수) | 48 |
| `check_integrity.py` | 15 |

Chrome이 쓴 명령줄은 예전 기록과 같았다. 스캐너·묶음 아티팩트는 2027-02-12까지 보관된다.

### 2026-11-14 실제 PC (단비 님, 예전 구조 `claude/windows-local` `a9b79f3`, 확장 0.2.2)

환경: Windows 11 Home 25H2(빌드 26200), 한국어, 코드 페이지 949, 영문 사용자 이름, Chrome 157.0.8103.51, Codex CLI 0.169.0, Claude Code 2.1.323, Python 3.13.2. OpenAI 키·Ollama 없음.

| 단계 | 결과 |
|---|---|
| 묶음 실행, Defender | 통과. SmartScreen은 내려받기 방식 때문에 보지 못했다 |
| 단독 실행, Codex·Claude Code 수집 | 수집 통과. 키·모델이 없어 모두 보류됐고, 단독 모드 검토함에는 보이지 않았다(알려진 한계) |
| 통합 실행 | 키 파일에 Codex가 붙인 `CodexSandboxUsers` 권한 때문에 처음 실패, `icacls /reset` 후 통과 |
| 확장 설치, `native-setup`, `reg add`, Chrome 연결, 화면 수집 | 통과. 한글 상태 폴더 경로가 든 실행기가 코드 페이지 949로 정상 실행됐다 |
| `check_windows_support.py`, `check_windows_bundle.py` | OK (링크 생성 권한이 필요한 1개만 건너뜀) |
| 로컬 웹 | 통과. 링크를 두 번째 열면 만료 문구가 나와 헷갈릴 수 있었다 |

이 결과로 고친 것(`feat/windows-local`):

1. 키 파일 문제(경로·권한·형식)를 `team_client.KeyFileError`로 따로 알린다. 예전에는 `_connect_team`의 일반 문구("팀 연결 키, 소속 팀…")에 가려졌다.
2. Windows 키 파일 권한 문구와 이 문서에 `CodexSandboxUsers`와 `icacls /reset`을 넣었다.
3. 스캐너가 실패한 부분과 종류를 경로 없이 출력하고, 수집기는 그 끝부분을 로그(`detail`)와 상태 줄에 남긴다. 예전에는 스캐너 출력을 버려 반복된 스캔 실패의 원인을 알 수 없었다.
4. 검증 목록의 기대 결과를 단독 모드 검토함의 한계에 맞췄다.
5. 수집기는 "브라우저는 저절로 열리지 않습니다", 로컬 웹 실행기는 "이 링크는 한 번만 열 수 있습니다" 안내를 출력한다.

참고로 확인하지 못한 관찰: Codex 대화 1턴의 근거 발췌가 사용자 발화 2개로 잡혔다. Codex가 넣는 환경 안내 문구가 사용자 발화로 잡혔을 수 있다.

### 2026-11-12~13 CI (예전 구조)

windows-2022에서 99개 통과. 그 과정에서 시험의 SQLite 연결 미종료(WinError 32), 스캐너의 `VCRUNTIME140.dll` 의존, Chrome 실제 명령줄의 `/s`를 고쳤다.

## 6. 아직 확인하지 못한 것

- 일반 Chrome과 확장 0.2.11의 연결, ChatGPT 프로젝트 동기화 전부(4절 8~13).
- 실제 Codex·Claude Code가 쓰는 Windows 로그로 후보 만들기(키·모델이 있는 PC).
- 한글 사용자 이름 계정, 서명 없는 묶음에 대한 SmartScreen, Windows on ARM, FAT32·exFAT 드라이브.
- 웹 중계(`web/src/app/api/local/route.ts`)의 Windows 연결 파일 검사. 지금은 win32에서 소유자·권한·링크 검사를 건너뛴다.
