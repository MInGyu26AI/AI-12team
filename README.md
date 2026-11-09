# SyncUp local collector

## 통합 작업본

기존 로컬 모드에 더해 최신 팀 프론트·AI 분류·Chrome 연결을 통합한 별도 작업본입니다. 실행 절차와 검증 한계는 [통합 사용법](통합_사용법.md), 결과는 [통합 검증](통합_검증.md)을 확인하세요. 기본 CLI 실행은 기존 모드를 유지하며 `--integrated`로 통합 모드를 선택합니다.

Codex·Claude Code의 새 대화를 Rust로 읽고, Python으로 AI 분류·초안 작성과 개인 검토를 처리하는 Mac 프로그램이다. 팀 보드에는 사용자가 승인한 문구와 근거만 전송한다. 기본 실행은 기존 로컬 시연 보드이며, 선택적으로 사용자 인증과 PostgreSQL 팀 접근 정책이 있는 공유 서버에 연결할 수 있다. 공유 서버 구현은 포함하지만 운영 배포는 하지 않았다.

## 빌드

Python 3.11 이상과 Rust 2024 edition을 지원하는 도구 모음이 필요하다. 검증한 Rust 버전은 1.95.0이며 개인 검토 앱에는 Python 추가 패키지가 없다. 선택 사항인 팀 서버에만 `requirements-team.txt`의 PostgreSQL 드라이버가 필요하다. 이 저장소 루트에서 실행한다.

```sh
cargo build --release --locked
mkdir -p bin
cp target/release/syncup-collector bin/syncup-collector
```

실행 파일은 Git에 포함하지 않는다. 다른 위치에 빌드 결과를 저장하도록 `CARGO_TARGET_DIR`를 지정했다면 그 위치에서 실행 파일을 복사한다.

## 실행

실행 환경에 `OPENAI_API_KEY`를 준비한 뒤, 수집할 프로젝트와 새 상태 폴더를 지정한다. 키를 소스나 명령 인수에 직접 넣지 않는다.

```sh
python3 app.py run --project /절대/경로/프로젝트 --state /절대/경로/새-상태-폴더
```

기본 개인 검토함은 `http://127.0.0.1:8876/`, 로컬 보드는 `http://127.0.0.1:8877/`이다. 새 상태 폴더의 기본 수집 기간은 120분이다. 개인 검토함에서 일시중지할 수 있다. 이미 승인한 전송 대기열은 수집 일시중지·종료 후에도 처리한다.

팀 서버를 쓸 때는 관리자가 발급한 개인 연결 키 파일을 지정한다. 개인 검토함에서 공유 대상 팀을 선택하며, 승인 시 대상 팀과 사용자·서버가 고정된다. 이후 팀을 바꿔도 기존 대기열은 원래 팀으로만 전송한다. 팀 소속이 해제되거나 키가 폐기되면 전송을 차단한다.

```sh
python3 app.py run --project /프로젝트 --state /개인-상태 \
  --team-api https://팀서버주소 --team-token-file /안전한/개인연결.key
```

[팀 서버 설치·사용법](팀_서버_사용법.md)과 [팀 격리 검증 범위](팀_격리_검증.md)를 참고한다. 기존 로컬 승인은 원격 팀에 자동 전송하지 않는다. 상태 폴더를 다른 사용자나 다른 서버에 재연결할 수 없으며, 그 경우 새 폴더가 필요하다.

수집 대상은 해당 프로젝트에서 수집 시작 이후 생성된 새 Codex·Claude Code 세션이다. 발췌는 공유 승인 전에 외부 OpenAI API로 보내 분류·초안을 만든다. 팀 공유 승인은 외부 AI 분석 동의와 별개다. 통합 모드에서는 ChatGPT Chrome 확장과 선택한 내보내기·붙여넣기 입력도 지원한다. 일반 Claude 웹 자동 수집은 포함하지 않는다.

Node의 환경 파일 옵션을 사용하는 실행 방법과 포트·기간·Claude 설정 폴더 변경은 [사용법](사용법.md)에 설명했다.

## 저장 위치와 OS 활성화

현재 실행은 **macOS만 활성화**되어 있다. Windows·Linux용 처리는 소스에 보존했지만 `runtime.py`의 `ENABLED_PLATFORMS`와 `src/main.rs`의 `ENABLED_OS`에서 두 연결 항목을 주석 처리했다. Python 앱과 Rust 수집기 모두 비활성 OS에서 데이터 접근 전에 종료한다. 환경 변수로 활성화하는 우회 옵션은 없다.

| 항목 | 우선순위 |
| --- | --- |
| Codex 루트 | `--codex-dir` → `CODEX_HOME` → 사용자 홈의 `.codex` |
| Codex SQLite 폴더 | `--codex-sqlite-dir` → Codex 루트 `config.toml`의 `sqlite_home` → `CODEX_SQLITE_HOME` → Codex 루트 |
| Claude 루트 | `--claude-dir` → `CLAUDE_CONFIG_DIR` → 사용자 홈의 `.claude` |
| Claude 프로젝트 폴더명 | `--claude-project-name` → `CLAUDE_CODE_PROJECT_DIR_NAME` → 프로젝트 경로에서 계산 |

