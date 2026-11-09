"""Local retention: clear settled raw text and drop old migration backups.

Policy confirmed 2026-11-08:
- Raw conversation text: 7 days after a batch is fully settled.
- Local privacy-model answer cache: 7 days after it was written, whatever the batch state (it is keyed by text hash).
- Migration backups (<db>.*.bak.sqlite next to the database): 7 days after they were written.

A batch is settled when it was processed (`jobs.state='done'`) and every card from it is shared or dismissed,
with nothing waiting in the outbox. Unreviewed, held, failed, still-collecting and not-yet-delivered items are
never touched, whatever their age. Rows are kept and only their text is cleared, so card records, approved
payloads and references stay intact. The clock starts the first time a sweep sees the batch settled.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys
import time

from storage import connect

RAW_DAYS = 7
BACKUP_DAYS = 7
PURGED = '[보존기간 만료]'
PURGED_JSON = json.dumps(PURGED, ensure_ascii=False)
DAY = 86400

UNSETTLED_CARD = '''SELECT 1 FROM cards c LEFT JOIN candidate_details d ON d.id=c.id LEFT JOIN outbox o ON o.id=c.id
    WHERE c.job=j.id AND (c.status IN ('drafting','manual','queued') OR (c.status='ready' AND COALESCE(d.dismissed,0)=0)
                          OR o.state IN ('pending','blocked'))'''
LEGACY_UNSETTLED_CARD = '''SELECT 1 FROM cards c LEFT JOIN outbox o ON o.id=c.id
    WHERE c.job=j.id AND (c.status IN ('drafting','manual','queued','ready') OR o.state IN ('pending','blocked'))'''


def _tables(c) -> set[str]:
    return {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def initialize(c) -> None:
    c.execute('''CREATE TABLE IF NOT EXISTS retention_jobs(job TEXT PRIMARY KEY REFERENCES jobs(id),
                 settled REAL NOT NULL, purged REAL)''')


def _blank(message):
    return dict(message, text='', purged=True)


def _purge_job(c, job: str, tables: set[str]) -> None:
    evidence = json.loads(c.execute('SELECT evidence FROM jobs WHERE id=?', (job,)).fetchone()[0])
    c.execute('UPDATE jobs SET evidence=? WHERE id=?', (json.dumps([dict(e, text='') for e in evidence], ensure_ascii=False), job))
    if 'intake' in tables:
        for row in c.execute('SELECT id,message FROM intake WHERE job=?', (job,)).fetchall():
            c.execute('UPDATE intake SET message=? WHERE id=?', (json.dumps(_blank(json.loads(row[1])), ensure_ascii=False), row[0]))
    if 'job_context' in tables:
        row = c.execute('SELECT messages FROM job_context WHERE job=?', (job,)).fetchone()
        if row:
            messages = [_blank(m) for m in json.loads(row[0])]
            c.execute('UPDATE job_context SET messages=? WHERE job=?', (json.dumps(messages, ensure_ascii=False), job))
    if 'privacy_jobs' in tables:
        row = c.execute('SELECT detail FROM privacy_jobs WHERE job=?', (job,)).fetchone()
        if row:
            detail = [dict(d, sanitized=None) for d in json.loads(row[0])]
            c.execute('UPDATE privacy_jobs SET detail=? WHERE job=?', (json.dumps(detail, ensure_ascii=False), job))
    if 'candidate_details' in tables:
        # Dismissed candidates were never shared: clear the quoted text. Approved ones are the team record and stay.
        for row in c.execute('''SELECT d.id,d.body FROM candidate_details d JOIN cards c ON c.id=d.id
                                WHERE c.job=? AND d.dismissed=1 AND c.id NOT IN (SELECT id FROM outbox)''', (job,)).fetchall():
            body = json.loads(row[1])
            for key in ('sentence', 'content', 'reason'):
                if isinstance(body.get(key), str):
                    body[key] = PURGED
            if isinstance(body.get('evidence'), dict):
                body['evidence']['quote'] = PURGED
            c.execute('UPDATE candidate_details SET body=? WHERE id=?', (json.dumps(body, ensure_ascii=False), row[0]))
            c.execute('UPDATE cards SET draft=?,quote=? WHERE id=?', (PURGED, PURGED, row[0]))


def sweep(db, now: float | None = None) -> dict:
    """Apply the retention policy once. Safe to call repeatedly; returns counts only (no content)."""
    now = time.time() if now is None else now
    result = dict(settled=0, purgedJobs=0, purgedIssues=0, cacheDeleted=0, backupsDeleted=0, backupErrors=0)
    with connect(db) as c:
        c.execute('BEGIN IMMEDIATE')
        initialize(c)
        tables = _tables(c)
        unsettled = UNSETTLED_CARD if 'candidate_details' in tables else LEGACY_UNSETTLED_CARD
        newly = c.execute(f'''INSERT INTO retention_jobs(job,settled) SELECT j.id,? FROM jobs j
            WHERE j.state='done' AND j.id NOT IN (SELECT job FROM retention_jobs) AND NOT EXISTS({unsettled})''', (now,))
        result['settled'] = newly.rowcount
        due = [r[0] for r in c.execute('SELECT r.job FROM retention_jobs r JOIN jobs j ON j.id=r.job '
                                       "WHERE r.purged IS NULL AND r.settled<=? AND j.state='done'", (now - RAW_DAYS * DAY,))]
        for job in due:
            # Re-check at purge time: a later retry or approval may have reopened the batch.
            if c.execute(f"SELECT 1 FROM jobs j WHERE j.id=? AND EXISTS({unsettled})", (job,)).fetchone():
                continue
            _purge_job(c, job, tables)
            c.execute('UPDATE retention_jobs SET purged=? WHERE job=?', (now, job))
            result['purgedJobs'] += 1
        if {'intake_issues', 'intake_resolutions'} <= tables:
            stale = c.execute('''UPDATE intake_issues SET message=? WHERE message!=? AND id IN
                (SELECT issue_id FROM intake_resolutions WHERE resolved<=?)''', (PURGED_JSON, PURGED_JSON, now - RAW_DAYS * DAY))
            result['purgedIssues'] = stale.rowcount
        if 'privacy_results' in tables:
            result['cacheDeleted'] = c.execute('DELETE FROM privacy_results WHERE decided<=?', (now - RAW_DAYS * DAY,)).rowcount
    _drop_old_backups(db, now, result)
    return result


def _drop_old_backups(db, now, result):
    path = Path(db)
    errors = set()
    for backup in path.parent.glob(path.name + '.*.bak.sqlite'):
        try:
            if backup.is_file() and not backup.is_symlink() and backup.stat().st_mtime <= now - BACKUP_DAYS * DAY:
                backup.unlink()
                result['backupsDeleted'] += 1
        except OSError as error:
            # Keep going with the other backups, but never fail silently: a backup that cannot be
            # deleted still holds raw text. File names stay out of the log.
            result['backupErrors'] += 1
            errors.add(type(error).__name__)
    if errors:
        print(f"retention: 오래된 백업 {result['backupErrors']}개를 지우지 못했습니다 ({', '.join(sorted(errors))})", file=sys.stderr)
