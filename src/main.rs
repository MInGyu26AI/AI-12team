//! Codex and Claude Code input for the existing review application's jobs/cursors.
mod claude;
use chrono::DateTime;
use regex::Regex;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::error::Error;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

const ENABLED_OS: &[&str] = &[
    "macos",
    // Windows 네이티브·Linux x64·WSL·Intel Mac 미검증. Linux ARM64는 컨테이너 검사 통과.
    // 실제 계정/외부 AI 흐름·전체 로그 버전 호환은 미검증이며 호환성_검증.md에 범위를 기록한다.
    // User-requested rollout: keep these connections disabled after compatibility checks.
    // "windows",
    // "linux",
];

fn same_project(value: &Value, project: &str) -> bool {
    let Some(path) = value.as_str() else {
        return false;
    };
    if path == project {
        return true;
    }
    match (
        Path::new(path).canonicalize(),
        Path::new(project).canonicalize(),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn state_index(root: &Path) -> Result<Option<PathBuf>> {
    if !root.try_exists()? {
        return Ok(None);
    }
    let mut newest = None;
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let version = name
            .strip_prefix("state_")
            .and_then(|s| s.strip_suffix(".sqlite"))
            .and_then(|s| s.parse::<u64>().ok());
        if let Some(version) = version {
            if newest.as_ref().is_none_or(|(v, _)| version > *v) {
                newest = Some((version, entry.path()));
            }
        }
    }
    Ok(newest.map(|(_, path)| path))
}

struct Settings {
    project: String,
    start: f64,
    end: f64,
    paused: bool,
}

fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

fn settings(db: &Connection) -> Result<Settings> {
    Ok(db.query_row(
        "SELECT project,start,end,paused FROM settings WHERE id=1",
        [],
        |r| {
            Ok(Settings {
                project: r.get(0)?,
                start: r.get(1)?,
                end: r.get(2)?,
                paused: r.get(3)?,
            })
        },
    )?)
}

fn active(db: &Connection) -> Result<bool> {
    let s = settings(db)?;
    Ok(!s.paused && s.start <= now() && now() < s.end)
}

fn overlaps_pause(db: &Connection, start: f64, end: f64) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pauses WHERE start<=?1 AND coalesce(end,?1)>=?2)",
        params![end, start],
        |r| r.get(0),
    )?)
}

fn timestamp(item: &Value) -> Result<f64> {
    let raw = item["timestamp"].as_str().ok_or("missing timestamp")?;
    Ok(DateTime::parse_from_rfc3339(raw)?.timestamp_millis() as f64 / 1000.0)
}

struct Turn {
    id: String,
    started: f64,
    allowed: bool,
    evidence: Vec<Value>,
}

struct Sanitizer {
    secrets: Regex,
    lines: Regex,
}

impl Sanitizer {
    fn new() -> Result<Self> {
        Ok(Self {
            secrets: Regex::new(
                r"(?i)sk-[\w-]{12,}|gh[pousr]_[\w]{16,}|AKIA[A-Z0-9]{16}|Bearer\s+[\w./+=-]+|(?:api[_ -]?key|password|secret|token)\s*[:=]\s*[^\s,;]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}",
            )?,
            lines: Regex::new(r"\n+")?,
        })
    }

    fn append(&self, turn: &mut Turn, payload: &Value) {
        let role = payload["role"].as_str().unwrap_or("");
        if role != "user" && !(role == "assistant" && payload["phase"] == "final_answer") {
            return;
        }
        let Some(parts) = payload["content"].as_array() else {
            return;
        };
        for part in parts {
            if part["type"] != "input_text" && part["type"] != "output_text" {
                continue;
            }
            let text = part["text"].as_str().unwrap_or("").trim();
            self.append_text(turn, role, text);
        }
    }

    fn append_text(&self, turn: &mut Turn, role: &str, text: &str) {
        let text = text.trim();
        let metadata = [
            "<environment_context",
            "# AGENTS.md instructions",
            "<external_",
            "<send_user_",
            "<system",
            "<permissions",
            "An MCP app initiated",
            "## Referenced chats",
        ];
        if text.is_empty() || metadata.iter().any(|p| text.starts_with(p)) {
            return;
        }
        let masked = self.secrets.replace_all(text, "[가림]");
        for line in self.lines.split(&masked) {
            // Keep the original punctuation while splitting after sentence-ending whitespace.
            let mut start = 0;
            let mut previous = ' ';
            for (offset, ch) in line.char_indices() {
                if ch.is_whitespace() && matches!(previous, '.' | '!' | '?' | '。') {
                    Self::push(turn, role, &line[start..offset]);
                    start = offset;
                }
                previous = ch;
            }
            Self::push(turn, role, &line[start..]);
        }
    }

    fn push(turn: &mut Turn, role: &str, text: &str) {
        // shortcut: 24 excerpts of 600 characters per turn, add chunking before long-chat support.
        let text = text.trim();
        if !text.is_empty() && turn.evidence.len() < 24 {
            turn.evidence.push(json!({"n": turn.evidence.len()+1, "role": role, "text": text.chars().take(600).collect::<String>()}));
        }
    }
}

