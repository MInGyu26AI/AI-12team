"""Local queue contracts and atomic intake correction; synthetic input only."""
import threading
import unittest
from unittest.mock import patch

from check_pipeline import PipelineTest
from integration import Pipeline
from integration_store import initialize_integration
from storage import connect


class LocalFunctional(unittest.TestCase):
    setUp = PipelineTest.setUp
    message = PipelineTest.message
    candidate = PipelineTest.candidate

    def issue(self):
        return self.pipeline.append([dict(self.message(),role='invalid')])['intakeIssues'][0]['id']

    def test_status_counts_review_delivery_and_failures_separately(self):
        card = self.candidate()
        self.assertEqual(self.pipeline.status()['counts']['reviewPending'],1)
        self.pipeline.rpc('candidates.approve',dict(ids=[card],teamId='a'))
        counts = self.pipeline.status()['counts']
        self.assertEqual((counts['reviewPending'],counts['deliveryPending'],counts['deliveryBlocked']),(0,1,0))
        with connect(self.db) as c:
            c.execute("UPDATE outbox SET state='blocked',detail='팀 보드 HTTP 503',attempts=5")
        item = self.pipeline.candidates()[0]
        self.assertEqual((item['reviewState'],item['deliveryState'],item['deliveryAttempts']),('delivery','blocked',5))
        self.assertEqual(self.pipeline.status()['counts']['deliveryBlocked'],1)
        self.pipeline.rpc('delivery.retry',dict(id=card,teamId='a'))
        with self.assertRaises(ValueError): self.pipeline.rpc('delivery.retry',dict(id=card))
        self.assertEqual(self.pipeline.status()['counts']['deliveryPending'],1)
        self.pipeline.configure(dict(teamId='b'))
        self.assertEqual(sum(self.pipeline.status()['counts'].values()),0)

    def test_buffer_groups_conversations_and_sources_and_current_session(self):
        self.pipeline.configure(dict(turnsPerBatch=50))
        a=self.message('a'); a['conversationId']='one'
        b=dict(self.message('b'),conversationId='two')
        c=dict(self.message('c'),conversationId='one',role='assistant')
        d=dict(self.message('d'),conversationId='one',site='chatgpt',role='assistant')
        self.pipeline.append([a,b,c,d])
        status = self.pipeline.status()
        self.assertEqual(status['bufferedTurns'],3)
        self.assertIsNotNone(status['lastCollectedAt'])
        self.assertEqual(status['recent'],[])
        with connect(self.db) as conn: conn.execute('UPDATE settings SET start=start+1')
        self.assertEqual(self.pipeline.status()['bufferedTurns'],0)
        self.assertIsNone(self.pipeline.status()['lastCollectedAt'])
        with connect(self.db) as conn: self.assertEqual(conn.execute('SELECT count(*) FROM intake').fetchone()[0],4)

    def test_corrected_input_preserves_original_and_is_idempotent_after_restart(self):
        self.pipeline.append([self.message()])
        issue = self.pipeline.append([dict(self.message(),text='다른 원문')])['intakeIssues'][0]['id']
        with connect(self.db) as c:
            original = c.execute('SELECT message FROM intake').fetchone()[0]
            rejected = c.execute('SELECT message FROM intake_issues').fetchone()[0]
        params=dict(id=issue,teamId='a',message=self.message())
        result=self.pipeline.rpc('intake.retry',params)
        self.assertFalse(result['alreadyResolved'])
        self.assertEqual(self.pipeline.rpc('intake.issues',{})['items'],[])
        self.assertEqual(self.pipeline.status()['counts']['classificationPending'],1)
        self.assertEqual(self.pipeline.status()['bufferedTurns'],1)
        restarted=Pipeline(self.db,self.pipeline.client)
        again=restarted.rpc('intake.retry',params)
        self.assertTrue(again['alreadyResolved'])
        self.assertEqual(again['replacementId'],result['replacementId'])
        initialize_integration(self.db)
        with connect(self.db) as c:
            self.assertEqual(c.execute('SELECT message FROM intake ORDER BY rowid LIMIT 1').fetchone()[0],original)
            self.assertEqual(c.execute('SELECT message FROM intake_issues').fetchone()[0],rejected)
            self.assertEqual(c.execute('SELECT count(*) FROM intake').fetchone()[0],2)
            self.assertEqual(c.execute('SELECT count(*) FROM intake_resolutions').fetchone()[0],1)
            self.assertEqual(c.execute('SELECT count(*) FROM outbox').fetchone()[0],0)
        self.pipeline.process()
        self.assertEqual(len(self.pipeline.candidates()),1)

    def test_resolution_rejects_invalid_team_pause_and_changed_action(self):
        issue=self.issue()
        params=dict(id=issue,teamId='a',message=self.message())
        for change in (dict(teamId='b'),dict(message=dict(self.message(),role='invalid'))):
            with self.assertRaises(ValueError): self.pipeline.rpc('intake.retry',params|change)
        self.pipeline.configure(dict(teamId='b'))
        with self.assertRaises(ValueError): self.pipeline.rpc('intake.retry',params)
        self.pipeline.configure(dict(teamId='a',autoCollect=False))
        with self.assertRaises(ValueError): self.pipeline.rpc('intake.retry',params)
        self.assertEqual(self.pipeline.status()['counts']['intakeIssues'],1)
        self.pipeline.rpc('intake.dismiss',dict(id=issue,teamId='a'))
        self.assertTrue(self.pipeline.rpc('intake.dismiss',dict(id=issue,teamId='a'))['alreadyResolved'])
        with self.assertRaises(ValueError): self.pipeline.rpc('intake.retry',params)
        with connect(self.db) as c:
            self.assertEqual(c.execute('SELECT count(*) FROM intake').fetchone()[0],0)
            self.assertEqual(c.execute('SELECT count(*) FROM intake_issues').fetchone()[0],1)

    def test_resolution_rolls_back_if_queue_creation_fails(self):
        issue=self.issue()
        with patch.object(self.pipeline,'queue_batch',side_effect=RuntimeError('synthetic')):
            with self.assertRaises(RuntimeError):
                self.pipeline.rpc('intake.retry',dict(id=issue,teamId='a',message=self.message()))
        with connect(self.db) as c:
            for table in ('intake','jobs','intake_resolutions'):
                self.assertEqual(c.execute('SELECT count(*) FROM '+table).fetchone()[0],0)
        self.assertEqual(len(self.pipeline.rpc('intake.issues',{})['items']),1)

    def test_concurrent_resolution_creates_one_replacement(self):
        issue=self.issue(); results=[]; errors=[]
        def resolve():
            try: results.append(self.pipeline.rpc('intake.retry',dict(id=issue,teamId='a',message=self.message())))
            except Exception as error: errors.append(error)
        threads=[threading.Thread(target=resolve) for _ in range(2)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(errors,[])
        self.assertEqual(sorted(r['alreadyResolved'] for r in results),[False,True])

    def test_job_retry_requires_a_failed_current_team_job(self):
        self.pipeline.append([self.message()],True)
        with connect(self.db) as c: job=c.execute('SELECT id FROM jobs').fetchone()[0]
        with self.assertRaises(ValueError): self.pipeline.rpc('jobs.retry',dict(id=job))
        self.ai.fail=True; self.pipeline.process()
        self.assertEqual(self.pipeline.status()['counts']['classificationFailed'],1)
        with self.assertRaises(ValueError): self.pipeline.rpc('jobs.retry',dict(id=job,teamId='b'))
        self.pipeline.configure(dict(teamId='b'))
        with self.assertRaises(ValueError): self.pipeline.rpc('jobs.retry',dict(id=job))
        self.pipeline.configure(dict(teamId='a'))
        self.pipeline.rpc('jobs.retry',dict(id=job,teamId='a'))
        with self.assertRaises(ValueError): self.pipeline.rpc('jobs.retry',dict(id=job))
        self.ai.fail=False; self.pipeline.process()
        self.assertEqual(self.pipeline.status()['counts']['reviewPending'],1)

    def test_delivery_retry_rejects_missing_and_other_team(self):
        card=self.candidate()
        self.pipeline.rpc('candidates.approve',dict(ids=[card],teamId='a'))
        with connect(self.db) as c: c.execute("UPDATE outbox SET state='blocked'")
        for params in (dict(id='missing'),dict(id=card,teamId='b')):
            with self.assertRaises(ValueError): self.pipeline.rpc('delivery.retry',params)
        self.pipeline.configure(dict(teamId='b'))
        with self.assertRaises(ValueError): self.pipeline.rpc('delivery.retry',dict(id=card))
        with connect(self.db) as c: self.assertEqual(c.execute('SELECT state FROM outbox').fetchone()[0],'blocked')

    def test_retry_parameter_validation(self):
        with patch('integration.connect',side_effect=AssertionError('invalid retry must not reach the database')):
            for method in ('jobs.retry','delivery.retry'):
                for params in ({},dict(id={}),dict(id='x',teamId=None),dict(id='x',teamId=''),dict(id='x',teamId=False),dict(id='x',teamId=0)):
                    with self.subTest(method=method,params=params), self.assertRaises(ValueError):
                        self.pipeline.rpc(method,params)


if __name__=='__main__': unittest.main(verbosity=2)
