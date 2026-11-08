"""Host connections and local storage configuration; no credentials leave Python."""
import os
from pathlib import Path
import re
import sys
import tomllib


# 검증 범위(2026-11-07): macOS ARM64·Linux ARM64 컨테이너에서 가상 대화로 실행 검사.
# 미검증: Windows 네이티브 빌드/실행/ACL, Linux x64·WSL·Intel Mac.
# 실제 계정의 새 대화→외부 AI→승인 전체 흐름, 설치 패키지·서명·공증은 미검증.
# 모든 제품 버전의 내부 로그 호환을 보장하지 않는다. 상세: 호환성_검증.md.
ENABLED_PLATFORMS = {
    "darwin",
    # User-requested rollout: keep these connections disabled after compatibility checks.
    # "win32",
    # "linux",
}


def require_platform():
    if sys.platform not in ENABLED_PLATFORMS:
        raise SystemExit("현재 SyncUp 연결은 macOS에서만 활성화되어 있습니다.")


def child_environment():
    # Windows needs its system directory; never pass the parent's API credentials.
    allowed = {"PATH", "LANG", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR"}
    return {**{k: v for k, v in os.environ.items() if k.upper() in allowed}, "PYTHONUTF8": "1"}


def collector_binary():
    return Path(__file__).resolve().parent / "bin" / ("syncup-collector.exe" if sys.platform == "win32" else "syncup-collector")


def storage_paths(args):
    # 미구현: Codex 프로젝트·관리자·프로필 설정 병합; 별도 위치는 --codex-sqlite-dir로 지정.
    codex = Path(args.codex_dir or os.environ.get("CODEX_HOME") or Path.home()/".codex").expanduser().resolve()
    sqlite = args.codex_sqlite_dir
    if sqlite is None:
        config_file = codex / "config.toml"
        config = tomllib.loads(config_file.read_text(encoding="utf-8")) if config_file.exists() else {}
        sqlite = config.get("sqlite_home")
        if sqlite is not None:
            if not isinstance(sqlite, str) or not sqlite.strip():
                raise ValueError("Codex sqlite_home 설정은 비어 있지 않은 경로여야 합니다.")
            sqlite = Path(sqlite).expanduser()
            if not sqlite.is_absolute():
                sqlite = codex / sqlite
        else:
            sqlite = os.environ.get("CODEX_SQLITE_HOME") or codex
    claude = Path(args.claude_dir or os.environ.get("CLAUDE_CONFIG_DIR") or Path.home()/".claude").expanduser().resolve()
    name = args.claude_project_name
    if name is None and (args.claude_dir or os.environ.get("CLAUDE_CONFIG_DIR")):
        name = os.environ.get("CLAUDE_CODE_PROJECT_DIR_NAME")
    if name is not None:
        reserved = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name) or name.lower() in reserved:
            raise ValueError("Claude 프로젝트 폴더명은 예약어가 아닌 영문·숫자·하이픈·밑줄 1~64자여야 합니다.")
    return codex, Path(sqlite).expanduser().resolve(), claude, name
