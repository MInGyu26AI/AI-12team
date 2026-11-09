//! Reads new Codex and Claude Code turns into jobs in the review application's private SQLite database.
mod claude;
mod codex;
mod excerpt;
mod log_record;
mod review_db;

use std::error::Error;
use std::path::PathBuf;
use std::time::Duration;

type Result<T> = std::result::Result<T, Box<dyn Error>>;

/// How long a SQLite call waits for another process's lock before it fails.
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(10);

const ENABLED_OS: &[&str] = &[
    "macos",
    // Windows 네이티브·Linux x64·WSL·Intel Mac 미검증. Linux ARM64는 컨테이너 검사 통과.
    // 실제 계정/외부 AI 흐름·전체 로그 버전 호환은 미검증이다. 지원 범위는 docs/running.md에 적는다.
    // User-requested rollout: keep these connections disabled after compatibility checks.
    // "windows",
    // "linux",
];

fn main() {
    if !ENABLED_OS.contains(&std::env::consts::OS) {
        eprintln!("SyncUp connections are currently enabled on macOS only.");
        std::process::exit(2);
    }
    let args: Vec<_> = std::env::args_os().collect();
    if !(3..=6).contains(&args.len()) {
        eprintln!(
            "Usage: syncup-collector PRIVATE_DB CODEX_DIRECTORY [CLAUDE_DIRECTORY [CODEX_SQLITE_DIRECTORY [CLAUDE_PROJECT_NAME]]]"
        );
        std::process::exit(2);
    }
    // An empty argument stands for an optional one the caller left out.
    let optional = |i: usize| args.get(i).filter(|v| !v.is_empty());
    let db = PathBuf::from(&args[1]);
    let codex = PathBuf::from(&args[2]);
    let index = optional(4)
        .map(PathBuf::from)
        .unwrap_or_else(|| codex.clone());
    let project_name = optional(5).map(|v| v.to_string_lossy().into_owned());
    let codex_failed = codex::scan(&db, &codex, &index).is_err();
    let claude_failed = optional(3).is_some_and(|root| {
        claude::scan(&db, &PathBuf::from(root), project_name.as_deref()).is_err()
    });
    if codex_failed || claude_failed {
        // Errors may contain private paths; keep logs free of input data.
        eprintln!(
            "Collector failed; check index schema, log format, permissions and database availability."
        );
        std::process::exit(1);
    }
}
