"""On-device privacy gate in front of every external AI request.

Order: format rules (privacy_rules) -> on-device semantic check (privacy_model) -> allow / exclude / hold.

- allow: only the sanitized text may leave the device.
- exclude: personal content. Never sent; the original stays in the local database.
- hold: the model is missing, slow, broken or unsure, or rules and model disagree. Kept locally
  until the user excludes it or a recheck allows it. There is no external fallback.

`masked=True` from the older regex step is not a privacy pass; only `allow` from this gate is.
Results carry the policy and model identity, so a new policy or model re-evaluates everything.
The last line of defence before sending is outbound_guard.
"""
from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass, field
import hashlib
import json
import re
import sqlite3
import time

from ai.syncup_ai import config as ai_config
from outbound_guard import BLOCK_REASONS, blocked_reason, message_fragments
from privacy_model import ModelFailure, ModelOutputError, ModelTimeout, ModelUnavailable, classifier_from_env
from privacy_rules import PERSONAL_TOKEN, SECRET_TOKEN, apply_rules, personal_categories, secret_values

# v3 invalidates cached answers accepted before strict JSON validation; v2 credential masking is retained.
POLICY_VERSION = 'syncup-local-privacy/3'
ALLOW, EXCLUDE, HOLD = 'allow', 'exclude', 'hold'
# Holds caused by the runtime, not the content, are re-checked on their own after a short wait.
TRANSIENT = ('model_unavailable', 'model_timeout', 'model_error')
# The user asked for another look; the row stays 'hold' (nothing is sent) until the next run decides again.
REQUESTED = ('recheck_requested', 'exclude_requested')
RECHECK_SECONDS = 60
# Hold reason for each model failure; any other ModelFailure (HTTP or protocol) is 'model_error'.
FAILURE_REASON = {ModelUnavailable: 'model_unavailable', ModelTimeout: 'model_timeout', ModelOutputError: 'model_output'}

_DEFAULT_GATE = None


def default_gate():
    """One gate per process, so the model identity check is not repeated every scan."""
    global _DEFAULT_GATE
    if _DEFAULT_GATE is None:
        _DEFAULT_GATE = Gate(classifier_from_env())
    return _DEFAULT_GATE


@dataclass
class Result:
    decision: str
    reason: str
    sanitized: str = ''
    categories: list[str] = field(default_factory=list)
    rules: list[str] = field(default_factory=list)
    spans: list[str] = field(default_factory=list)


@dataclass
class JobReview:
    decision: str
    reason: str
    model: str | None
    messages: list[dict]
    context_messages: list[dict]
    context: dict
    fragments: list[str]
    detail: list[dict]


def initialize(c) -> None:
    # Compact local-model answers: label plus span offsets only, no text (see _compact).
    c.execute('''CREATE TABLE IF NOT EXISTS privacy_results(key TEXT PRIMARY KEY, policy TEXT NOT NULL, model TEXT NOT NULL,
                 label TEXT NOT NULL CHECK(json_valid(label)), decided REAL NOT NULL)''')
    c.execute('''CREATE TABLE IF NOT EXISTS privacy_jobs(job TEXT PRIMARY KEY REFERENCES jobs(id), policy TEXT NOT NULL,
                 model TEXT, decision TEXT NOT NULL CHECK(decision IN ('allow','exclude','hold')), reason TEXT NOT NULL,
                 detail TEXT NOT NULL CHECK(json_valid(detail)), decided REAL NOT NULL)''')
    c.execute('''CREATE TABLE IF NOT EXISTS privacy_overrides(job TEXT NOT NULL REFERENCES jobs(id), message_id TEXT NOT NULL,
                 action TEXT NOT NULL CHECK(action='exclude'), decided REAL NOT NULL, PRIMARY KEY(job, message_id))''')


def _limit(text: str, role: str) -> str:
    limit = ai_config.MAX_AI_CHARS if role == 'assistant' else ai_config.MAX_USER_CHARS
    return text[:limit] + ' …(이하 생략)' if len(text) > limit else text


def _compact(text: str, label) -> dict:
    """Cache form of a model answer: label plus span offsets, so no text is copied into the cache."""
    spans = label.get('personal') if isinstance(label, dict) else None
    if not isinstance(label, dict) or not isinstance(spans, list) or any(not isinstance(s, str) for s in spans):
        return dict(valid=False)
    found = [[text.find(s.strip()), text.find(s.strip()) + len(s.strip())] for s in spans if s.strip()]
    return dict(valid=True, label=label.get('label'), spans=[f for f in found if f[0] >= 0],
                unmatched=sum(f[0] < 0 for f in found), count=len(spans))


def _expand(text: str, stored: dict):
    if not stored.get('valid'):
        return None
    # An unmatched span becomes a marker that cannot occur in text, so judge() still holds.
    personal = [text[s:e] for s, e in stored['spans']] + ['\x00unmatched'] * stored['unmatched']
    return dict(label=stored['label'], personal=personal + [''] * (stored['count'] - len(personal)))


