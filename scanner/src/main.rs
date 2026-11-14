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

/// Must match `ENABLED_PLATFORMS` in collector/runtime.py; docs/windows.md records what Windows was checked on.
const ENABLED_OS: &[&str] = &[
    "macos",
    "windows",
    // Linux stays off until it is checked on a real install.
    // "linux",
];

/// A failure's kind without its message, which may hold private paths or log text.
fn failure_kind(error: &(dyn Error + 'static)) -> String {
    if review_db::is_database_error(error) {
        "database".into()
    } else if let Some(io) = error.downcast_ref::<std::io::Error>() {
        format!("io {:?}", io.kind())
    } else {
        "log format".into()
    }
}

fn main() {
    if !ENABLED_OS.contains(&std::env::consts::OS) {
        eprintln!("SyncUp connections are currently enabled on macOS and Windows only.");
        std::process::exit(2);
    }
    let args: Vec<_> = std::env::args_os().collect();
    if !(3..=6).contains(&args.len()) {
        eprintln!(
            "Usage: syncup-scanner PRIVATE_DB CODEX_DIRECTORY [CLAUDE_DIRECTORY [CODEX_SQLITE_DIRECTORY [CLAUDE_PROJECT_NAME]]]"
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
    // Errors may contain private paths; only which part failed and the kind of failure is printed.
    let mut failed = false;
    if let Err(error) = codex::scan(&db, &codex, &index) {
        eprintln!("codex: {}", failure_kind(&*error));
        failed = true;
    }
    if let Some(root) = optional(3) {
        if let Err(error) = claude::scan(&db, &PathBuf::from(root), project_name.as_deref()) {
            eprintln!("claude: {}", failure_kind(&*error));
            failed = true;
        }
    }
    if failed {
        eprintln!(
            "Collector failed; check index schema, log format, permissions and database availability."
        );
        std::process::exit(1);
    }
}
