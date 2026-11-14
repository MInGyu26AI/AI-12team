# 싱크업 (SyncUp)

팀원들이 각자 AI와 나눈 대화(ChatGPT 웹, Codex, Claude Code)에서 결정·조사·할 일을 골라, 본인이 승인한 것만 팀 결정 기록에 모으고 결정끼리 어긋나면 알려 주는 서비스. 2026 인공지능학과 대학 연합 해커톤 출품작.

- 웹: https://syncup-live-murex.vercel.app
- 확장 내려받기: https://syncup-live-murex.vercel.app/install

## 구성

| 폴더 | 내용 | 담당 |
|---|---|---|
| `extension/` | ChatGPT 대화를 로컬 수집기로 보내는 Chrome 확장 (WXT) | 김단비 |
| `web/` | 대화 수집·승인함·팀 결정 기록 화면 (Next.js) | 김단비 |
| `shared/` | 웹·확장 공용 타입·표시 규칙·목업 데이터 | 김단비 |
| `ai/` | 분류·충돌 판정 (Python) | 김하은 |
| `collector/` | 로컬 수집기(macOS·Windows): 대화 접수·개인정보 필터·후보 검토·승인 전송, 확장과 잇는 Native Messaging 호스트 (Python), 확장 없이 웹을 잇는 실행기 `local_web.cjs` (Node), Windows용 `syncup.exe` 묶음 | 김동균 |
| `scanner/` | Codex·Claude Code 대화 기록을 읽는 스캐너 (Rust) | 김동균 |
| `server/` | 팀 서버 API·관리 도구·DB 스키마 (PostgreSQL). 클라우드 이미지는 루트의 `Dockerfile.cloud` | 김동균 |
| `contract/` | 수집기와 팀 서버가 함께 쓰는 승인 카드 검증·진단 기록·HTTP 기반 | 김동균 |
| `checks/` | 검사 (`run_checks.py`, `check_*.py`·`check_*.cjs`, 공용 도우미 `repo_paths.py`·`local_fixtures.py`) | 김동균 |
| `docs/` | 분류 기준표, 구조·실행·팀 서버·개인정보 문서 | 김민규·김단비 (분류 기준표), 김동균 |

## 흐름

<img width="1200" height="607" alt="Tracer_20261110_092843" src="https://github.com/user-attachments/assets/3229b464-e537-4390-9798-f830be799451" />

1. 확장이 ChatGPT 대화를, 스캐너가 지정한 프로젝트의 Codex·Claude Code 대화를 읽어 내 컴퓨터의 로컬 수집기에 모음
2. 기기 안에서 민감정보를 가리고 개인 내용을 거른 뒤, 남은 발췌만 외부 AI로 분류
3. 승인함(웹 `/review`, 본인만 봄)에서 후보를 확인·수정·승인
4. 승인한 카드와 근거 발췌만 팀 서버로 → 팀 서버가 기존 결정과 충돌 검사
5. 팀 결정 기록(`/board`)에서 충돌 경고 확인·처리

## 빠른 시작

### 웹만 (예시 데이터)

```sh
cd web
npm ci
NEXT_PUBLIC_USE_MOCK=true npm run dev   # http://localhost:3000
```

수집기 없이 예시 데이터로 화면만 본다 (모드 설명은 [web/README.md](web/README.md)).

### 전체 (macOS)

준비물과 명령은 [docs/running.md](docs/running.md#준비물)에 있다. 순서는 이렇다.

1. [스캐너 빌드](docs/running.md#스캐너-빌드)
2. [개인정보 모델 받기](docs/running.md#개인정보-모델-준비) (`ollama pull`)
3. 팀 서버 주소와 개인 연결 키 받기. 이 Mac에서 직접 띄우려면 [한 기기에서 써 보기](docs/team-server.md#한-기기에서-써-보기)
4. [수집기 실행](docs/running.md#통합-모드) (`--integrated`)
5. [확장 연결](docs/running.md#확장-연결). 확장 없이 [웹만 연결](docs/running.md#웹-연결)해도 된다

Windows는 [docs/windows.md](docs/windows.md)를 따른다. Python 없이 쓰는 `syncup.exe` 묶음, 파일 권한, 레지스트리 등록이 다르다.

## 검사

저장소 루트에서 실행한다. 고른 묶음의 검사는 하나가 실패해도 끝까지 돌고, 하나라도 실패하면 종료 코드가 0이 아니다.

```sh
python3 checks/run_checks.py            # local (기본값)
python3 checks/run_checks.py rust team  # 묶음 여러 개
python3 checks/run_checks.py all        # local + rust + team
python3 checks/run_checks.py --list     # 검사마다 다루는 범위만 출력
```

| 묶음 | 필요 환경 |
|---|---|
| `local` | macOS, Python 3.11 이상, Node, `web/`·`extension/`에서 각각 `npm ci` |
| `rust` | macOS, 빌드한 스캐너 실행 파일 `bin/syncup-scanner` |
| `team` | macOS (수집기와 확장 연결도 함께 띄움), Docker, `python3 -m pip install -r server/requirements.txt` |
| `model` | Ollama와 기본 개인정보 모델 (`gemma4:e4b-it-qat`). 실제 모델 측정이라 느리고 `all`에 들어가지 않음 |

`model`을 뺀 검사는 임시 데이터와 가짜 AI 응답만 쓴다. `team`은 검사용 PostgreSQL 컨테이너를 따로 띄웠다가 지운다.

## 문서

- [docs/architecture.md](docs/architecture.md): 구조와 데이터 흐름, 로컬 RPC 목록
- [docs/running.md](docs/running.md): 수집기 실행, 웹·확장 연결
- [docs/windows.md](docs/windows.md): Windows 설치·검사·실제 PC 검증 목록과 기록, 팀원용 안내는 [docs/windows-teammate-prompt.md](docs/windows-teammate-prompt.md)
- [docs/team-server.md](docs/team-server.md): 팀 서버 설치·운영·백업
- [docs/privacy.md](docs/privacy.md): 외부로 보내기 전 개인정보 처리, 보존 기간
- [docs/classification.md](docs/classification.md): 분류 기준표
- [web/README.md](web/README.md) · [extension/README.md](extension/README.md) · [ai/README.md](ai/README.md): 영역별 안내
- [CLAUDE.md](CLAUDE.md): 서비스 기획 요약과 화면 규칙
- 검증 기록·진행 현황: 팀 노션

## 알아둘 것

- 로컬 수집기는 macOS와 Windows에서 돈다. Linux 코드는 남아 있지만 꺼 두었다 ([docs/running.md](docs/running.md#지원-os)). `run_checks.py` 묶음은 macOS용이고, Windows 검사는 `.github/workflows/windows.yml`이 돌린다 ([docs/windows.md](docs/windows.md#3-자동-검사-github-actions-windows-collector)).
- Codex·Claude Code 기록은 각 도구의 내부 파일 형식을 그대로 읽는다. 도구 버전이 바뀌면 수집이 빠질 수 있다.
- 공개 레포다. API 키, `.env`, 연결 키 파일, `connection.json`, 대화 기록(`*.jsonl`), 상태 DB(`*.sqlite`)는 커밋하지 않는다. `.gitignore`가 막아 두었지만 새 파일을 올릴 때 한 번 더 확인한다.
