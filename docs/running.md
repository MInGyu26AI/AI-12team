# 실행 방법

Mac 로컬 수집기를 띄우고 웹이나 Chrome 확장을 연결하는 순서다. 명령은 모두 저장소 루트에서 실행한다.
구조는 [architecture.md](architecture.md), 팀 서버는 [team-server.md](team-server.md), 개인정보 처리는 [privacy.md](privacy.md)에 있다.

## 준비물

- macOS ([지원 OS](#지원-os)), Python 3.11 이상, Rust 2024 edition을 빌드할 수 있는 `cargo`, Node.js와 npm
- Ollama와 기본 개인정보 모델 ([개인정보 모델 준비](#개인정보-모델-준비))
- `OPENAI_API_KEY`. 키와 다른 공급자 설정은 [ai/README.md 설정](../ai/README.md#설정)
- 팀 서버 주소와 관리자가 발급한 개인 연결 키 파일 ([team-server.md](team-server.md)). 이 Mac에서 직접 띄우려면 [한 기기에서 써 보기](team-server.md#한-기기에서-써-보기)
- Chrome (확장을 쓸 때)

## 스캐너 빌드

Codex·Claude Code 기록은 Rust 스캐너가 읽는다. 실행 파일은 Git에 없으니 직접 빌드한다.

```sh
cargo build --release --locked --manifest-path scanner/Cargo.toml
mkdir -p bin
cp scanner/target/release/syncup-collector bin/
```

수집기는 스캐너 실행 파일 `bin/syncup-collector`를 실행한다. 스캐너 코드가 바뀌면 다시 빌드해서 복사한다.

## 개인정보 모델 준비

외부 AI로 보내기 전에 이 Mac의 Ollama 모델이 발췌를 먼저 검사한다. Ollama를 켜 두고 기본 모델을 받는다.

```sh
ollama pull gemma4:e4b-it-qat
```

모델이 없어도 수집기는 돌지만, 외부 AI로는 아무것도 보내지 않고 보류한다. 모델 설정은 [privacy.md](privacy.md#7-로컬-모델-설정)에 있다.

## 수집기 실행

`--integrated`를 붙이면 통합 모드, 빼면 팀 연결 단독 모드다. 두 모드의 차이는 [architecture.md](architecture.md#2-실행-모드)에 있다.

### 통합 모드

확장·웹·`ai/`를 함께 쓰는 제품 흐름이다.

```sh
python3 collector/app.py run --integrated \
  --project /절대/경로/수집할-프로젝트 \
  --state /절대/경로/개인-상태 \
  --team-api https://팀서버주소 \
  --team-token-file /안전한/개인연결.key
```

팀·주제·묶음 크기·종료 시각 같은 수집 설정은 확장 팝업이나 웹 `/collect`에서 한다.

### 팀 연결 단독 모드

위 명령에서 `--integrated`를 뺀다. 확장·웹 없이 Python 검토함만 쓴다.

- `OPENAI_API_KEY`는 셸 환경 변수로만 읽는다. `ai/.env`와 다른 공급자 설정은 쓰지 않는다.
- 팀은 검토함이나 `--team-id`로 고른다. 수집 기간은 처음 켤 때 `--minutes`로 정하고, 검토함에서는 일시중지와 재개만 한다.

### 옵션

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `--project` · `--state` | 필수 | 수집할 프로젝트 · 개인 상태 폴더 (없으면 만든다) |
| `--team-api` · `--team-token-file` | 필수 | 팀 서버 주소(HTTPS, 이 Mac에서 띄운 서버만 `http://127.0.0.1:<포트>`) · 연결 키 파일. 키 값은 인수에 쓰지 않는다 |
| `--team-id` | 없음 | 처음 연결하거나 시작할 때 고를 팀 ID |
| `--minutes` | 120 | 새 상태 폴더의 수집 기간 (1~1440분). 쓰던 폴더는 저장된 종료 시각을 쓴다 |
| `--port` | 8876 | Python 검토함과 로컬 RPC 포트 |
| `--codex-dir` · `--codex-sqlite-dir` · `--claude-dir` · `--claude-project-name` | 도구 기본 위치 | 대화 기록 위치. 찾는 순서는 `collector/runtime.py` |

이 상태 폴더로 처음 켠 뒤 그 프로젝트에서 시작한 Codex·Claude Code 대화만 읽는다. 그 전 대화는 가져오지 않는다. 일시중지·종료 중에는 읽지 않는다.

## 웹 연결

통합 모드에서 확장 없이 웹을 붙인다. ChatGPT 자동 수집은 없다. 자동 수집은 [확장](#확장-연결)이 한다.

```sh
(cd web && npm ci)
SYNCUP_CONNECTION_FILE=/절대/경로/개인-상태/connection.json node collector/local_web.cjs
```

- 터미널에 나온 연결 링크를 5분 안에 연다. 한 번만 쓸 수 있고 `/review`로 넘어간다. 링크는 공유하지 않는다.
- 세션은 실행기를 켠 뒤 8시간 유효하다. 끝나면 실행기를 다시 켜고 새 링크를 연다.
- 웹 모드 변수는 실행기가 정한다 ([web/README.md](../web/README.md)). 원격 호스트나 공개 배포에는 쓰지 않는다.

## 확장 연결

1. 확장을 빌드해서 Chrome에 불러오고 확장 ID를 적어 둔다 ([extension/README.md](../extension/README.md)). 배포 웹 `/install`의 zip을 써도 된다.
2. 새 빈 폴더에 연결 파일을 만든다. `--connection`에는 상태 폴더의 `connection.json` 경로를 준다. 같은 이름의 파일이 있으면 덮어쓰지 않고 멈춘다.
   ```sh
   python3 collector/prepare_native.py --extension-id 32자리확장ID \
     --connection /절대/경로/개인-상태/connection.json \
     --output /절대/경로/새-native-폴더
   ```
3. `com.syncup.collector.json`을 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`에 복사한다. `syncup-native`는 출력 폴더에 그대로 둔다. 매니페스트의 `path`가 이 파일을 가리킨다.
4. 확장 팝업에서 프로젝트 주제와 개인 검토함 주소를 저장한다. 이 주소는 승인함 웹의 주소(배포 주소나 `npm run dev`의 `http://localhost:3000`)이고, 수집기가 출력하는 8876 주소가 아니다. 그 주소의 페이지는 개인 후보를 읽고 승인을 보낼 수 있으니 믿는 주소만 넣는다.

`syncup-native`에는 Python 실행 파일, `collector/native_host.py`, `connection.json`의 절대 경로가 들어 있다. 이 가운데 하나나 확장 ID가 바뀌면 새 빈 폴더로 2~3단계를 다시 하고 `chrome://extensions`에서 확장을 새로고침한다. 수집기 파일이 `collector/`로 옮겨지기 전에 등록했다면 이 경우다(예전 실행기는 저장소 루트의 `native_host.py`를 찾는다).

## 상태 폴더와 포트

| 파일 | 내용 |
|---|---|
| `private.sqlite` | 발화, 후보, 승인 대기열, 수집 설정, 팀 연결 정보 |
| `private.sqlite.*.bak.sqlite` | [업그레이드](#업그레이드와-백업) 전 사본 |
| `run.lock` | 중복 실행 막기. 두 번 켜면 `같은 상태 폴더의 프로그램이 이미 실행 중입니다.`로 멈춘다 |
| `connection.json` | `--integrated`일 때만. 로컬 RPC 주소와 비밀값 |

- 대화 원문과 승인 내용이 들어 있으니 공유하지 않는다.
- 프로젝트마다 다른 폴더를 쓴다. 처음 팀 서버에 연결하면 서버 주소와 사용자가 폴더에 고정된다. 다른 사용자나 서버로 연결하려면 새 폴더를 쓴다.
- `connection.json`은 켤 때마다 새로 쓰지만, 확장과 로컬 웹은 다시 등록하지 않아도 된다.

| 주소 | 용도 | 바꾸는 법 |
|---|---|---|
| `http://127.0.0.1:8876/` | Python 검토함, `/team-board` 팀 보드, `/rpc` 로컬 RPC (통합 모드) | `--port` |
| `http://127.0.0.1:3000/` | 로컬 웹 실행기 | `PORT` |
| `http://127.0.0.1:8878/` | 한 기기에서 띄운 팀 서버 | [team-server.md](team-server.md#서버-실행) |

이 세 주소는 `127.0.0.1`에서만 열리고, `localhost`로 열면 거절한다. `npm run dev`(`http://localhost:3000`)는 로컬 웹 실행기와 다른 프로세스라 이 제한이 없다.

## 업그레이드와 백업

수집기를 끄고 같은 상태 폴더로 새 버전을 켠다. 기존 테이블을 바꿔야 하면 바꾸기 직전에 같은 폴더에 `private.sqlite.<태그>-*.bak.sqlite` 사본을 만든다. 새 테이블만 더하거나 옮길 데이터가 없으면 만들지 않는다.

- 기존 데이터가 새 제약조건에 맞지 않으면 변환 전체를 취소하고 멈춘다. 데이터를 버리거나 고치지 않는다.
- 보존 정리가 켜자마자 돌며 기간이 지난 백업을 지운다 ([privacy.md](privacy.md#6-보존-7일)). 복구에 쓸 백업은 다시 켜기 전에 상태 폴더 밖으로 옮긴다.
- 예전 로컬 시연 모드에서 팀 서버 없이 승인한 카드는 목적지가 없어 보내지 않고, 재시도도 되지 않는다. Python 검토함에 `이전 로컬 시연 승인`으로 나온다.
- 그 모드가 남긴 `board.sqlite`, `board.sqlite.*.bak.sqlite`, `board.lock`은 이제 아무것도 읽지 않는다. 승인한 문장이 들어 있고 자동으로 지우지 않으니, 필요 없으면 직접 지우거나 옮긴다.

## 실패와 중단

### 수집·분류

- 일시중지·종료는 새 기록 읽기와 새 외부 AI 요청을 막는다. 이미 보낸 요청은 취소하지 못한다.
- 스캐너가 실패하거나 스캐너 실행 파일 `bin/syncup-collector`가 없으면 검토함에 `대화 기록 확인 실패`가 보이고, 다음 확인 때 다시 시도한다.
- 통합 분류가 실패해도 발화는 로컬에 남는다. 수집 중일 때 웹의 **분류 재시도**나 Python 검토함의 **다시 시도**로 다시 보낸다.
- 보류된 발췌는 [privacy.md](privacy.md#3-사용자-제외와-보류)를 따른다.

### 승인 전송

- 승인은 로컬 대기열에 먼저 저장된다 (`승인 저장됨 · 전송 대기`). 대기열과 시도 횟수는 DB에 남아, 끄거나 강제로 끝낸 뒤 다시 켜도 이어서 보낸다. 일시중지·종료 뒤에도 보낸다.
- 통신 오류, 잘못된 응답, 일시적인 HTTP 오류는 몇 번 자동으로 다시 보낸다. 그래도 안 되거나 401·403 같은 오류면 `전송 확인 필요`로 멈춘다. 원인을 고치고 **승인한 내용 그대로 재시도**를 누른다. 승인 때와 같은 팀에 연결돼 있을 때만 된다.

### 팀 서버가 꺼졌을 때

- 통합 모드에서 이미 팀에 연결한 폴더는 팀 서버에 닿지 않거나 HTTP 오류(401·403 포함)를 받으면 `로컬 복구 모드`로 시작한다. 발화 접수, 후보 조회, 일시중지는 된다. 새 승인과 팀 변경은 서버 확인이 필요하다.
- 단독 모드, 처음 연결하는 폴더, 연결된 팀과 다른 `--team-id`를 준 경우는 시작하지 않는다.

## 지원 OS

로컬 수집기는 macOS에서만 돈다. `collector/runtime.py`의 `ENABLED_PLATFORMS`와 `scanner/src/main.rs`의 `ENABLED_OS`에서 Windows·Linux 줄은 주석이고, 옵션이나 환경 변수로 켜는 방법은 없다. 팀 서버에는 이 제한이 없지만, `rust`·`team` 검사는 수집기도 띄우므로 macOS에서 돌린다.
