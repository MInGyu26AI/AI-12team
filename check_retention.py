"""Local retention policy on synthetic data: settled raw text clears after 7 days, everything still open stays."""
import contextlib
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest import mock

import retention
from check_local_privacy import Gate, Scripted
from check_pipeline import Client
from integration import Pipeline
from storage import connect, initialize

DAY = 86400
TEXTS = dict(shared='공유한 결정 원문 SHARED_CANARY', dismissed='버린 후보 원문 DISMISSED_CANARY', unreviewed='검토 전 원문 UNREVIEWED_CANARY',
             pending='전송 대기 원문 PENDING_CANARY', blocked='전송 차단 원문 BLOCKED_CANARY', held='보류된 원문 HELD_CANARY',
             failed='분류 실패 원문 FAILED_CANARY', personal='개인 원문 PERSONAL_CANARY')


class AI:
    before_request = None
    def chat_json(self, system, user):
        self.before_request()
        if 'FAILED_CANARY' in user:
            raise RuntimeError('synthetic outage')
        line = next(l for l in user.splitlines() if l.startswith('[1]'))
        sentence = line.split('): ', 1)[1].strip()
        return dict(cards=[dict(msg=1, relevance='related', tag='decision', subtopic='작업·결과물', sentence=sentence,
                                content='요약 ' + sentence.split()[-1], topic_key='T', confidence=.95, owner='테스트')])


