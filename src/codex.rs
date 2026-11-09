//! Codex: threads listed in the newest `state_N.sqlite` index, each read on from its rollout log's cursor.
use crate::excerpt::ExcerptSplitter;
use crate::log_record::{read_complete_line, timestamp};
use crate::review_db::{self, Settings};
use crate::{Result, SQLITE_BUSY_TIMEOUT};
use rusqlite::{Connection, OpenFlags, params};
use serde_json::Value;
use std::fs::File;
use std::io::{BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// A row of the index's `threads` table.
struct Thread {
    id: String,
    rollout_path: String,
    created_ms: i64,
    source: String,
    cwd: String,
}

impl Thread {
    /// Whether the index lists this thread in the selected project as a main session, not a subagent.
    fn selected(&self, cfg: &Settings) -> bool {
        if !cfg.in_project(Some(&self.cwd)) {
            return false;
        }
        // The column holds a JSON value or a bare name such as cli.
        let source = serde_json::from_str(&self.source)
            .unwrap_or_else(|_| Value::from(self.source.as_str()));
        !is_subagent(&source)
    }
}

/// A turn being read. Its messages count as evidence once its context names the selected project.
struct Turn {
    id: String,
    started: f64,
    allowed: bool,
    evidence: Vec<Value>,
}

impl Turn {
    fn start(record: &Value) -> Result<Self> {
        Ok(Self {
            id: record["payload"]["turn_id"]
                .as_str()
                .ok_or("missing turn id")?
                .to_owned(),
            started: timestamp(record)?,
            allowed: false,
            evidence: Vec::new(),
        })
    }

    /// Whether `end` completes (not aborts) this turn, and the turn holds a prompt from the selected project.
    fn completed_by(&self, end: &Value) -> bool {
        self.allowed
            && end["type"] == "task_complete"
            && end["turn_id"] == self.id
            && self.evidence.iter().any(|e| e["role"] == "user")
    }
}

pub fn scan(db_path: &Path, codex_dir: &Path, index_dir: &Path) -> Result<()> {
    let mut db = review_db::open(db_path)?;
    let cfg = review_db::settings(&db)?;
    if !cfg.is_active() {
        return Ok(());
    }
    let Some(index) = newest_index(index_dir)? else {
        return Ok(());
    };
    let threads = threads_since(&index, cfg.start)?;
    let sessions = codex_dir.join("sessions").canonicalize()?;
    let excerpts = ExcerptSplitter::new()?;
    let mut failed = false;
    for thread in threads {
        if !review_db::active(&db)? {
            break;
        }
        if !thread.selected(&cfg) {
            continue;
        }
        if scan_thread(&mut db, &thread, &sessions, &cfg, &excerpts).is_err() {
            failed = true;
        }
    }
    if failed {
        Err("Codex log failed validation".into())
    } else {
        Ok(())
    }
}

fn newest_index(root: &Path) -> Result<Option<PathBuf>> {
    if !root.try_exists()? {
        return Ok(None);
    }
    let mut newest: Option<(u64, PathBuf)> = None;
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let version = entry
            .file_name()
            .to_string_lossy()
            .strip_prefix("state_")
            .and_then(|s| s.strip_suffix(".sqlite"))
            .and_then(|s| s.parse::<u64>().ok());
        if let Some(version) = version
            && newest.as_ref().is_none_or(|(v, _)| version > *v)
        {
            newest = Some((version, entry.path()));
        }
    }
    Ok(newest.map(|(_, path)| path))
}

