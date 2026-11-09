"""Real SQLite checks with deterministic AI; no external calls."""
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import struct
import tempfile
import time
import unittest
from integration import Pipeline
from storage import connect, initialize
from native_host import read_frame
from check_local_privacy import work_gate

class Client:
    api_url='https://example.test/'
    user_id='user'
    def me(self):
        return dict(user_id='user',name='테스트',teams=[dict(id='a',name='팀 A'),dict(id='b',name='팀 B')])

class AI:
    before_request=None
    def __init__(self): self.calls=[]; self.fail=False; self.invented=False
    def chat_json(self, system, user):
        self.before_request(); self.calls.append(user)
        if self.fail: raise RuntimeError('test outage')
        return dict(cards=[dict(msg=2 if '[참고용]' in user else 1,relevance='related',tag='decision',subtopic='작업·결과물',
            sentence='없는 근거' if self.invented else 'SQLite로 결정했다.',content='DB = SQLite',topic_key='DB',confidence=.95,owner='테스트')])

class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.db=Path(self.temp.name)/'private.sqlite'; initialize(self.db)
        with connect(self.db) as c:
            c.execute("INSERT INTO settings VALUES(1,?,?,?,0,'')",(self.temp.name,time.time()-10,time.time()+600))
            c.execute("INSERT INTO sharing VALUES(1,?,'user','a')",(Client.api_url,))
        self.pipeline=Pipeline(self.db,Client()); self.ai=AI(); self.pipeline.privacy=work_gate()
        self.pipeline.llm_factory=lambda:self.ai; self.pipeline.decider_factory=lambda:None
        self.pipeline.configure(dict(projectTopic='SyncUp',turnsPerBatch=1))
    def message(self, identifier='one', guessed=False):
        return dict(id=identifier,site='manual',conversationId='conv',role='user',roleGuessed=guessed,text='SQLite로 결정했다.',collectedAt=datetime.now(timezone.utc).isoformat())
    def candidate(self, guessed=False):
        self.pipeline.append([self.message(guessed=guessed)],True); self.pipeline.process()
        return self.pipeline.candidates()[0]['id']
    def test_dedup_edit_approval_freeze_and_team_scope(self):
        identifier=self.candidate()
        recent=self.pipeline.status()['recent']; self.assertEqual(recent[0]['cardIds'],[identifier]); self.assertEqual(recent[0]['trigger'],'flush')
        self.assertEqual(self.pipeline.append([self.message()],True)['newMessages'],0)
        self.pipeline.update(identifier,dict(content='승인 문구'))
        self.assertEqual(self.pipeline.candidates()[0]['content'],'승인 문구')
        self.pipeline.rpc('candidates.approve',dict(ids=[identifier],teamId='a'))
        self.assertEqual(self.pipeline.candidates()[0]['deliveryState'],'pending')
        with self.assertRaises(ValueError): self.pipeline.update(identifier,dict(content='바꾸기'))
        self.pipeline.configure(dict(teamId='b')); self.assertEqual(self.pipeline.candidates(),[])
        with connect(self.db) as c:
            self.assertEqual(c.execute('SELECT team_id FROM outbox_destinations').fetchone()[0],'a')
            self.assertNotIn('messageId',c.execute('SELECT payload FROM outbox').fetchone()[0])
    def test_guessed_role_and_grounded_quote(self):
        identifier=self.candidate(True)
        with self.assertRaisesRegex(ValueError,'화자'): self.pipeline.rpc('candidates.approve',dict(ids=[identifier],teamId='a'))
        with self.assertRaises(ValueError): self.pipeline.update(identifier,dict(sentence='없는 문장'))
        self.pipeline.update(identifier,dict(confirmedRole='user',sentence='SQLite'))
        self.pipeline.rpc('candidates.approve',dict(ids=[identifier],teamId='a'))
    def test_failure_preserved_and_retry(self):
        self.ai.fail=True; self.pipeline.append([self.message()],True); self.pipeline.process()
        failures=self.pipeline.status()['failedJobs']; self.assertEqual(len(failures),1)
        self.assertFalse(self.pipeline.candidates()); self.ai.fail=False
        self.pipeline.rpc('jobs.retry',dict(id=failures[0]['id'])); self.pipeline.process()
        self.assertEqual(len(self.pipeline.candidates()),1)
    def test_invented_evidence_fails(self):
        self.ai.invented=True; self.pipeline.append([self.message()],True); self.pipeline.process()
        self.assertFalse(self.pipeline.candidates()); self.assertEqual(len(self.pipeline.status()['failedJobs']),1)
    def test_pause_blocks_append_flush_ai(self):
        self.pipeline.append([self.message()],True); self.pipeline.configure(dict(autoCollect=False)); self.pipeline.process()
        with self.assertRaises(ValueError): self.pipeline.append([self.message('two')],True)
        with self.assertRaises(ValueError): self.pipeline.rpc('collection.flush',{})
        self.assertEqual(self.ai.calls,[])
        self.pipeline.configure(dict(autoCollect=True)); self.pipeline.process(); self.assertEqual(len(self.pipeline.candidates()),1)
    def test_local_excerpts_share_a_turn(self):
        self.pipeline.configure(dict(turnsPerBatch=2))
        with connect(self.db) as c:
            for i in range(2):
                evidence=[dict(n=n,role='user',source='codex',conversationId='local',turnId=str(i),at=time.time(),text='SQLite로 결정했다.') for n in (1,2)]
                c.execute("INSERT INTO jobs VALUES(?,?,'new','')",('local'+str(i),json.dumps(evidence)))
        self.pipeline.capture_local_jobs()
        with connect(self.db) as c: self.assertEqual(c.execute('SELECT count(*) FROM job_context').fetchone()[0],1)
        self.pipeline.process(); self.assertEqual(len(self.ai.calls),1)
    def test_previous_turn_is_context(self):
        self.candidate(); self.pipeline.append([self.message('two')],True); self.pipeline.process()
        self.assertIn('[참고용]',self.ai.calls[-1]); self.assertEqual(len(self.pipeline.candidates()),2)
    def test_expiry_gap_and_framing(self):
        with connect(self.db) as c: c.execute('UPDATE settings SET end=?',(time.time()-5,))
        self.pipeline.configure(dict(endsAt=datetime.fromtimestamp(time.time()+600,timezone.utc).isoformat()))
        with connect(self.db) as c: self.assertEqual(c.execute('SELECT count(*) FROM pauses').fetchone()[0],1)
        self.assertIsNone(read_frame(io.BytesIO(b'')))
        with self.assertRaises(ValueError): read_frame(io.BytesIO(b'\x00'))
        with self.assertRaises(ValueError): read_frame(io.BytesIO(struct.pack('=I',10)+b'{}'))
    def test_two_candidates_from_one_source_and_atomic_partial_selection(self):
        original=self.ai.chat_json
        def twice(system,user):
            result=original(system,user); result['cards'].append(dict(result['cards'][0],content='추가 결정')); return result
        self.ai.chat_json=twice
        self.pipeline.append([self.message()],True); self.pipeline.process()
        cards=self.pipeline.candidates(); self.assertEqual(len(cards),2)
        self.pipeline.rpc('candidates.approve',dict(ids=[cards[0]['id']],teamId='a'))
        with connect(self.db) as c: self.assertEqual(c.execute('SELECT count(*) FROM outbox').fetchone()[0],1)
        with self.assertRaises(ValueError): self.pipeline.rpc('candidates.approve',dict(ids=[cards[1]['id'],'missing'],teamId='a'))
        with connect(self.db) as c: self.assertEqual(c.execute('SELECT count(*) FROM outbox').fetchone()[0],1)
    def test_pause_while_ai_running_does_not_commit_or_lose_job(self):
        original=self.ai.chat_json
        def paused(system,user):
            result=original(system,user); self.pipeline.configure(dict(autoCollect=False)); return result
        self.ai.chat_json=paused
        self.pipeline.append([self.message()],True); self.pipeline.process()
        self.assertFalse(self.pipeline.candidates())
        with connect(self.db) as c: self.assertEqual(c.execute("SELECT state FROM jobs WHERE id LIKE 'batch-%'").fetchone()[0],'new')
        self.ai.chat_json=original; self.pipeline.configure(dict(autoCollect=True)); self.pipeline.process()
        self.assertEqual(len(self.pipeline.candidates()),1)

    def test_team_relay_requires_target_id(self):
        sent=[]; self.pipeline.client.request=lambda *a: sent.append(a)
        for method in ('team.resolve','team.setDone','team.retryCheck'):
            for params in ({},dict(id=None),dict(id='')):
                with self.assertRaises(ValueError): self.pipeline.rpc(method,params)
        self.assertEqual(sent,[],'no remote call without a target id')

if __name__=='__main__': unittest.main(verbosity=2)