def _key(identity: str, role, masked: str) -> str:
    return hashlib.sha256(json.dumps([POLICY_VERSION, identity, role, masked], ensure_ascii=False).encode()).hexdigest()


def _meaningful(text: str) -> int:
    for token in (PERSONAL_TOKEN, SECRET_TOKEN, '[연락처]', '[이메일]', '[주민번호]', '[계좌]'):
        text = text.replace(token, '')
    return len(re.findall(r'[0-9A-Za-z가-힣]', text))


def judge(text: str, label: dict, allowed: str = '') -> Result:
    """Combine one model answer with the lexicon. Anything inconsistent holds."""
    categories = personal_categories(text, allowed)
    if not isinstance(label, dict) or label.get('label') not in ('work', 'personal', 'mixed', 'unsure'):
        return Result(HOLD, 'model_output', categories=categories)
    spans = label.get('personal')
    if not isinstance(spans, list) or len(spans) > 10 or any(not isinstance(s, str) for s in spans):
        return Result(HOLD, 'model_output', categories=categories)
    spans = [s.strip() for s in spans if s.strip()]
    kind = label['label']
    if kind == 'unsure':
        return Result(HOLD, 'model_unsure', categories=categories)
    if kind == 'personal':
        return Result(EXCLUDE, 'personal', categories=categories, spans=spans)
    if kind == 'work' and not spans:
        if categories:
            return Result(HOLD, 'rule_model_conflict', categories=categories)
        return Result(ALLOW, 'work', sanitized=text)
    # mixed, or work with personal spans: redact exact spans only.
    if not spans or any(s not in text for s in spans):
        return Result(HOLD, 'model_output', categories=categories, spans=[s for s in spans if s in text])
    redacted = text
    for span in sorted(set(spans), key=len, reverse=True):
        redacted = redacted.replace(span, PERSONAL_TOKEN)
    residual = personal_categories(redacted, allowed)
    if residual:
        return Result(HOLD, 'residual_personal', categories=categories, spans=spans)
    if _meaningful(redacted) < 4 or _meaningful(redacted) * 4 < _meaningful(text):
        # "Mixed" yet almost everything is personal: the answer contradicts itself, so the user decides.
        return Result(HOLD, 'model_output', categories=categories, spans=spans)
    return Result(ALLOW, 'mixed_redacted', sanitized=redacted, categories=categories, spans=spans)


def _job_decision(detail: list[dict]) -> tuple[str, str]:
    """(decision, reason) of a whole batch: any hold holds it, all excluded excludes it, otherwise it is allowed."""
    holds = [d['reason'] for d in detail if d['decision'] == HOLD]
    if holds:
        return HOLD, holds[0]
    if detail and all(d['decision'] == EXCLUDE for d in detail):
        return EXCLUDE, 'all_excluded'
    return ALLOW, 'allowed'


def _user_exclusions(db, job: str) -> set[str]:
    with closing(sqlite3.connect(db, timeout=10)) as c:
        return {r[0] for r in c.execute('SELECT message_id FROM privacy_overrides WHERE job=?', (job,))}


def _context_exclusions(db, job: str) -> set[str]:
    """Messages of an earlier batch that must not go out as context: the user's exclusions and the ones its
    outbound check refused (held with a block reason)."""
    excluded = _user_exclusions(db, job)
    with closing(sqlite3.connect(db, timeout=10)) as c:
        row = c.execute('SELECT detail FROM privacy_jobs WHERE job=?', (job,)).fetchone()
    if row:
        excluded |= {d['id'] for d in json.loads(row[0]) if d.get('decision') == HOLD and d.get('reason') in BLOCK_REASONS}
    return excluded


def _blocked_pieces(original: str, result: Result) -> list[str]:
    """Text an outgoing payload must not carry: secrets, personal spans and, unless allowed, the message itself."""
    pieces = secret_values(original) + [s for s in result.spans if len(s) >= 4]
    return pieces if result.decision == ALLOW else pieces + message_fragments(original)


