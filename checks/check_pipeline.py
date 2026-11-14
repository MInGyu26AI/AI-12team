"""Real SQLite checks with deterministic AI; no external calls."""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
from contextlib import closing
from datetime import datetime, timezone
import http.server
import io
import json
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from batch_classification import classify_queued
from candidate_review import list_candidates, update_candidate
from collection_settings import configure
from collection_status import collection_status
from local_fixtures import PipelineFixture
from local_rpc import dispatch
from native_host import read_frame, request as native_request
from storage import connect
import turn_intake


class PipelineTest(PipelineFixture):
    def test_dedup_edit_approval_freeze_and_team_scope(self):
        identifier=self.candidate()
        recent=collection_status(self.pipeline)['recent']
        self.assertEqual(recent[0]['cardIds'],[identifier])
        self.assertEqual(recent[0]['trigger'],'flush')
        self.assertEqual(turn_intake.append(self.pipeline, [self.message()],True)['newMessages'],0)
        update_candidate(self.pipeline, identifier,dict(content='승인 문구'))
        self.assertEqual(list_candidates(self.pipeline)[0]['content'],'승인 문구')
        dispatch(self.pipeline, 'candidates.approve',dict(ids=[identifier],teamId='a'))
        self.assertEqual(list_candidates(self.pipeline)[0]['deliveryState'],'pending')
        with self.assertRaises(ValueError):
            update_candidate(self.pipeline, identifier,dict(content='바꾸기'))
        configure(self.pipeline, dict(teamId='b'))
        self.assertEqual(list_candidates(self.pipeline),[])
        with connect(self.db) as c:
            self.assertEqual(c.execute('SELECT team_id FROM outbox_destinations').fetchone()[0],'a')
            self.assertNotIn('messageId',c.execute('SELECT payload FROM outbox').fetchone()[0])

    def test_guessed_role_and_grounded_quote(self):
        identifier=self.candidate(True)
        with self.assertRaisesRegex(ValueError,'화자'):
            dispatch(self.pipeline, 'candidates.approve',dict(ids=[identifier],teamId='a'))
        with self.assertRaises(ValueError):
            update_candidate(self.pipeline, identifier,dict(sentence='없는 문장'))
        update_candidate(self.pipeline, identifier,dict(confirmedRole='user',sentence='SQLite'))
        dispatch(self.pipeline, 'candidates.approve',dict(ids=[identifier],teamId='a'))

    def test_failure_preserved_and_retry(self):
        self.ai.fail=True
        turn_intake.append(self.pipeline, [self.message()],True)
        classify_queued(self.pipeline)
        failures=collection_status(self.pipeline)['failedJobs']
        self.assertEqual(len(failures),1)
        self.assertFalse(list_candidates(self.pipeline))
        self.ai.fail=False
        dispatch(self.pipeline, 'jobs.retry',dict(id=failures[0]['id']))
        classify_queued(self.pipeline)
        self.assertEqual(len(list_candidates(self.pipeline)),1)

    def test_invented_evidence_fails(self):
        self.ai.invented=True
        turn_intake.append(self.pipeline, [self.message()],True)
        classify_queued(self.pipeline)
        self.assertFalse(list_candidates(self.pipeline))
        self.assertEqual(len(collection_status(self.pipeline)['failedJobs']),1)

    def test_pause_blocks_append_flush_ai(self):
        turn_intake.append(self.pipeline, [self.message()],True)
        configure(self.pipeline, dict(autoCollect=False))
        classify_queued(self.pipeline)
        with self.assertRaises(ValueError):
            turn_intake.append(self.pipeline, [self.message('two')],True)
        with self.assertRaises(ValueError):
            dispatch(self.pipeline, 'collection.flush',{})
        self.assertEqual(self.ai.calls,[])
        configure(self.pipeline, dict(autoCollect=True))
        classify_queued(self.pipeline)
        self.assertEqual(len(list_candidates(self.pipeline)),1)

    def test_local_excerpts_share_a_turn(self):
        configure(self.pipeline, dict(turnsPerBatch=2))
        with connect(self.db) as c:
            for i in range(2):
                evidence=[dict(n=n,role='user',source='codex',conversationId='local',turnId=str(i),at=time.time(),text='SQLite로 결정했다.') for n in (1,2)]
                c.execute("INSERT INTO jobs VALUES(?,?,'new','')",('local'+str(i),json.dumps(evidence)))
        turn_intake.capture_scanned_jobs(self.pipeline)
        with connect(self.db) as c:
            self.assertEqual(c.execute('SELECT count(*) FROM job_context').fetchone()[0],1)
        classify_queued(self.pipeline)
        self.assertEqual(len(self.ai.calls),1)

    def test_previous_turn_is_context(self):
        self.candidate()
        turn_intake.append(self.pipeline, [self.message('two')],True)
        classify_queued(self.pipeline)
        self.assertIn('[참고용]',self.ai.calls[-1])
        self.assertEqual(len(list_candidates(self.pipeline)),2)

    def test_expiry_gap_is_recorded_as_a_pause(self):
        with connect(self.db) as c:
            c.execute('UPDATE settings SET end=?',(time.time()-5,))
        configure(self.pipeline, dict(endsAt=datetime.fromtimestamp(time.time()+600,timezone.utc).isoformat()))
        with connect(self.db) as c:
            self.assertEqual(c.execute('SELECT count(*) FROM pauses').fetchone()[0],1)

    def test_native_frame_rejects_short_and_truncated_input(self):
        self.assertIsNone(read_frame(io.BytesIO(b'')))
        with self.assertRaises(ValueError):
            read_frame(io.BytesIO(b'\x00'))
        with self.assertRaises(ValueError):
            read_frame(io.BytesIO(struct.pack('=I',10)+b'{}'))

    def test_two_candidates_from_one_source_and_atomic_partial_selection(self):
        original=self.ai.chat_json
        def twice(system,user):
            result=original(system,user)
            result['cards'].append(dict(result['cards'][0],content='추가 결정'))
            return result
        self.ai.chat_json=twice
        turn_intake.append(self.pipeline, [self.message()],True)
        classify_queued(self.pipeline)
        cards=list_candidates(self.pipeline)
        self.assertEqual(len(cards),2)
        dispatch(self.pipeline, 'candidates.approve',dict(ids=[cards[0]['id']],teamId='a'))
        with connect(self.db) as c:
            self.assertEqual(c.execute('SELECT count(*) FROM outbox').fetchone()[0],1)
        with self.assertRaises(ValueError):
            dispatch(self.pipeline, 'candidates.approve',dict(ids=[cards[1]['id'],'missing'],teamId='a'))
        with connect(self.db) as c:
            self.assertEqual(c.execute('SELECT count(*) FROM outbox').fetchone()[0],1)

    def test_pause_while_ai_running_does_not_commit_or_lose_job(self):
        original=self.ai.chat_json
        def paused(system,user):
            result=original(system,user)
            configure(self.pipeline, dict(autoCollect=False))
            return result
        self.ai.chat_json=paused
        turn_intake.append(self.pipeline, [self.message()],True)
        classify_queued(self.pipeline)
        self.assertFalse(list_candidates(self.pipeline))
        with connect(self.db) as c:
            self.assertEqual(c.execute("SELECT state FROM jobs WHERE id LIKE 'batch-%'").fetchone()[0],'new')
        self.ai.chat_json=original
        configure(self.pipeline, dict(autoCollect=True))
        classify_queued(self.pipeline)
        self.assertEqual(len(list_candidates(self.pipeline)),1)

    def test_team_relay_needs_a_bound_team(self):
        sent=[]
        self.pipeline.client.request=lambda *a: sent.append(a)
        with connect(self.db) as c:
            c.execute('UPDATE sharing SET team_id=NULL')
        with self.assertRaisesRegex(ValueError,'팀을 먼저 선택'):
            dispatch(self.pipeline,'team.board',{})
        self.assertEqual(sent,[])

    def test_write_holds_the_pipeline_lock_and_the_database_write_lock(self):
        def lock_free():
            result=[]
            def probe():
                acquired=self.pipeline.lock.acquire(blocking=False)
                result.append(acquired)
                if acquired:
                    self.pipeline.lock.release()
            worker=threading.Thread(target=probe)
            worker.start()
            worker.join()
            return result[0]
        with self.pipeline.write():
            self.assertFalse(lock_free(),'another thread must wait for pipeline.lock')
            # closing(): a connection's own `with` does not close it, and Windows cannot delete a file left open.
            with closing(sqlite3.connect(self.db,timeout=0)) as other, self.assertRaises(sqlite3.OperationalError):
                other.execute('BEGIN IMMEDIATE')
        self.assertTrue(lock_free())

    def test_team_relay_requires_target_id(self):
        sent=[]
        self.pipeline.client.request=lambda *a: sent.append(a)
        for method in ('team.resolve','team.setDone','team.retryCheck'):
            for params in ({},dict(id=None),dict(id='')):
                with self.assertRaises(ValueError):
                    dispatch(self.pipeline, method,params)
        self.assertEqual(sent,[],'no remote call without a target id')

