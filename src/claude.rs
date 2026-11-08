//! Read only new main-session transcripts; never infer completion from file age.
use super::*;
use std::collections::{HashMap, HashSet};
use std::fs;

struct Message {
    parent: Option<String>,
    at: f64,
    pos: u64,
    human: bool,
    final_answer: bool,
    boundary: bool,
    model_id: String,
    text: Vec<String>,
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

fn evidence(
    messages: &HashMap<String, Message>,
    leaf: &str,
    session: &str,
    sanitizer: &Sanitizer,
    after: u64,
) -> Option<Turn> {
    let last = messages.get(leaf)?;
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut current = Some(leaf);
    while let Some(id) = current {
        if !seen.insert(id) {
            return None;
        }
        let message = messages.get(id)?;
        if message.boundary {
            if chain.iter().any(|(_, m): &(&str, &Message)| m.human) {
                break;
            }
            return None;
        }
        if id != leaf && message.final_answer && message.model_id != last.model_id {
            break;
        }
        chain.push((id, message));
        current = message.parent.as_deref();
    }
    chain.reverse();
    let started = chain.iter().find(|(_, m)| m.human)?.1.at;
    let mut turn = Turn {
        id: last.model_id.clone(),
        started,
        allowed: true,
        evidence: Vec::new(),
    };
    for (id, message) in chain {
        if message.pos <= after {
            continue;
        }
        let role = if message.human {
            "user"
        } else if message.final_answer && message.model_id == last.model_id {
            "assistant"
        } else {
            continue;
        };
        if message.at > last.at {
            return None;
        }
        let begin = turn.evidence.len();
        for text in &message.text {
            sanitizer.append_text(&mut turn, role, text);
        }
        for excerpt in &mut turn.evidence[begin..] {
            excerpt["source"] = json!("claude-code");
            excerpt["session_id"] = json!(session);
            excerpt["message_id"] = json!(id);
            excerpt["timestamp"] = json!(message.at);
        }
    }
    (!turn.evidence.is_empty() && (after > 0 || turn.evidence.iter().any(|e| e["role"] == "user")))
        .then_some(turn)
}

fn extract(
    db: &mut Connection,
    path: &Path,
    session: &str,
    cfg: &Settings,
    sanitizer: &Sanitizer,
) -> Result<()> {
    let chat = format!("claude-code/{session}");
    let cursor: u64 = db
        .query_row("SELECT pos FROM cursors WHERE chat=?1", [&chat], |r| {
            r.get(0)
        })
        .optional()?
        .unwrap_or(0);
    let metadata = path.metadata()?;
    if metadata.len() < cursor {
        return Err("Claude transcript shrank; checkpoint requires review".into());
    }
    if metadata.len() == cursor {
        return Ok(());
    }
    // Birth time plus the first message timestamp exclude old sessions, including resumed files.
    if metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .is_some_and(|t| t.as_secs_f64() < cfg.start)
    {
        return Ok(());
    }
    let mut reader = BufReader::new(File::open(path)?);
    let mut messages = HashMap::new();
    let mut finals = HashMap::new();
    let mut line = String::new();
    let mut first_message = true;
    while active(db)? {
        line.clear();
        reader.read_line(&mut line)?;
        if !line.ends_with('\n') {
            if !line.is_empty() {
                return Ok(());
            }
            break;
        }
        let item: Value = serde_json::from_str(&line)?;
        let Some(id) = item["uuid"].as_str() else {
            continue;
        };
        if !matches!(
            item["type"].as_str(),
            Some("user" | "assistant" | "system" | "progress" | "attachment")
        ) {
            continue;
        }
        let content = &item["message"]["content"];
        let parts = content.as_array();
        let tool_result = parts.is_some_and(|ps| ps.iter().any(|p| p["type"] == "tool_result"));
        let text = texts(content);
        let internal = item["isMeta"] == true
            || item["isCompactSummary"] == true
            || item["isApiErrorMessage"] == true
            || text.iter().any(|t| {
                [
                    "<local-command-",
                    "<command-name>",
                    "<system-reminder>",
                    "<session-start-hook>",
                    "[Request interrupted by user",
                    "<ide_",
                    "<task-notification>",
                ]
                .iter()
                .any(|prefix| t.trim_start().starts_with(prefix))
            });
        let valid_scope = item["sessionId"] == session
            && same_project(&item["cwd"], &cfg.project)
            && item["isSidechain"] != true
            && item["agentId"].is_null()
            && item["teamName"].is_null();
        let at = if matches!(item["type"].as_str(), Some("user" | "assistant")) {
            timestamp(&item)?
        } else {
            0.0
        };
        if at > 0.0 && valid_scope && first_message {
            if at >= cfg.end || overlaps_pause(db, at, at)? {
                return Ok(());
            }
            first_message = false;
        }
        if at > 0.0 && at < cfg.start && valid_scope {
            return Ok(());
        }
        let human = item["type"] == "user" && !tool_result && !internal && !text.is_empty();
        let final_answer = item["type"] == "assistant"
            && item["message"]["stop_reason"] == "end_turn"
            && !internal
            && !text.is_empty()
            && !parts.is_some_and(|ps| ps.iter().any(|p| p["type"] == "tool_use"));
        let model_id = item["message"]["id"].as_str().unwrap_or(id).to_owned();
        let boundary = !valid_scope
            || item["isCompactSummary"] == true
            || item["subtype"] == "compact_boundary"
            || (item["type"] == "user" && internal && !tool_result);
        let pos = reader.stream_position()?;
        if final_answer && valid_scope {
            finals.insert(model_id.clone(), id.to_owned());
        }
        messages.insert(
            id.to_owned(),
            Message {
                parent: item["parentUuid"].as_str().map(str::to_owned),
                at,
                pos,
                human,
                final_answer,
                boundary,
                model_id,
                text: if human || final_answer {
                    text
                } else {
                    Vec::new()
                },
            },
        );
    }
    let mut leaves: Vec<_> = finals.values().collect();
    leaves.sort_by_key(|id| messages[*id].pos);
    for leaf in leaves {
        let last = &messages[leaf];
        if last.pos <= cursor {
            continue;
        }
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        if !active(&tx)? {
            return Ok(());
        }
        let base_id = format!(
            "{:x}",
            Sha256::digest(format!("claude-code/{session}/{}", last.model_id).as_bytes())
        );
        let existing: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM jobs WHERE id=?1)",
            [&base_id],
            |r| r.get(0),
        )?;
        if let Some(mut turn) = evidence(
            &messages,
            leaf,
            session,
            sanitizer,
            if existing { cursor } else { 0 },
        ) {
            if turn.started >= cfg.start
                && last.at >= turn.started
                && last.at < cfg.end
                && !overlaps_pause(&tx, turn.started, last.at)?
            {
                // Keep analyzed/approved evidence immutable; only new blocks form a supplement.
                let id = if existing {
                    for excerpt in &mut turn.evidence {
                        excerpt["continuation_of"] = json!(base_id);
                    }
                    format!(
                        "{:x}",
                        Sha256::digest(
                            format!("claude-code/{session}/{}/continuation/{leaf}", turn.id)
                                .as_bytes()
                        )
                    )
                } else {
                    base_id
                };
                for excerpt in &mut turn.evidence {
                    excerpt["conversationId"] = json!(session);
                    excerpt["turnId"] = json!(id);
                    excerpt["at"] = json!(last.at);
                }
                tx.execute(
                    "INSERT INTO jobs VALUES(?1,?2,'new','') ON CONFLICT(id) DO NOTHING",
                    params![id, serde_json::to_string(&turn.evidence)?],
                )?;
            }
        }
        tx.execute(
            "INSERT INTO cursors VALUES(?1,?2) ON CONFLICT(chat) DO UPDATE SET pos=excluded.pos",
            params![chat, last.pos],
        )?;
        tx.commit()?;
    }
    Ok(())
}

