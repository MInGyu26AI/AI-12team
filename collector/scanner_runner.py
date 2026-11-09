"""Run the Rust scanner (scanner/, built into bin/) over Codex and Claude Code logs while collection is active."""
from pathlib import Path
import subprocess

from collection_session import active, config
from runtime import child_environment, collector_binary, require_platform


def scan(db, codex, claude=None, codex_sqlite=None, claude_project=None):
    require_platform()
    if not active(config(db)):
        return
    binary = collector_binary()
    command = [str(binary), str(Path(db).resolve()), str(Path(codex).resolve())]
    command.extend([str(Path(claude).resolve()) if claude is not None else "",
                    str(Path(codex_sqlite or codex).resolve()), claude_project or ""])
    # The scanner has no API credential and only emits a generic error status, so its output is not read.
    result = subprocess.run(
        command,
        env=child_environment(),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
    )
    if result.returncode:
        raise ValueError("Rust 수집 실패 · 기록 형식과 DB 접근을 확인해 주세요.")