class NativeHostConnection(unittest.TestCase):
    """native_host reads connection.json as strictly as the web bridge (web/src/app/api/local/route.ts)."""

    def setUp(self):
        temp=tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.folder=Path(temp.name)

        class Local(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args):
                pass

            def do_POST(self):
                redirect=self.path=='/rpc' and self.server.redirect
                body=json.dumps(dict(redirected=True) if redirect else dict(ok=True,path=self.path)).encode()
                self.send_response(302 if redirect else 200)
                if redirect:
                    self.send_header('Location','/followed')
                self.send_header('Content-Length',str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server=http.server.HTTPServer(('127.0.0.1',0),Local)
        self.server.redirect=False
        threading.Thread(target=self.server.serve_forever,daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def connection(self,name='connection',mode=0o600,**changes):
        path=self.folder/f'{name}.json'
        config=dict(url=f'http://127.0.0.1:{self.server.server_port}/rpc',token='t'*43)
        path.write_text(json.dumps(dict(config,**changes)))
        path.chmod(mode)
        if sys.platform=='win32' and mode&0o077:
            # Windows ignores the mode bits; let the Users group read, as group or other permission does on POSIX.
            subprocess.run(['icacls',str(path),'/grant','*S-1-5-32-545:(R)'],check=True,capture_output=True)
        return path

    def test_a_private_connection_file_reaches_the_service(self):
        self.assertEqual(native_request(self.connection(),{}),dict(ok=True,path='/rpc'))

    def test_unsafe_connection_files_are_refused(self):
        link=self.folder/'link.json'
        link.symlink_to(self.connection())
        cases=dict(link=link,group_readable=self.connection('group',0o640),bad_token=self.connection('token',token='short'),
                   remote_url=self.connection('remote',url='http://10.0.0.1:1/rpc'),
                   oversized=self.connection('large',padding='x'*5000))
        for name,path in cases.items():
            with self.subTest(case=name), self.assertRaises((OSError,ValueError)):
                native_request(path,{})

    def test_redirects_are_not_followed(self):
        self.server.redirect=True
        self.assertEqual(native_request(self.connection(),{}),dict(redirected=True))


if __name__=='__main__':
    unittest.main(verbosity=2)