pub(super) fn scan(db_path: &Path, claude: &Path, project_name: Option<&str>) -> Result<()> {
    if project_name.is_some_and(|name| {
        name.is_empty()
            || name.len() > 64
            || !name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    }) {
        return Err("Invalid Claude project directory name".into());
    }
    let mut db = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    db.busy_timeout(Duration::from_secs(10))?;
    db.pragma_update(None, "foreign_keys", true)?;
    if !active(&db)? {
        return Ok(());
    }
    let cfg = settings(&db)?;
    let projects = claude.join("projects");
    if !projects.try_exists()? {
        return Ok(());
    }
    let projects = projects.canonicalize()?;
    let slug: String = cfg
        .project
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let folders = if let Some(name) = project_name {
        vec![projects.join(name)]
    } else if slug.len() <= 200 {
        vec![projects.join(slug)]
    } else {
        fs::read_dir(&projects)?
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(&format!("{}-", &slug[..200]))
            })
            .map(|entry| entry.path())
            .collect()
    };
    let uuid = Regex::new(r"(?i)^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")?;
    let sanitizer = Sanitizer::new()?;
    let mut failed = false;
    // shortcut: end_turn records and default slug naming; recheck after Claude updates.
    for folder in folders {
        if !folder.try_exists()? {
            continue;
        }
        let folder = folder.canonicalize()?;
        if !folder.starts_with(&projects) || !folder.is_dir() {
            continue;
        }
        for entry in fs::read_dir(&folder)? {
            if !active(&db)? {
                return Ok(());
            }
            let path = entry?.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(session) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if !uuid.is_match(session) || path.is_symlink() || !path.is_file() {
                continue;
            }
            if extract(&mut db, &path, session, &cfg, &sanitizer).is_err() {
                failed = true;
            }
        }
    }
    if failed {
        Err("Claude transcript failed validation".into())
    } else {
        Ok(())
    }
}
