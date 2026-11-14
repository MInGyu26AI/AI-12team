"""Run the Rust scanner (scanner/, built into bin/) over Codex and Claude Code logs while collection is active."""
from pathlib import Path
import subprocess

from collection_session import active, config
from runtime import child_environment, scanner_binary, require_platform

# How much of the scanner's error output a failure keeps: its last lines name the failed part and the kind of
# failure (scanner/src/main.rs), never log text or paths.
DETAIL_CHARS = 200


class ScannerFailed(ValueError):
    """The scanner exited with an error. detail is the end of its error output, lines joined by ' | ';
    summary is its first line there, such as 'codex: io PermissionDenied'."""

    def __init__(self, detail):
        super().__init__("Rust 수집 실패 · 기록 형식과 DB 접근을 확인해 주세요.")
        self.detail = detail
        self.summary = detail.split(' | ')[0]


def scan(db, codex, claude=None, codex_sqlite=None, claude_project=None):
    require_platform()
    if not active(config(db)):
        return
    binary = scanner_binary()
    command = [str(binary), str(Path(db).resolve()), str(Path(codex).resolve())]
    command.extend([str(Path(claude).resolve()) if claude is not None else "",
                    str(Path(codex_sqlite or codex).resolve()), claude_project or ""])
    # The scanner has no API credential. Its standard output is not read; its error output is kept only on failure.
    result = subprocess.run(
        command,
        env=child_environment(),
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=30,
    )
    if result.returncode:
        lines = [line.strip() for line in result.stderr.decode("utf-8", "replace").splitlines() if line.strip()]
        raise ScannerFailed(" | ".join(lines)[-DETAIL_CHARS:] or f"exit {result.returncode}")