Claude 폴더명 환경 변수는 `CLAUDE_CONFIG_DIR` 또는 `--claude-dir`을 함께 지정했을 때 반영한다. 모든 경로는 `~`를 확장한다. 상대 경로는 실행 디렉터리를 기준으로 하되 `config.toml` 안의 `sqlite_home`은 해당 설정 폴더를 기준으로 한다. 프로젝트·관리자·프로필별 Codex 설정 병합은 구현하지 않았으므로 그런 설정에서 DB를 옮겼다면 `--codex-sqlite-dir`로 실제 위치를 지정한다.

수집기는 DB 폴더의 가장 높은 버전 `state_*.sqlite`를 선택한다. 필요한 `threads` 필드가 없으면 오류로 처리하며 이전 DB로 조용히 돌아가지 않는다. JSONL 내부 형식 변경에 대한 자동 호환까지 보장하지는 않는다.

```sh
python3 app.py run --project /프로젝트 --state /새-상태 \
  --codex-dir /대화/Codex --codex-sqlite-dir /색인/Codex \
  --claude-dir /대화/Claude --claude-project-name work
```

Windows용 실행 파일명은 `syncup-collector.exe`, macOS·Linux는 `syncup-collector`다. OS별 네이티브 빌드가 필요하다. Windows 잠금은 `msvcrt`, macOS·Linux 잠금은 `fcntl`을 사용한다. 현재 제공된 로컬 실행 파일은 Apple Silicon Mac용이다.

## 검사

`model` 묶음을 뺀 모든 검사는 임시 데이터와 가짜 AI 응답만 쓴다. 진입점은 `run_checks.py` 하나이며, 필요한 환경별로 묶여 있다. 고른 묶음의 검사는 하나가 실패해도 끝까지 돌고, 하나라도 실패하면 종료 코드가 0이 아니다.

```sh
python3 run_checks.py            # local: Docker·Rust·로컬 모델 없이 (기본값)
python3 run_checks.py rust       # 먼저 Rust 실행 파일(bin/syncup-collector)을 빌드해야 한다
python3 run_checks.py team       # Docker와 requirements-team.txt 가 필요하다
python3 run_checks.py all        # local + rust + team
python3 run_checks.py --list     # 어떤 검사가 무엇을 다루는지 목록만 출력
```

| 묶음 | 필요 환경 | 다루는 범위 |
|---|---|---|
| `local` | Python 3, Node, `web/` 에서 `npm ci` (웹 연결 검사가 Next를 띄움. TS 가림 검사는 `extension/` 의존성으로도 됨) | 로컬 수집·배치·후보, 개인정보 필터, 보존 정책, 재시도·복구, 웹 연결, AI 모듈, 가림 공용 사례(Python·TS) |
| `rust` | Rust 빌드 결과 | Codex·Claude Code 로그 스캐너, 이식성 |
| `team` | Docker, `python3 -m pip install -r requirements-team.txt` | 팀 격리(RLS), 로컬 ↔ 팀 서버 통합, 충돌 검사 재개, DB 운영·복구 |
| `model` | 로컬 Ollama 모델 (선택 측정, `all` 에 포함하지 않음) | 실제 로컬 개인정보 모델 측정 |

팀 서버 검사는 실제 PostgreSQL 컨테이너를 따로 만들고 가상 사용자·팀 데이터만 쓴 뒤 종료한다. 기존 DB나 팀 서버를 검사 대상으로 쓰지 않는다. 외부 API를 부르는 `selfcheck.py --live` 는 러너에 넣지 않았다. `check_ui_fixture.py` 는 화면 확인용 합성 서비스를 띄우는 도구라 검사 목록에 없다.

가림 규칙은 Python(`ai/syncup_ai/mask.py`)과 웹 목업용 TypeScript 사본(`shared/classify.ts`) 두 곳에 있다. 둘 다 `shared/mask-cases.json` 의 같은 기대 결과로 검사하므로, 한쪽 규칙을 고치면 사례를 먼저 더하고 두 구현을 함께 맞춘다.

## 저장소 범위

소스·의존성 잠금 파일·검사 코드·사용 문서만 관리한다. 키 파일, 대화 JSONL, SQLite 상태, 백업, 로그, 캐시와 실행 파일은 `.gitignore`로 제외한다. 검사 데이터는 코드에서 생성한 가상 값이다. 제외한 기존 로컬 파일은 삭제하지 않는다.

Claude 로그는 내부 형식에 의존하며 변경 시 수집이 누락될 수 있다. 자동 가림은 일부 패턴만 처리한다. 실제 사용 전 대상 프로젝트와 외부 AI 분석 범위를 확인한다. [과거 대화 가져오기 검토안](기존_대화_가져오기_검토안.md)은 제안이며 실행 가능한 기능이 아니다.

검증 범위와 Linux·Windows 검증 환경 선택지는 [호환성 검증 기록](호환성_검증.md)에 구분했다.
