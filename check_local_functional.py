"""Local queue contracts and atomic intake correction; synthetic input only."""
import threading
import unittest
from unittest.mock import patch

from batch_classification import classify_queued
from candidate_review import list_candidates
from collection_settings import configure
from collection_status import collection_status
from local_fixtures import PipelineFixture
from local_rpc import dispatch
from pipeline_schema import ensure_pipeline_schema
from storage import connect
import turn_intake
from turn_pipeline import TurnPipeline


class LocalFunctional(PipelineFixture):
    def issue(self):
        return turn_intake.append(self.pipeline, [dict(self.message(),role='invalid')])['intakeIssues'][0]['id']

    def test_status_counts_review_delivery_and_failures_separately(self):
        card = self.candidate()
        self.assertEqual(collection_status(self.pipeline)['counts']['reviewPending'],1)
        dispatch(self.pipeline, 'candidates.approve',dict(ids=[card],teamId='a'))
        counts = collection_status(self.pipeline)['counts']
        self.assertEqual((counts['reviewPending'],counts['deliveryPending'],counts['deliveryBlocked']),(0,1,0))
        with connect(self.db) as c:
            c.execute("UPDATE outbox SET state='blocked',detail='팀 보드 HTTP 503',attempts=5")
        item = list_candidates(self.pipeline)[0]
        self.assertEqual((item['reviewState'],item['deliveryState'],item['deliveryAttempts']),('delivery','blocked',5))
        self.assertEqual(collection_status(self.pipeline)['counts']['deliveryBlocked'],1)
        dispatch(self.pipeline, 'delivery.retry',dict(id=card,teamId='a'))
        with self.assertRaises(ValueError):
            dispatch(self.pipeline, 'delivery.retry',dict(id=card))
        self.assertEqual(collection_status(self.pipeline)['counts']['deliveryPending'],1)
        configure(self.pipeline, dict(teamId='b'))
        self.assertEqual(sum(collection_status(self.pipeline)['counts'].values()),0)

    def test_buffer_groups_conversations_and_sources_and_current_session(self):
        configure(self.pipeline, dict(turnsPerBatch=50))
        a=self.message('a')
        a['conversationId']='one'
        b=dict(self.message('b'),conversationId='two')
        c=dict(self.message('c'),conversationId='one',role='assistant')
        d=dict(self.message('d'),conversationId='one',site='chatgpt',role='assistant')
        turn_intake.append(self.pipeline, [a,b,c,d])
        status = collection_status(self.pipeline)
        self.assertEqual(status['bufferedTurns'],3)
        self.assertIsNotNone(status['lastCollectedAt'])
        self.assertEqual(status['recent'],[])
        with connect(self.db) as conn:
            conn.execute('UPDATE settings SET start=start+1')
        self.assertEqual(collection_status(self.pipeline)['bufferedTurns'],0)
        self.assertIsNone(collection_status(self.pipeline)['lastCollectedAt'])
        with connect(self.db) as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM intake').fetchone()[0],4)

    def test_corrected_input_preserves_original_and_is_idempotent_after_restart(self):
        turn_intake.append(self.pipeline, [self.message()])
        issue = turn_intake.append(self.pipeline, [dict(self.message(),text='다른 원문')])['intakeIssues'][0]['id']
        with connect(self.db) as c:
            original = c.execute('SELECT message FROM intake').fetchone()[0]
            rejected = c.execute('SELECT message FROM intake_issues').fetchone()[0]
        params=dict(id=issue,teamId='a',message=self.message())
        result=dispatch(self.pipeline, 'intake.retry',params)
        self.assertFalse(result['alreadyResolved'])
        self.assertEqual(dispatch(self.pipeline, 'intake.issues',{})['items'],[])
        self.assertEqual(collection_status(self.pipeline)['counts']['classificationPending'],1)
        self.assertEqual(collection_status(self.pipeline)['bufferedTurns'],1)
        restarted=TurnPipeline(self.db,self.pipeline.client)
        again=dispatch(restarted, 'intake.retry',params)
        self.assertTrue(again['alreadyResolved'])
        self.assertEqual(again['replacementId'],result['replacementId'])
        ensure_pipeline_schema(self.db)
        with connect(self.db) as c:
            self.assertEqual(c.execute('SELECT message FROM intake ORDER BY rowid LIMIT 1').fetchone()[0],original)
            self.assertEqual(c.execute('SELECT message FROM intake_issues').fetchone()[0],rejected)
            self.assertEqual(c.execute('SELECT count(*) FROM intake').fetchone()[0],2)
            self.assertEqual(c.execute('SELECT count(*) FROM intake_resolutions').fetchone()[0],1)
            self.assertEqual(c.execute('SELECT count(*) FROM outbox').fetchone()[0],0)
        classify_queued(self.pipeline)
        self.assertEqual(len(list_candidates(self.pipeline)),1)

    def test_resolution_rejects_invalid_team_pause_and_changed_action(self):
        issue=self.issue()
        params=dict(id=issue,teamId='a',message=self.message())
        for change in (dict(teamId='b'),dict(message=dict(self.message(),role='invalid'))):
            with self.assertRaises(ValueError):
                dispatch(self.pipeline, 'intake.retry',params|change)
        configure(self.pipeline, dict(teamId='b'))
        with self.assertRaises(ValueError):
            dispatch(self.pipeline, 'intake.retry',params)
        configure(self.pipeline, dict(teamId='a',autoCollect=False))
        with self.assertRaises(ValueError):
            dispatch(self.pipeline, 'intake.retry',params)
        self.assertEqual(collection_status(self.pipeline)['counts']['intakeIssues'],1)
        dispatch(self.pipeline, 'intake.dismiss',dict(id=issue,teamId='a'))
        self.assertTrue(dispatch(self.pipeline, 'intake.dismiss',dict(id=issue,teamId='a'))['alreadyResolved'])
        with self.assertRaises(ValueError):
            dispatch(self.pipeline, 'intake.retry',params)
        with connect(self.db) as c:
            self.assertEqual(c.execute('SELECT count(*) FROM intake').fetchone()[0],0)
            self.assertEqual(c.execute('SELECT count(*) FROM intake_issues').fetchone()[0],1)

    def test_resolution_rolls_back_if_queue_creation_fails(self):
        issue=self.issue()
        with patch('batch_queue.queue_batch',side_effect=RuntimeError('synthetic')):
            with self.assertRaises(RuntimeError):
                dispatch(self.pipeline, 'intake.retry',dict(id=issue,teamId='a',message=self.message()))
        with connect(self.db) as c:
            for table in ('intake','jobs','intake_resolutions'):
                self.assertEqual(c.execute('SELECT count(*) FROM '+table).fetchone()[0],0)
        self.assertEqual(len(dispatch(self.pipeline, 'intake.issues',{})['items']),1)

    def test_concurrent_resolution_creates_one_replacement(self):
        issue=self.issue()
        results=[]
        errors=[]
        def resolve():
            try:
                results.append(dispatch(self.pipeline, 'intake.retry',dict(id=issue,teamId='a',message=self.message())))
            except Exception as error:
                errors.append(error)
        threads=[threading.Thread(target=resolve) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors,[])
        self.assertEqual(sorted(r['alreadyResolved'] for r in results),[False,True])

    def test_job_retry_requires_a_failed_current_team_job(self):
        turn_intake.append(self.pipeline, [self.message()],True)
        with connect(self.db) as c:
            job=c.execute('SELECT id FROM jobs').fetchone()[0]
        with self.assertRaises(ValueError):
            dispatch(self.pipeline, 'jobs.retry',dict(id=job))
        self.ai.fail=True
        classify_queued(self.pipeline)
        self.assertEqual(collection_status(self.pipeline)['counts']['classificationFailed'],1)
        with self.assertRaises(ValueError):
            dispatch(self.pipeline, 'jobs.retry',dict(id=job,teamId='b'))
        configure(self.pipeline, dict(teamId='b'))
        with self.assertRaises(ValueError):
            dispatch(self.pipeline, 'jobs.retry',dict(id=job))
        configure(self.pipeline, dict(teamId='a'))
        dispatch(self.pipeline, 'jobs.retry',dict(id=job,teamId='a'))
        with self.assertRaises(ValueError):
            dispatch(self.pipeline, 'jobs.retry',dict(id=job))
        self.ai.fail=False
        classify_queued(self.pipeline)
        self.assertEqual(collection_status(self.pipeline)['counts']['reviewPending'],1)

    def test_delivery_retry_rejects_missing_and_other_team(self):
        card=self.candidate()
        dispatch(self.pipeline, 'candidates.approve',dict(ids=[card],teamId='a'))
        with connect(self.db) as c:
            c.execute("UPDATE outbox SET state='blocked'")
        for params in (dict(id='missing'),dict(id=card,teamId='b')):
            with self.assertRaises(ValueError):
                dispatch(self.pipeline, 'delivery.retry',params)
        configure(self.pipeline, dict(teamId='b'))
        with self.assertRaises(ValueError):
            dispatch(self.pipeline, 'delivery.retry',dict(id=card))
        with connect(self.db) as c:
            self.assertEqual(c.execute('SELECT state FROM outbox').fetchone()[0],'blocked')

    def test_dismiss_requires_a_candidate_still_in_review(self):
        card=self.candidate()
        dispatch(self.pipeline,'candidates.approve',dict(ids=[card],teamId='a'))
        for params in (dict(id='missing'),dict(id=card),dict(id=None)):
            with self.subTest(params=params), self.assertRaises(ValueError):
                dispatch(self.pipeline,'candidates.dismiss',params)
        turn_intake.append(self.pipeline,[self.message('two')],True)
        classify_queued(self.pipeline)
        other=next(c['id'] for c in list_candidates(self.pipeline) if c['id']!=card)
        for _ in range(2):
            self.assertEqual(dispatch(self.pipeline,'candidates.dismiss',dict(id=other)),dict(ok=True))

    def test_retry_parameter_validation(self):
        unreachable=AssertionError('invalid retry must not reach the database')
        with patch('turn_pipeline.connect',side_effect=unreachable):
            for method in ('jobs.retry','delivery.retry'):
                for params in ({},dict(id={}),dict(id='x',teamId=None),dict(id='x',teamId=''),dict(id='x',teamId=False),dict(id='x',teamId=0)):
                    with self.subTest(method=method,params=params), self.assertRaises(ValueError):
                        dispatch(self.pipeline, method,params)


if __name__=='__main__':
    unittest.main(verbosity=2)
