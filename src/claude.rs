//! Claude Code: the selected project's new main-session transcripts, each read whole and stored from its
//! cursor. A turn counts as finished only by its `end_turn` record, never by the file's age.
mod transcript;
mod turns;

use crate::Result;
use crate::excerpt::ExcerptSplitter;
use crate::review_db::{self, Settings};
use regex::Regex;
use rusqlite::Connection;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Longest configured project folder name.
const MAX_FOLDER_NAME: usize = 64;
/// Claude Code cuts longer project slugs to this length and adds a `-suffix`.
const MAX_SLUG: usize = 200;

pub fn scan(db_path: &Path, claude_dir: &Path, project_name: Option<&str>) -> Result<()> {
    if project_name.is_some_and(|name| !valid_folder_name(name)) {
        return Err("Invalid Claude project directory name".into());
    }
    let mut db = review_db::open(db_path)?;
    let cfg = review_db::settings(&db)?;
    if !cfg.is_active() {
        return Ok(());
    }
    let projects = claude_dir.join("projects");
    if !projects.try_exists()? {
        return Ok(());
    }
    let projects = projects.canonicalize()?;
    let uuid = Regex::new(r"(?i)^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")?;
    let excerpts = ExcerptSplitter::new()?;
    let mut failed = false;
    for folder in project_folders(&projects, &cfg.project, project_name)? {
        let Some(folder) = folder_inside(&folder, &projects)? else {
            continue;
        };
        for entry in fs::read_dir(&folder)? {
            if !review_db::active(&db)? {
                return Ok(());
            }
            let path = entry?.path();
            let Some(session) = session_id(&path, &uuid) else {
                continue;
            };
            match scan_transcript(&mut db, &path, session, &cfg, &excerpts) {
                Ok(()) => {}
                Err(e) if review_db::is_database_error(&*e) => return Err(e),
                Err(_) => failed = true,
            }
        }
    }
    if failed {
        Err("Claude transcript failed validation".into())
    } else {
        Ok(())
    }
}

/// A configured folder name stays one plain path segment inside the projects folder.
fn valid_folder_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_FOLDER_NAME
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// The configured folder, or the folders Claude Code names after the project path.
// shortcut: default slug naming; recheck after Claude updates.
fn project_folders(projects: &Path, project: &str, name: Option<&str>) -> Result<Vec<PathBuf>> {
    if let Some(name) = name {
        return Ok(vec![projects.join(name)]);
    }
    let slug: String = project
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    if slug.len() <= MAX_SLUG {
        return Ok(vec![projects.join(slug)]);
    }
    let prefix = format!("{}-", &slug[..MAX_SLUG]);
    Ok(fs::read_dir(projects)?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .map(|entry| entry.path())
        .collect())
}

/// The folder's canonical path if it is a directory inside the projects folder.
fn folder_inside(folder: &Path, projects: &Path) -> Result<Option<PathBuf>> {
    if !folder.try_exists()? {
        return Ok(None);
    }
    let folder = folder.canonicalize()?;
    Ok((folder.starts_with(projects) && folder.is_dir()).then_some(folder))
}

/// The session id of a main-session transcript: a regular `<uuid>.jsonl` file, not a link.
fn session_id<'a>(path: &'a Path, uuid: &Regex) -> Option<&'a str> {
    if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
        return None;
    }
    let session = path.file_stem()?.to_str()?;
    (uuid.is_match(session) && !path.is_symlink() && path.is_file()).then_some(session)
}

/// Codex chat ids and Claude session ids can be equal, so Claude cursors and job ids use their own prefix.
fn chat_key(session: &str) -> String {
    format!("claude-code/{session}")
}

/// Reads one transcript and stores its new turns. A log error fails this transcript only; the scan goes on
/// and reports it.
fn scan_transcript(
    db: &mut Connection,
    path: &Path,
    session: &str,
    cfg: &Settings,
    excerpts: &ExcerptSplitter,
) -> Result<()> {
    let cursor = review_db::cursor(db, &chat_key(session))?.unwrap_or(0);
    let metadata = path.metadata()?;
    if metadata.len() < cursor {
        return Err("Claude transcript shrank; checkpoint requires review".into());
    }
    // Birth time plus the first message timestamp exclude old sessions, including resumed files.
    if metadata.len() == cursor || born_before(&metadata, cfg.start) {
        return Ok(());
    }
    match transcript::read(db, path, session, cursor, cfg)? {
        Some(transcript) => turns::store(db, &transcript, cfg, excerpts),
        None => Ok(()),
    }
}

/// A file system without birth times counts every file as new; the first record's time still applies.
fn born_before(metadata: &fs::Metadata, start: f64) -> bool {
    metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .is_some_and(|t| t.as_secs_f64() < start)
}
