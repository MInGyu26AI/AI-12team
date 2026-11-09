//! Evidence excerpts: message text cut into sentences with secrets masked, at a bounded size per turn.
use crate::Result;
use regex::Regex;
use serde_json::{Value, json};

// shortcut: a long turn is cut at these limits; add chunking before supporting long chats.
const MAX_EXCERPTS: usize = 24;
const MAX_EXCERPT_CHARS: usize = 600;

/// API keys, tokens, `name=value` secrets and e-mail addresses.
const SECRETS: &str = r"(?i)sk-[\w-]{12,}|gh[pousr]_[\w]{16,}|AKIA[A-Z0-9]{16}|Bearer\s+[\w./+=-]+|(?:api[_ -]?key|password|secret|token)\s*[:=]\s*[^\s,;]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}";
const MASK: &str = "[가림]";

/// Text a coding tool puts into the conversation itself (environment, instructions, notices).
const INJECTED_PREFIXES: &[&str] = &[
    "<environment_context",
    "# AGENTS.md instructions",
    "<external_",
    "<send_user_",
    "<system",
    "<permissions",
    "An MCP app initiated",
    "## Referenced chats",
];

pub struct ExcerptSplitter {
    secrets: Regex,
    line_breaks: Regex,
}

impl ExcerptSplitter {
    pub fn new() -> Result<Self> {
        Ok(Self {
            secrets: Regex::new(SECRETS)?,
            line_breaks: Regex::new(r"\n+")?,
        })
    }

    /// Appends `role`'s text to a turn's evidence as one numbered excerpt per line and sentence.
    pub fn append(&self, evidence: &mut Vec<Value>, role: &str, text: &str) {
        let text = text.trim();
        if text.is_empty() || INJECTED_PREFIXES.iter().any(|p| text.starts_with(p)) {
            return;
        }
        let masked = self.secrets.replace_all(text, MASK);
        for line in self.line_breaks.split(&masked) {
            // Split after sentence-ending punctuation that a space follows, keeping the punctuation.
            let mut start = 0;
            let mut previous = ' ';
            for (offset, ch) in line.char_indices() {
                if ch.is_whitespace() && matches!(previous, '.' | '!' | '?' | '。') {
                    push(evidence, role, &line[start..offset]);
                    start = offset;
                }
                previous = ch;
            }
            push(evidence, role, &line[start..]);
        }
    }
}

fn push(evidence: &mut Vec<Value>, role: &str, text: &str) {
    let text = text.trim();
    if !text.is_empty() && evidence.len() < MAX_EXCERPTS {
        let text: String = text.chars().take(MAX_EXCERPT_CHARS).collect();
        evidence.push(json!({"n": evidence.len() + 1, "role": role, "text": text}));
    }
}
