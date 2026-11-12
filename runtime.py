"""Host connections and local storage configuration; no credentials leave Python."""
import os
from pathlib import Path
import re
import sys
import tomllib


# 검증 범위: 호환성_검증.md
ENABLED_PLATFORMS = {
    "darwin",
    "win32",
    # Linux stays off until it is checked on a real install.
    # "linux",
}


def require_platform():
    if sys.platform not in ENABLED_PLATFORMS:
        raise SystemExit("현재 SyncUp 연결은 macOS와 Windows에서만 활성화되어 있습니다.")


def child_environment():
    # Windows needs its system directory; never pass the parent's API credentials.
    allowed = {"PATH", "LANG", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR"}
    return {**{k: v for k, v in os.environ.items() if k.upper() in allowed}, "PYTHONUTF8": "1"}


def collector_binary():
    # In the packaged Windows app this folder is the bundle's, where windows_bundle.py puts bin/.
    return Path(__file__).resolve().parent / "bin" / ("syncup-collector.exe" if sys.platform == "win32" else "syncup-collector")


# The packaged Windows app (syncup_entry.py) runs each script as a subcommand of one executable; app.py's own
# modes, run and board, are already its first argument.
BUNDLED_SUBCOMMANDS = {"app.py": [], "native_host.py": ["native-host"], "prepare_native.py": ["native-setup"]}


def script_command(script, *args):
    """The command that runs one of this folder's scripts with args, from source or in the packaged app."""
    if getattr(sys, "frozen", False):
        return [sys.executable, *BUNDLED_SUBCOMMANDS[script], *args]
    return [sys.executable, str(Path(__file__).resolve().with_name(script)), *args]


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