class Gate:
    def __init__(self, classifier):
        self.classifier = classifier
        self.last_state = dict(model=None, available=None, reason=None)

    def _identity(self) -> str | None:
        try:
            identity = self.classifier.identity()
            self.last_state.update(model=identity, available=True, reason=None)
            return identity
        except ModelFailure as error:
            self.last_state.update(available=False, reason=FAILURE_REASON.get(type(error), 'model_error'))
            return None

    def check(self, db, text: str, role: str, identity: str | None, allowed: str = '') -> Result:
        """One message. The model's raw answer is cached per policy/model/text; the judgment is re-applied each time."""
        masked, rules = apply_rules(_limit(str(text), role))
        if identity is None:
            return Result(HOLD, self.last_state['reason'] or 'model_unavailable', rules=rules,
                          categories=personal_categories(masked, allowed))
        key = _key(identity, role, masked)
        with closing(sqlite3.connect(db, timeout=10)) as c:
            row = c.execute('SELECT label FROM privacy_results WHERE key=?', (key,)).fetchone()
        if row:
            label = _expand(masked, json.loads(row[0]))
        else:
            try:
                label = self.classifier.classify(masked)
            except ModelFailure as error:
                return Result(HOLD, FAILURE_REASON.get(type(error), 'model_error'), rules=rules,
                              categories=personal_categories(masked, allowed))
            with closing(sqlite3.connect(db, timeout=10)) as c, c:
                c.execute('INSERT OR REPLACE INTO privacy_results VALUES(?,?,?,?,?)',
                          (key, POLICY_VERSION, identity, json.dumps(_compact(masked, label)), time.time()))
        result = judge(masked, label, allowed)
        result.rules = rules
        return result

    def waiting(self, c, job: str) -> bool:
        """A held job is skipped until the user acts, or briefly when the runtime was the cause."""
        row = c.execute('SELECT decision,reason,decided,policy FROM privacy_jobs WHERE job=?', (job,)).fetchone()
        if not row or row[0] != HOLD or row[3] != POLICY_VERSION or row[1] in REQUESTED:
            return False
        return row[1] not in TRANSIENT or time.time() - row[2] < RECHECK_SECONDS

    def _decide(self, db, message: dict, excluded: set, identity: str | None, topic: str) -> Result:
        if message.get('id') in excluded:
            return Result(EXCLUDE, 'user_excluded')
        return self.check(db, str(message.get('text', '')), message.get('role'), identity, topic)

    def review_job(self, db, job: str, messages: list[dict], context_messages: list[dict], context: dict,
                   context_job: str | None = None) -> JobReview:
        """context_messages come from context_job; what the user or the outbound check excluded there stays local."""
        identity = self._identity()
        topic = context.get('projectTopic') if isinstance(context.get('projectTopic'), str) else ''
        excluded = _user_exclusions(db, job)
        detail, allowed, fragments = [], [], []
        for m in messages:
            original = str(m.get('text', ''))
            result = self._decide(db, m, excluded, identity, topic)
            detail.append(dict(id=m.get('id'), decision=result.decision, reason=result.reason,
                               categories=result.categories, rules=result.rules,
                               sanitized=result.sanitized if result.decision == ALLOW else None))
            if result.decision == ALLOW:
                allowed.append(dict(m, text=result.sanitized, masked=result.sanitized != original or bool(m.get('masked')),
                                    privacy=result.reason))
            fragments += _blocked_pieces(original, result)
        context_excluded = _context_exclusions(db, context_job) if context_job else set()
        context_allowed = []
        for m in context_messages:
            original = str(m.get('text', ''))
            result = self._decide(db, m, context_excluded, identity, topic)
            if result.decision == ALLOW:
                context_allowed.append(dict(m, text=result.sanitized, privacy=result.reason))
            fragments += _blocked_pieces(original, result)
        fragments = sorted(set(fragments), key=len, reverse=True)
        # Context is reference only: leave out a context message that carries a blocked piece instead of holding this
        # batch for good (the user cannot exclude a message of an earlier batch).
        context_allowed = [m for m in context_allowed if not blocked_reason(m['text'], fragments)]
        clean_context = {k: apply_rules(v)[0] if isinstance(v, str) else v for k, v in context.items()}
        decision, reason = _job_decision(detail)
        self.record(db, job, decision, reason, identity, detail)
        return JobReview(decision, reason, identity, allowed, context_allowed, clean_context, fragments, detail)

    def record(self, db, job, decision, reason, identity, detail):
        with closing(sqlite3.connect(db, timeout=10)) as c, c:
            c.execute('INSERT OR REPLACE INTO privacy_jobs VALUES(?,?,?,?,?,?,?)',
                      (job, POLICY_VERSION, identity, decision, reason, json.dumps(detail, ensure_ascii=False), time.time()))

    def forget_holds(self, c, messages: list[dict], identity: str | None) -> None:
        """Drop the cached answers of the model that judged these messages (privacy_jobs.model), so a recheck asks again.

        The identity comes from the stored decision, not from this process: after a restart no model has been asked yet.
        """
        if not identity:
            return
        for m in messages:
            masked = apply_rules(_limit(str(m.get('text', '')), m.get('role')))[0]
            c.execute('DELETE FROM privacy_results WHERE key=?', (_key(identity, m.get('role'), masked),))


def review_evidence(db, gate: 'Gate', job: str, evidence: list[dict]):
    """Legacy collector excerpts [{n, role, text, ...}] -> (decision, sanitized evidence, fragments)."""
    with closing(sqlite3.connect(db, timeout=10)) as c, c:
        initialize(c)
        if gate.waiting(c, job):
            return HOLD, [], []
    messages = [dict(id=str(e.get('n')), role=e.get('role'), text=str(e.get('text', ''))) for e in evidence]
    review = gate.review_job(db, job, messages, [], {})
    allowed = {m['id']: m['text'] for m in review.messages}
    return review.decision, [dict(e, text=allowed[str(e.get('n'))]) for e in evidence if str(e.get('n')) in allowed], review.fragments