class Retention(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / 'private.sqlite'; initialize(self.db)
        with connect(self.db) as c:
            c.execute("INSERT INTO settings VALUES(1,?,?,?,0,'')", (self.temp.name, time.time() - 10, time.time() + 600))
            c.execute("INSERT INTO sharing VALUES(1,?,'user','a')", (Client.api_url,))
        self.p = Pipeline(self.db, Client())
        self.p.llm_factory, self.p.decider_factory = AI, (lambda: None)
        self.p.privacy = Gate(Scripted({TEXTS['held']: dict(label='unsure', personal=[]),
                                        TEXTS['personal']: dict(label='personal', personal=[TEXTS['personal']])}))
        self.p.configure(dict(projectTopic='SyncUp', turnsPerBatch=1))

    def message(self, name, text=None):
        return dict(id=name, site='manual', conversationId='conv-' + name, role='user', roleGuessed=False,
                    text=text or TEXTS[name], collectedAt=datetime.now(timezone.utc).isoformat())

    def card(self, name):
        return next(c['id'] for c in self.p.candidates() if TEXTS[name] in c['sentence'])

    def build(self):
        for name in TEXTS:
            self.p.append([self.message(name)], True)
        self.p.process()
        for name in ('shared', 'pending', 'blocked'):
            self.p.rpc('candidates.approve', dict(ids=[self.card(name)], teamId='a'))
        self.p.rpc('candidates.dismiss', dict(id=self.card('dismissed')))
        with connect(self.db) as c:
            shared = c.execute("SELECT c.id FROM cards c JOIN outbox o ON o.id=c.id WHERE o.payload LIKE '%SHARED_CANARY%'").fetchone()[0]
            c.execute("UPDATE outbox SET state='sent' WHERE id=?", (shared,))
            c.execute("UPDATE cards SET status='shared' WHERE id=?", (shared,))
            c.execute("UPDATE outbox SET state='blocked' WHERE payload LIKE '%BLOCKED_CANARY%'")
        # Still collecting: an open turn that was never batched.
        self.p.append([self.message('buffered', '아직 묶이지 않은 원문 BUFFERED_CANARY')])

    def raw(self, canary):
        """Where a canary's raw text still sits, by table."""
        with connect(self.db) as c:
            found = {t: c.execute(f'SELECT count(*) FROM {t} WHERE {col} LIKE ?', ('%' + canary + '%',)).fetchone()[0]
                     for t, col in (('intake', 'message'), ('job_context', 'messages'), ('jobs', 'evidence'),
                                    ('candidate_details', 'body'), ('privacy_jobs', 'detail'), ('outbox', 'payload'))}
        return {t: n for t, n in found.items() if n}

    def test_only_settled_batches_clear_after_seven_days(self):
        self.build()
        t0 = time.time()
        before = {name: self.raw(name.upper() + '_CANARY') for name in [*TEXTS, 'buffered']}
        first = retention.sweep(self.db, now=t0)
        self.assertEqual(first['purgedJobs'], 0)
        self.assertEqual(retention.sweep(self.db, now=t0 + 6 * DAY)['purgedJobs'], 0, 'day 6: nothing clears yet')
        result = retention.sweep(self.db, now=t0 + 7 * DAY + 1)
        self.assertEqual(result['purgedJobs'], 3, 'shared, dismissed and the all-personal batch')
        after = {name: self.raw(name.upper() + '_CANARY') for name in [*TEXTS, 'buffered']}
        # Settled: raw text gone; the approved card and its payload are the team record and stay (frozen by trigger).
        self.assertEqual(after['shared'], {'candidate_details': 1, 'outbox': 1})
        self.assertEqual(after['dismissed'], {})
        self.assertEqual(after['personal'], {})
        # Open items keep their text, whatever their age.
        for name in ('unreviewed', 'pending', 'blocked', 'held', 'failed', 'buffered'):
            self.assertEqual(after[name], before[name], name)
        with connect(self.db) as c:
            self.assertEqual(c.execute('PRAGMA foreign_key_check').fetchall(), [])
            self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(c.execute('SELECT count(*) FROM outbox').fetchone()[0], 3)
            dismissed = json.loads(c.execute('SELECT body FROM candidate_details WHERE dismissed=1').fetchone()[0])
        self.assertEqual((dismissed['sentence'], dismissed['evidence']['quote']), (retention.PURGED, retention.PURGED))
        self.assertEqual(retention.sweep(self.db, now=t0 + 30 * DAY)['purgedJobs'], 0, 'idempotent')

    def test_resent_message_after_clearing_is_not_reported_as_changed(self):
        self.p.append([self.message('shared')], True)
        self.p.process()
        self.p.rpc('candidates.dismiss', dict(id=self.card('shared')))
        t0 = time.time()
        retention.sweep(self.db, now=t0); retention.sweep(self.db, now=t0 + 8 * DAY)
        self.assertEqual(self.raw('SHARED_CANARY'), {})
        response = self.p.append([self.message('shared')], True)
        self.assertEqual((response['newMessages'], response['intakeIssues']), (0, []))
        self.assertEqual(self.raw('SHARED_CANARY'), {})

    def test_reopened_batch_is_not_cleared(self):
        self.p.append([self.message('dismissed')], True)
        self.p.process()
        identifier = self.card('dismissed')
        self.p.rpc('candidates.dismiss', dict(id=identifier))
        t0 = time.time()
        retention.sweep(self.db, now=t0)
        with connect(self.db) as c:  # e.g. a later retry produced a fresh unreviewed candidate from the same batch
            c.execute('UPDATE candidate_details SET dismissed=0 WHERE id=?', (identifier,))
        self.assertEqual(retention.sweep(self.db, now=t0 + 8 * DAY)['purgedJobs'], 0)
        self.assertTrue(self.raw('DISMISSED_CANARY'))

    def test_resolved_quarantine_cache_and_backups_expire(self):
        self.p.append([self.message('shared')], True)
        issue = self.p.append([self.message('shared', '바뀐 원문 ISSUE_CANARY')])['intakeIssues'][0]['id']
        self.p.rpc('intake.dismiss', dict(id=issue, teamId='a'))
        open_issue = self.p.append([self.message('shared', '또 바뀐 원문 OPEN_CANARY')])['intakeIssues'][0]['id']
        self.p.process()
        folder = Path(self.temp.name)
        old, fresh, other = folder / 'private.sqlite.v1-abc.bak.sqlite', folder / 'private.sqlite.integration-def.bak.sqlite', folder / 'other.v1-x.bak.sqlite'
        for f in (old, fresh, other):
            f.write_bytes(b'synthetic backup')
        t0 = time.time()
        os.utime(old, (t0 - 8 * DAY, t0 - 8 * DAY)); os.utime(other, (t0 - 8 * DAY, t0 - 8 * DAY))
        result = retention.sweep(self.db, now=t0)
        self.assertEqual(result['backupsDeleted'], 1)
        self.assertEqual((old.exists(), fresh.exists(), other.exists()), (False, True, True))
        later = retention.sweep(self.db, now=t0 + 8 * DAY)
        # 8 days on, the fresh backup and the Pipeline's own migration backup have expired too; other files stay.
        self.assertEqual(later['purgedIssues'], 1)
        self.assertGreaterEqual(later['backupsDeleted'], 2)
        self.assertEqual((fresh.exists(), other.exists(), list(folder.glob('private.sqlite.*.bak.sqlite'))), (False, True, []))
        self.assertGreater(later['cacheDeleted'], 0)
        self.assertEqual(later['backupErrors'], 0)
        with connect(self.db) as c:
            issues = dict(c.execute('SELECT id,message FROM intake_issues'))
            self.assertEqual(c.execute('SELECT count(*) FROM privacy_results').fetchone()[0], 0)
        self.assertEqual(json.loads(issues[issue]), retention.PURGED)
        self.assertIn('OPEN_CANARY', issues[open_issue], 'unresolved quarantine stays')

    def test_backup_delete_failure_is_counted_not_silent(self):
        old = Path(self.temp.name) / 'private.sqlite.v1-locked.bak.sqlite'
        old.write_bytes(b'synthetic backup')
        t0 = time.time(); os.utime(old, (t0 - 8 * DAY, t0 - 8 * DAY))
        err = io.StringIO()
        with mock.patch.object(Path, 'unlink', side_effect=PermissionError('synthetic')), contextlib.redirect_stderr(err):
            result = retention.sweep(self.db, now=t0)
        self.assertEqual((result['backupsDeleted'], result['backupErrors']), (0, 1))
        self.assertIn('PermissionError', err.getvalue())
        self.assertNotIn('locked', err.getvalue(), 'file names stay out of the log')
        self.assertTrue(old.exists())


if __name__ == '__main__':
    unittest.main()
