//! Fields that Codex and Claude Code log records both carry.
use crate::Result;
use chrono::DateTime;
use serde_json::Value;
use std::path::Path;

/// The record's RFC 3339 `timestamp` in Unix seconds, to the millisecond.
pub fn timestamp(record: &Value) -> Result<f64> {
    let raw = record["timestamp"].as_str().ok_or("missing timestamp")?;
    Ok(DateTime::parse_from_rfc3339(raw)?.timestamp_millis() as f64 / 1000.0)
}

/// Whether a record's working directory is the selected project; canonical paths let aliases match.
pub fn same_project(cwd: Option<&str>, project: &str) -> bool {
    let Some(cwd) = cwd else {
        return false;
    };
    if cwd == project {
        return true;
    }
    match (
        Path::new(cwd).canonicalize(),
        Path::new(project).canonicalize(),
    ) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}
