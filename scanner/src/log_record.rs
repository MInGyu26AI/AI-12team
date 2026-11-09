//! Reading the JSONL logs that Codex and Claude Code append to while the scanners read them.
use crate::Result;
use chrono::DateTime;
use serde_json::Value;
use std::io::BufRead;

/// Reads the next line into `line` and returns whether it is complete. A line without its newline is
/// still being written, or `line` is empty at the end of the log.
pub fn read_complete_line(reader: &mut impl BufRead, line: &mut String) -> Result<bool> {
    line.clear();
    reader.read_line(line)?;
    Ok(line.ends_with('\n'))
}

/// The record's RFC 3339 `timestamp` in Unix seconds, to the millisecond.
pub fn timestamp(record: &Value) -> Result<f64> {
    let raw = record["timestamp"].as_str().ok_or("missing timestamp")?;
    Ok(DateTime::parse_from_rfc3339(raw)?.timestamp_millis() as f64 / 1000.0)
}
