//! The review application's private SQLite database as the scanners use it: they read the collection
//! window (settings and pauses) and write new jobs and a read cursor per log.
use crate::{Result, SQLITE_BUSY_TIMEOUT};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// The project to collect from and when collection runs (`settings`, row 1).
pub struct Settings {
    pub project: String,
    pub start: f64,
    pub end: f64,
    paused: bool,
}

impl Settings {
    pub fn is_active(&self) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        !self.paused && self.start <= now && now < self.end
    }

    /// Whether a log record's working directory is the selected project; canonical paths let aliases match.
    pub fn in_project(&self, cwd: Option<&str>) -> bool {
        let Some(cwd) = cwd else {
            return false;
        };
        if cwd == self.project {
            return true;
        }
        match (
            Path::new(cwd).canonicalize(),
            Path::new(&self.project).canonicalize(),
        ) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
    }
}

/// Opens the database the review application created; the scanners never create or migrate it.
pub fn open(path: &Path) -> Result<Connection> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    db.busy_timeout(SQLITE_BUSY_TIMEOUT)?;
    db.pragma_update(None, "foreign_keys", true)?;
    Ok(db)
}

pub fn settings(db: &Connection) -> Result<Settings> {
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

/// Whether collection runs now. The user can pause at any time, so this is checked again before each write.
pub fn active(db: &Connection) -> Result<bool> {
    Ok(settings(db)?.is_active())
}

/// Whether a pause overlaps `start..=end`; a pause that has not ended yet reaches past `end`.
pub fn overlaps_pause(db: &Connection, start: f64, end: f64) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pauses WHERE start<=?1 AND coalesce(end,?1)>=?2)",
        params![end, start],
        |r| r.get(0),
    )?)
}

/// Whether a turn from `started` to `ended` lies inside the collection window and outside every pause.
pub fn within_window(db: &Connection, cfg: &Settings, started: f64, ended: f64) -> Result<bool> {
    Ok(started >= cfg.start && ended < cfg.end && !overlaps_pause(db, started, ended)?)
}

/// The byte offset where reading the log `chat` stopped last time.
pub fn cursor(db: &Connection, chat: &str) -> Result<Option<u64>> {
    Ok(db
        .query_row("SELECT pos FROM cursors WHERE chat=?1", [chat], |r| {
            r.get(0)
        })
        .optional()?)
}

/// Runs `store` and moves the cursor of `chat` to `pos` in one transaction, so a job is never stored
/// without its cursor or skipped by it. The transaction takes the write lock before checking that
/// collection still runs, so a pause cannot land between that check and the commit. Returns false,
/// writing nothing, once collection has stopped.
pub fn advance(
    db: &mut Connection,
    chat: &str,
    pos: u64,
    store: impl FnOnce(&Connection) -> Result<()>,
) -> Result<bool> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !active(&tx)? {
        return Ok(false);
    }
    store(&tx)?;
    tx.execute(
        "INSERT INTO cursors VALUES(?1,?2) ON CONFLICT(chat) DO UPDATE SET pos=excluded.pos",
        params![chat, pos],
    )?;
    tx.commit()?;
    Ok(true)
}

/// A job id: the SHA-256 hex digest of a key naming the log and the turn, so a rescan finds the same job.
pub fn job_id(key: &str) -> String {
    format!("{:x}", Sha256::digest(key.as_bytes()))
}

pub fn job_exists(db: &Connection, id: &str) -> Result<bool> {
    Ok(
        db.query_row("SELECT EXISTS(SELECT 1 FROM jobs WHERE id=?1)", [id], |r| {
            r.get(0)
        })?,
    )
}

/// Adds a new job unless one with this id exists. Each excerpt first gets the conversation, the job id and
/// the turn's end time, the fields the review application reads back.
pub fn insert_job(
    db: &Connection,
    id: &str,
    conversation: &str,
    ended: f64,
    mut evidence: Vec<Value>,
) -> Result<()> {
    for excerpt in &mut evidence {
        excerpt["conversationId"] = json!(conversation);
        excerpt["turnId"] = json!(id);
        excerpt["at"] = json!(ended);
    }
    db.execute(
        "INSERT INTO jobs VALUES(?1,?2,'new','') ON CONFLICT(id) DO NOTHING",
        params![id, serde_json::to_string(&evidence)?],
    )?;
    Ok(())
}
