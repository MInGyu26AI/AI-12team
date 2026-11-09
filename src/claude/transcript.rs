//! Reading a Claude Code transcript into the records of its parent chain.
use crate::Result;
use crate::log_record::{read_complete_line, timestamp};
use crate::review_db::{self, Settings};
use rusqlite::Connection;
use serde_json::Value;
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Seek};
use std::path::Path;

/// Record types that link into the parent chain.
const CHAIN_TYPES: &[&str] = &["user", "assistant", "system", "progress", "attachment"];

/// Text Claude Code itself sends as a user message: command output, reminders, hooks and notices.
const INTERNAL_PREFIXES: &[&str] = &[
    "<local-command-",
    "<command-name>",
    "<system-reminder>",
    "<session-start-hook>",
    "[Request interrupted by user",
    "<ide_",
    "<task-notification>",
];

/// A transcript record in the parent chain.
pub(super) struct Message {
    pub(super) parent: Option<String>,
    /// The time of a user or assistant record; other records are not read for one.
    pub(super) at: Option<f64>,
    /// Byte offset just past the record.
    pub(super) pos: u64,
    /// A prompt the person wrote, not a tool result or an internal note.
    pub(super) human: bool,
    /// A block of the assistant's final answer.
    pub(super) final_answer: bool,
    /// The chain stops here: a compaction, an internal user note, or a record outside the main session.
    pub(super) boundary: bool,
    /// The API response id; the blocks of one response share it.
    pub(super) model_id: String,
    /// The text of a prompt or a final answer; empty for other records.
    pub(super) text: Vec<String>,
}

/// A transcript read up to its last complete line.
pub(super) struct Transcript<'a> {
    pub(super) session: &'a str,
    /// Where reading stopped last time.
    pub(super) cursor: u64,
    /// Records by uuid.
    pub(super) messages: HashMap<String, Message>,
    /// The uuid of each final answer's last block, in file order.
    pub(super) answers: Vec<String>,
}

/// Reads every complete record. None skips the transcript for now: a line is still being written, or the
/// session began outside the collection window or during a pause.
pub(super) fn read<'a>(
    db: &Connection,
    path: &Path,
    session: &'a str,
    cursor: u64,
    cfg: &Settings,
) -> Result<Option<Transcript<'a>>> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut messages = HashMap::new();
    let mut answers = HashMap::new();
    let mut line = String::new();
    let mut first_message = true;
    while review_db::active(db)? {
        if !read_complete_line(&mut reader, &mut line)? {
            if line.is_empty() {
                break;
            }
            return Ok(None);
        }
        let record: Value = serde_json::from_str(&line)?;
        let Some(id) = chain_record_id(&record) else {
            continue;
        };
        let in_scope = in_main_session(&record, session, cfg);
        let message = Message::parse(&record, id, in_scope, reader.stream_position()?)?;
        if in_scope && let Some(at) = message.at {
            let began_outside = first_message && began_outside_window(db, cfg, at)?;
            if began_outside || at < cfg.start {
                return Ok(None);
            }
            first_message = false;
        }
        if in_scope && message.final_answer {
            answers.insert(message.model_id.clone(), id.to_owned());
        }
        messages.insert(id.to_owned(), message);
    }
    let mut answers: Vec<String> = answers.into_values().collect();
    answers.sort_by_key(|id| messages[id].pos);
    Ok(Some(Transcript {
        session,
        cursor,
        messages,
        answers,
    }))
}

/// The uuid of a record that links into the parent chain.
fn chain_record_id(record: &Value) -> Option<&str> {
    let linked = record["type"]
        .as_str()
        .is_some_and(|t| CHAIN_TYPES.contains(&t));
    record["uuid"].as_str().filter(|_| linked)
}

/// Whether a session whose first record is at `at` began after the end or during a pause.
fn began_outside_window(db: &Connection, cfg: &Settings, at: f64) -> Result<bool> {
    Ok(at >= cfg.end || review_db::overlaps_pause(db, at, at)?)
}

/// A record of this session's main conversation in the selected project, not a sidechain, subagent or team.
fn in_main_session(record: &Value, session: &str, cfg: &Settings) -> bool {
    record["sessionId"] == session
        && cfg.in_project(record["cwd"].as_str())
        && record["isSidechain"] != true
        && record["agentId"].is_null()
        && record["teamName"].is_null()
}

fn is_internal(record: &Value, text: &[String]) -> bool {
    record["isMeta"] == true
        || record["isCompactSummary"] == true
        || record["isApiErrorMessage"] == true
        || text.iter().any(|t| {
            INTERNAL_PREFIXES
                .iter()
                .any(|prefix| t.trim_start().starts_with(prefix))
        })
}

fn texts(content: &Value) -> Vec<String> {
    if let Some(text) = content.as_str() {
        return vec![text.to_owned()];
    }
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|part| part["type"] == "text")
        .filter_map(|part| part["text"].as_str().map(str::to_owned))
        .collect()
}

impl Message {
    fn parse(record: &Value, id: &str, in_scope: bool, pos: u64) -> Result<Self> {
        let kind = record["type"].as_str();
        let content = &record["message"]["content"];
        let has_part = |part_type: &str| {
            content
                .as_array()
                .is_some_and(|parts| parts.iter().any(|p| p["type"] == part_type))
        };
        let tool_result = has_part("tool_result");
        let text = texts(content);
        let internal = is_internal(record, &text);
        let at = match kind {
            Some("user" | "assistant") => Some(timestamp(record)?),
            _ => None,
        };
        let human = kind == Some("user") && !tool_result && !internal && !text.is_empty();
        // shortcut: completion is the end_turn stop reason; recheck after Claude updates.
        let final_answer = kind == Some("assistant")
            && record["message"]["stop_reason"] == "end_turn"
            && !internal
            && !text.is_empty()
            && !has_part("tool_use");
        let boundary = !in_scope
            || record["isCompactSummary"] == true
            || record["subtype"] == "compact_boundary"
            || (kind == Some("user") && internal && !tool_result);
        Ok(Self {
            parent: record["parentUuid"].as_str().map(str::to_owned),
            at,
            pos,
            human,
            final_answer,
            boundary,
            model_id: record["message"]["id"].as_str().unwrap_or(id).to_owned(),
            text: if human || final_answer {
                text
            } else {
                Vec::new()
            },
        })
    }
}