fn extract(
    db: &mut Connection,
    reader: &mut BufReader<File>,
    chat: &str,
    cfg: &Settings,
    sanitizer: &Sanitizer,
) -> Result<()> {
    let mut turn: Option<Turn> = None;
    let mut line = String::new();
    while active(db)? {
        line.clear();
        reader.read_line(&mut line)?;
        if !line.ends_with('\n') {
            break;
        }
        let item: Value = serde_json::from_str(&line)?;
        let payload = &item["payload"];
        match (item["type"].as_str(), payload["type"].as_str()) {
            (Some("event_msg"), Some("task_started")) => {
                turn = Some(Turn {
                    id: payload["turn_id"]
                        .as_str()
                        .ok_or("missing turn id")?
                        .to_owned(),
                    started: timestamp(&item)?,
                    allowed: false,
                    evidence: Vec::new(),
                });
            }
            (Some("turn_context"), _) => {
                if let Some(t) = turn.as_mut() {
                    t.allowed = same_project(&payload["cwd"], &cfg.project);
                }
            }
            (Some("response_item"), Some("message")) => {
                if let Some(t) = turn.as_mut().filter(|t| t.allowed) {
                    sanitizer.append(t, payload);
                }
            }
            (Some("event_msg"), Some("task_complete" | "turn_aborted")) => {
                let ended = timestamp(&item)?;
                let position = reader.stream_position()?;
                let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                if !active(&tx)? {
                    return Ok(());
                }
                if let Some(mut t) = turn.take() {
                    let eligible = t.allowed
                        && t.started >= cfg.start
                        && ended < cfg.end
                        && !overlaps_pause(&tx, t.started, ended)?
                        && payload["type"] == "task_complete"
                        && payload["turn_id"] == t.id
                        && t.evidence.iter().any(|e| e["role"] == "user");
                    if eligible {
                        let id = format!(
                            "{:x}",
                            Sha256::digest(format!("{chat}/{}", t.id).as_bytes())
                        );
                        for excerpt in &mut t.evidence {
                            excerpt["conversationId"] = json!(chat);
                            excerpt["turnId"] = json!(id);
                            excerpt["at"] = json!(ended);
                        }
                        tx.execute(
                            "INSERT INTO jobs VALUES(?1,?2,'new','') ON CONFLICT(id) DO NOTHING",
                            params![id, serde_json::to_string(&t.evidence)?],
                        )?;
                    }
                }
                tx.execute(
                    "INSERT OR REPLACE INTO cursors VALUES(?1,?2)",
                    params![chat, position],
                )?;
                tx.commit()?;
            }
            _ => {}
        }
    }
    Ok(())
}

fn is_subagent(source: &Value) -> bool {
    source.get("subagent").is_some()
        || source
            .as_str()
            .is_some_and(|s| s == "subagent" || s.starts_with("subagent_"))
}

fn scan(db_path: &Path, codex: &Path, sqlite_root: &Path) -> Result<()> {
    let mut db = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    db.busy_timeout(Duration::from_secs(10))?;
    db.pragma_update(None, "foreign_keys", true)?;
    if !active(&db)? {
        return Ok(());
    }
    let cfg = settings(&db)?;
    let Some(index_path) = state_index(sqlite_root)? else {
        return Ok(());
    };
    // shortcut: newest index must expose these columns; fail rather than read a stale older DB.
    let index = Connection::open_with_flags(index_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    index.busy_timeout(Duration::from_secs(10))?;
    let mut stmt = index.prepare("SELECT id,rollout_path,created_at_ms,source,cwd FROM threads WHERE created_at_ms>=?1 AND archived=0")?;
    let chats = stmt
        .query_map(params![(cfg.start * 1000.0) as i64], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let sessions = codex.join("sessions").canonicalize()?;
    let sanitizer = Sanitizer::new()?;
    for (chat, filename, created, source, cwd) in chats {
        if !active(&db)? {
            break;
        }
        if !same_project(&Value::String(cwd), &cfg.project) {
            continue;
        }
        if is_subagent(&serde_json::from_str(&source).unwrap_or(Value::String(source))) {
            continue;
        }
        let born = created as f64 / 1000.0;
        if overlaps_pause(&db, born, born)? {
            continue;
        }
        let path = match Path::new(&filename).canonicalize() {
            Ok(p) => p,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        if !path.starts_with(&sessions) || !path.is_file() {
            continue;
        }
        let pos: Option<u64> = db
            .query_row("SELECT pos FROM cursors WHERE chat=?1", [&chat], |r| {
                r.get(0)
            })
            .optional()?;
        let size = path.metadata()?.len();
        if pos.is_some_and(|p| size < p) {
            return Err("Codex log shrank; checkpoint requires review".into());
        }
        if pos == Some(size) {
            continue;
        }
        let mut reader = BufReader::new(File::open(path)?);
        let mut first = String::new();
        reader.read_line(&mut first)?;
        if !first.ends_with('\n') {
            continue;
        }
        let meta: Value = serde_json::from_str(&first)?;
        if !same_project(&meta["payload"]["cwd"], &cfg.project)
            || meta["payload"]["id"] != chat
            || is_subagent(&meta["payload"]["source"])
        {
            continue;
        }
        if let Some(pos) = pos {
            reader.seek(SeekFrom::Start(pos))?;
        }
        extract(&mut db, &mut reader, &chat, &cfg, &sanitizer)?;
    }
    Ok(())
}

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
    let db = PathBuf::from(&args[1]);
    let codex = PathBuf::from(&args[2]);
    let sqlite = args
        .get(4)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| codex.clone());
    let project_name = args
        .get(5)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string_lossy().into_owned());
    let codex_failed = scan(&db, &codex, &sqlite).is_err();
    let claude_failed = args
        .get(3)
        .filter(|root| !root.is_empty())
        .is_some_and(|root| {
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
