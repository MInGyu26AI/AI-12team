"""Real PostgreSQL and HTTP relay boundary checks; only provider responses are synthetic."""
import repo_paths
import concurrent.futures
import hashlib
import json
import os
import threading
import unittest
from unittest.mock import patch

import psycopg
from psycopg.rows import dict_row
from check_teams import TeamIsolation, own_tests, request, running_server
from team_server import TeamHandler
from team_ai import TeamAI
import ai_proxy


class AIProxyTests(TeamIsolation):
    def setUp(self):
        super().setUp()
        with psycopg.connect(self.admin_dsn) as c:
            c.execute('DELETE FROM syncup.ai_calls')
        self.enterContext(patch.dict(os.environ, dict(SYNCUP_AI_PROXY_ENABLED='true',
            OPENAI_API_KEY='synthetic-provider-credential', SYNCUP_AI_USER_MINUTE='3',
            SYNCUP_AI_USER_DAY='30', SYNCUP_AI_TOTAL_MINUTE='20', SYNCUP_AI_TOTAL_DAY='200')))
        self.provider = self.enterContext(patch('ai_proxy.provider', return_value={'cards': []}))
        self.payload = dict(system='Return cards as JSON.', user='Synthetic project decision.')

    def call(self, user='Alice', team='A', data=None, server=None):
        return request(server or self.api, 'POST', '/teams/'+self.teams[team]+'/ai/chat',
                       self.tokens.get(user), self.payload if data is None else data)

    def count(self):
        with psycopg.connect(self.admin_dsn) as c:
            return c.execute('SELECT count(*) FROM syncup.ai_calls').fetchone()[0]

    def test_auth_membership_revocation_before_provider(self):
        self.assertEqual(self.call(user='absent')[0],401)
        self.assertEqual(self.call(user='Bob')[0],403)
        with psycopg.connect(self.admin_dsn) as c:
            c.execute('DELETE FROM syncup.tokens WHERE user_id=%s',(self.users['Alice'],))
        self.assertEqual(self.call()[0],401)
        self.provider.assert_not_called()
        self.assertEqual(self.count(),0)

    def test_transient_no_team_save_and_real_client(self):
        with patch('team_server.schedule') as checks, patch.object(TeamHandler,'save_team_state') as save:
            self.assertEqual(TeamAI(self.client,self.teams['A']).chat_json(**self.payload),{'cards': []})
            checks.assert_not_called()
            save.assert_not_called()
        self.assertEqual(self.count(),1)
        with psycopg.connect(self.admin_dsn) as c:
            self.assertEqual(c.execute('SELECT count(*) FROM syncup.shared_cards').fetchone()[0],0)
            self.assertEqual([r[0] for r in c.execute("SELECT column_name FROM information_schema.columns WHERE table_schema='syncup' AND table_name='ai_calls' ORDER BY ordinal_position")],['id','user_id','created_at'])

    def test_invalid_secret_disabled_and_missing_key_do_not_reserve(self):
        for data in (dict(self.payload, model='untrusted'), dict(self.payload,user='x'*32001),
                     dict(self.payload,user='sk-proj-'+'synthetic'*5)):
            self.assertEqual(self.call(data=data)[0],400)
        with patch.dict(os.environ,SYNCUP_AI_PROXY_ENABLED='false'):
            self.assertEqual(self.call()[0],503)
        with patch.dict(os.environ,OPENAI_API_KEY=''):
            self.assertEqual(self.call()[0],503)
        self.provider.assert_not_called()
        self.assertEqual(self.count(),0)

    def test_parallel_user_limit_and_server_restart(self):
        # Raise only concurrency, so every rejection is from the persistent quota.
        self.api.ai_slots = threading.BoundedSemaphore(20)
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
            codes = list(pool.map(lambda _: self.call()[0],range(10)))
        self.assertEqual(codes.count(200),3)
        self.assertEqual(codes.count(429),7)
        self.assertEqual(self.count(),3)
        with running_server(TeamHandler) as restarted:
            restarted.dsn = self.api_dsn
            self.assertEqual(self.call(server=restarted)[0],429)

    def test_global_and_daily_limits(self):
        with patch.dict(os.environ,SYNCUP_AI_TOTAL_MINUTE='1'):
            self.assertEqual(self.call()[0],200)
            self.assertEqual(self.call(user='Bob',team='B')[0],429)
        with psycopg.connect(self.admin_dsn) as c:
            c.execute("UPDATE syncup.ai_calls SET created_at=now()-interval '2 minutes'")
        with patch.dict(os.environ,SYNCUP_AI_USER_DAY='1'):
            self.assertEqual(self.call()[0],429)
            self.assertEqual(self.call(user='Bob',team='B')[0],200)
        with patch.dict(os.environ,SYNCUP_AI_TOTAL_DAY='2'):
            self.assertEqual(self.call(user='Dana')[0],429)

    def test_failure_sanitized_counted_and_slot_released(self):
        self.api.ai_slots = threading.BoundedSemaphore(1)
        self.provider.side_effect = RuntimeError('synthetic confidential provider response')
        status, body = self.call()
        self.assertEqual(status,502)
        self.assertNotIn('confidential',body)
        self.assertEqual(self.count(),1)
        self.provider.side_effect = None
        self.assertEqual(self.call()[0],200)
        self.api.ai_slots.acquire()
        self.assertEqual(self.call()[0],429)
        self.assertEqual(self.count(),2)
        self.api.ai_slots.release()

    def test_schema_reapply_and_restricted_permissions(self):
        self.assertEqual(self.call()[0],200)
        self.admin('migrate-ai')
        self.admin('migrate-ai')
        self.assertEqual(self.count(),1)
        ai_proxy.verify_enabled(self.api_dsn)
        with psycopg.connect(self.api_dsn,row_factory=dict_row) as c:
            ai_proxy.verify(c)
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                c.execute('SELECT * FROM syncup.ai_calls')
        with psycopg.connect(self.api_dsn) as c:
            with self.assertRaises(psycopg.errors.RaiseException):
                c.execute('SELECT syncup.reserve_ai_call(%s,%s,NULL,30,20,200)',
                    (hashlib.sha256(self.tokens['Alice'].encode()).hexdigest(),self.teams['A']))

    def test_decisions_route_and_invalid_questions(self):
        from ai.syncup_ai.llm import choice_q, predicate_q
        questions = [choice_q('kind','Choose label',{'decision':'Decided','todo':'Assigned'}),
                     predicate_q('related','Project related?')]
        answers = {'kind':{'value':'decision'},'related':{'value':True}}
        self.provider.return_value = answers
        self.assertEqual(TeamAI(self.client,self.teams['A']).decide('synthetic work',questions),answers)
        self.provider.assert_called_once_with('decide',dict(input='synthetic work',questions=questions))
        path = '/teams/'+self.teams['A']+'/ai/decide'
        for bad in ([],questions+[questions[0]], [{'type':'freeform','name':'x'}]):
            self.assertEqual(request(self.api,'POST',path,self.tokens['Alice'],dict(input='work',questions=bad))[0],400)
        self.assertEqual(self.count(),1)


if __name__ == '__main__':
    result = unittest.TextTestRunner(verbosity=2).run(own_tests(AIProxyTests))
    raise SystemExit(not result.wasSuccessful())