/// Unarchived threads created since `start`.
fn threads_since(index: &Path, start: f64) -> Result<Vec<Thread>> {
    // shortcut: newest index must expose these columns; fail rather than read a stale older DB.
    let index_db = Connection::open_with_flags(index, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    index_db.busy_timeout(SQLITE_BUSY_TIMEOUT)?;
    let mut query = index_db.prepare(
        "SELECT id,rollout_path,created_at_ms,source,cwd FROM threads \
         WHERE created_at_ms>=?1 AND archived=0",
    )?;
    let threads = query
        .query_map(params![(start * 1000.0) as i64], |r| {
            Ok(Thread {
                id: r.get(0)?,
                rollout_path: r.get(1)?,
                created_ms: r.get(2)?,
                source: r.get(3)?,
                cwd: r.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(threads)
}

fn is_subagent(source: &Value) -> bool {
    source.get("subagent").is_some()
        || source
            .as_str()
            .is_some_and(|s| s == "subagent" || s.starts_with("subagent_"))
}

/// Reads one thread's log on from its cursor. An error fails this thread only; the scan goes on and reports it.
fn scan_thread(
    db: &mut Connection,
    thread: &Thread,
    sessions: &Path,
    cfg: &Settings,
    excerpts: &ExcerptSplitter,
) -> Result<()> {
    let born = thread.created_ms as f64 / 1000.0;
    if review_db::overlaps_pause(db, born, born)? {
        return Ok(());
    }
    let Some(path) = rollout_log(&thread.rollout_path, sessions)? else {
        return Ok(());
    };
    let cursor = review_db::cursor(db, &thread.id)?;
    let size = path.metadata()?.len();
    if cursor.is_some_and(|pos| size < pos) {
        return Err("Codex log shrank; checkpoint requires review".into());
    }
    if cursor == Some(size) {
        return Ok(());
    }
    let mut reader = BufReader::new(File::open(path)?);
    if !session_matches(&mut reader, &thread.id, cfg)? {
        return Ok(());
    }
    if let Some(pos) = cursor {
        reader.seek(SeekFrom::Start(pos))?;
    }
    read_turns(db, &mut reader, &thread.id, cfg, excerpts)
}

/// The log's canonical path if it is a file inside the Codex sessions folder; None if it is gone or elsewhere.
fn rollout_log(path: &str, sessions: &Path) -> Result<Option<PathBuf>> {
    let path = match Path::new(path).canonicalize() {
        Ok(path) => path,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    Ok((path.starts_with(sessions) && path.is_file()).then_some(path))
}

/// Whether the log's first line, its session metadata, matches the indexed main-session thread in the project.
/// A first line that is still being written does not match yet.
fn session_matches(reader: &mut BufReader<File>, id: &str, cfg: &Settings) -> Result<bool> {
    let mut first = String::new();
    if !read_complete_line(reader, &mut first)? {
        return Ok(false);
    }
    let meta: Value = serde_json::from_str(&first)?;
    let session = &meta["payload"];
    Ok(cfg.in_project(session["cwd"].as_str())
        && session["id"] == id
        && !is_subagent(&session["source"]))
}

/// Reads complete lines; each turn that ends is stored as it ends, with the cursor moved past it.
fn read_turns(
    db: &mut Connection,
    reader: &mut BufReader<File>,
    chat: &str,
    cfg: &Settings,
    excerpts: &ExcerptSplitter,
) -> Result<()> {
    let mut turn: Option<Turn> = None;
    let mut line = String::new();
    while review_db::active(db)? {
        if !read_complete_line(reader, &mut line)? {
            break;
        }
        let record: Value = serde_json::from_str(&line)?;
        let payload = &record["payload"];
        match (record["type"].as_str(), payload["type"].as_str()) {
            (Some("event_msg"), Some("task_started")) => turn = Some(Turn::start(&record)?),
            (Some("turn_context"), _) => {
                if let Some(t) = turn.as_mut() {
                    t.allowed = cfg.in_project(payload["cwd"].as_str());
                }
            }
            (Some("response_item"), Some("message")) => {
                if let Some(t) = turn.as_mut().filter(|t| t.allowed) {
                    append_message(excerpts, &mut t.evidence, payload);
                }
            }
            (Some("event_msg"), Some("task_complete" | "turn_aborted")) => {
                let position = reader.stream_position()?;
                if !finish_turn(db, turn.take(), &record, chat, position, cfg)? {
                    return Ok(());
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Adds a user message, or the assistant's final answer, to the turn's evidence.
fn append_message(excerpts: &ExcerptSplitter, evidence: &mut Vec<Value>, message: &Value) {
    let role = message["role"].as_str().unwrap_or("");
    if role != "user" && !(role == "assistant" && message["phase"] == "final_answer") {
        return;
    }
    let Some(parts) = message["content"].as_array() else {
        return;
    };
    for part in parts {
        if part["type"] == "input_text" || part["type"] == "output_text" {
            excerpts.append(evidence, role, part["text"].as_str().unwrap_or(""));
        }
    }
}

/// Stores `turn` as a job if `end` completes it inside the collection window, then moves the cursor to
/// `position`. Returns false, writing nothing, once collection has stopped.
fn finish_turn(
    db: &mut Connection,
    turn: Option<Turn>,
    end: &Value,
    chat: &str,
    position: u64,
    cfg: &Settings,
) -> Result<bool> {
    let ended = timestamp(end)?;
    let completed = turn.filter(|t| t.completed_by(&end["payload"]));
    review_db::advance(db, chat, position, |tx| {
        if let Some(turn) = completed
            && review_db::within_window(tx, cfg, turn.started, ended)?
        {
            let id = review_db::job_id(&format!("{chat}/{}", turn.id));
            review_db::insert_job(tx, &id, chat, ended, turn.evidence)?;
        }
        Ok(())
    })
}
