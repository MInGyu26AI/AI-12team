//! Claude Code turns: each final answer's parent chain back to its prompt, stored as a job.
use super::chat_key;
use super::transcript::{Message, Transcript};
use crate::Result;
use crate::excerpt::ExcerptSplitter;
use crate::review_db::{self, Settings};
use rusqlite::Connection;
use serde_json::{Value, json};
use std::collections::HashSet;

/// One turn's evidence, from the prompt that started it to the end of its final answer.
struct Turn {
    started: f64,
    ended: f64,
    evidence: Vec<Value>,
}

/// Stores each final answer after the cursor, moving the cursor past it in the same transaction.
pub(super) fn store(
    db: &mut Connection,
    transcript: &Transcript,
    cfg: &Settings,
    excerpts: &ExcerptSplitter,
) -> Result<()> {
    let chat = chat_key(transcript.session);
    for leaf in &transcript.answers {
        let pos = transcript.messages[leaf].pos;
        if pos <= transcript.cursor {
            continue;
        }
        let tx = review_db::begin(db)?;
        if !review_db::active(&tx)? {
            return Ok(());
        }
        store_turn(&tx, transcript, &chat, leaf, cfg, excerpts)?;
        review_db::save_cursor(&tx, &chat, pos)?;
        tx.commit()?;
    }
    Ok(())
}

/// Stores the turn ending at `leaf` as a job. A response stored before gets only its blocks after the
/// cursor, as a continuation job, so evidence that was analyzed or approved never changes.
fn store_turn(
    tx: &Connection,
    transcript: &Transcript,
    chat: &str,
    leaf: &str,
    cfg: &Settings,
    excerpts: &ExcerptSplitter,
) -> Result<()> {
    let model_id = &transcript.messages[leaf].model_id;
    let base_id = review_db::job_id(&format!("{chat}/{model_id}"));
    let stored = review_db::job_exists(tx, &base_id)?;
    let after = if stored { transcript.cursor } else { 0 };
    let Some(mut turn) = turn(transcript, leaf, excerpts, after) else {
        return Ok(());
    };
    if turn.ended < turn.started || !review_db::within_window(tx, cfg, turn.started, turn.ended)? {
        return Ok(());
    }
    let id = if stored {
        for excerpt in &mut turn.evidence {
            excerpt["continuation_of"] = json!(base_id);
        }
        review_db::job_id(&format!("{chat}/{model_id}/continuation/{leaf}"))
    } else {
        base_id
    };
    review_db::insert_job(tx, &id, transcript.session, turn.ended, turn.evidence)
}

/// The turn ending at `leaf`, with excerpts from records after byte `after` only. None when the chain is
/// broken or out of order, when nothing new remains, or when a turn read from the start has no prompt.
fn turn(
    transcript: &Transcript,
    leaf: &str,
    excerpts: &ExcerptSplitter,
    after: u64,
) -> Option<Turn> {
    let last = transcript.messages.get(leaf)?;
    let chain = chain(transcript, leaf)?;
    let started = chain.iter().find(|(_, m)| m.human)?.1.at?;
    let ended = last.at?;
    let mut evidence = Vec::new();
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
        let at = message.at?;
        if at > ended {
            return None;
        }
        let begin = evidence.len();
        for text in &message.text {
            excerpts.append(&mut evidence, role, text);
        }
        for excerpt in &mut evidence[begin..] {
            excerpt["source"] = json!("claude-code");
            excerpt["session_id"] = json!(transcript.session);
            excerpt["message_id"] = json!(id);
            excerpt["timestamp"] = json!(at);
        }
    }
    let has_prompt = after > 0 || evidence.iter().any(|e| e["role"] == "user");
    (!evidence.is_empty() && has_prompt).then_some(Turn {
        started,
        ended,
        evidence,
    })
}

/// The records of the turn ending at `leaf`, oldest first: parents back past its prompt until another
/// response's final answer. None for a parent loop, a missing parent, or a boundary before any prompt.
fn chain<'a>(transcript: &'a Transcript, leaf: &'a str) -> Option<Vec<(&'a str, &'a Message)>> {
    let model_id = &transcript.messages.get(leaf)?.model_id;
    let mut chain: Vec<(&str, &Message)> = Vec::new();
    let mut seen = HashSet::new();
    let mut current = Some(leaf);
    while let Some(id) = current {
        if !seen.insert(id) {
            return None;
        }
        let message = transcript.messages.get(id)?;
        if message.boundary {
            if chain.iter().any(|(_, m)| m.human) {
                break;
            }
            return None;
        }
        if id != leaf && message.final_answer && message.model_id != *model_id {
            break;
        }
        chain.push((id, message));
        current = message.parent.as_deref();
    }
    chain.reverse();
    Some(chain)
}
