"""Native frames -> authenticated local RPC -> PostgreSQL -> second team member."""
import json
import secrets
import struct
import subprocess
import time
import unittest

from batch_classification import classify_queued
from check_teams import TeamIsolation, request
from local_fixtures import AI, work_gate
from turn_pipeline import TurnPipeline
from native_host import request as native_request
from prepare_native import prepare
from storage import connect


class FunctionalHTTP(TeamIsolation):
    def test_recovery_approval_and_second_member(self):
        with connect(self.db) as c: c.execute('UPDATE settings SET end=?',(time.time()+600,))
        pipeline=TurnPipeline(self.db,self.client)
        pipeline.llm_factory=lambda:AI(); pipeline.decider_factory=lambda:None; pipeline.privacy=work_gate()
        srv=self.review()
        srv.pipeline=pipeline; srv.rpc_secret=secrets.token_urlsafe(32)
        connection=self.state/'connection.json'
        connection.write_text(json.dumps(dict(url=f'http://127.0.0.1:{srv.server_port}/rpc',token=srv.rpc_secret)))
        connection.chmod(0o600)
        manifest=prepare('a'*32,connection,self.state/'native')
        registration=json.loads(manifest.read_text())

        def frame(method,params=None,ok=True):
            payload=json.dumps(dict(version=1,method=method,params=params or {})).encode()
            completed=subprocess.run([registration['path'],registration['allowed_origins'][0]],
                input=struct.pack('=I',len(payload))+payload,capture_output=True,timeout=15)
            self.assertEqual(completed.returncode,0)
            self.assertEqual(struct.unpack('=I',completed.stdout[:4])[0],len(completed.stdout)-4)
            response=json.loads(completed.stdout[4:]); self.assertEqual(response['ok'],ok,response)
            return response.get('result')

        message=dict(id='bad',conversationId='manual',site='manual',role='unknown',
                     text='SQLite로 결정했다.',collectedAt='2026-11-08T18:00:00+09:00')
        issue=frame('turns.append',dict(messages=[message]))['intakeIssues'][0]['id']
        self.assertEqual(frame('collection.status')['counts']['intakeIssues'],1)
        status,html=request(srv,'GET','/')
        self.assertEqual(status,200)
        self.assertIn('보관한 입력 1개',html)
        frame('intake.retry',dict(id=issue,teamId=self.teams['B'],message=dict(message,role='user')),ok=False)
        frame('intake.retry',dict(id=issue,teamId=self.teams['A'],message=dict(message,role='user')))
        status,html=request(srv,'GET','/')
        self.assertEqual(status,200)
        self.assertNotIn('보관한 입력 1개',html)
        classify_queued(pipeline)
        card=frame('candidates.list')['cards'][0]
        self.assertEqual(frame('collection.status')['counts']['reviewPending'],1)
        self.assertEqual(self.client.items(self.teams['A']),[])
        frame('candidates.approve',dict(ids=[card['id']],teamId=self.teams['A']))
        self.assertEqual(frame('collection.status')['counts']['deliveryPending'],1)
        self.api.failure=403; self.deliver()
        blocked=frame('candidates.list')['cards'][0]
        self.assertEqual((blocked['deliveryState'],blocked['deliveryAttempts']),('blocked',1))
        self.assertEqual(frame('collection.status')['counts']['deliveryBlocked'],1)
        frame('delivery.retry',dict(id=card['id'],teamId=self.teams['B']),ok=False)
        frame('delivery.retry',dict(id=card['id'],teamId=self.teams['A']))
        self.api.failure=0; self.deliver()
        self.assertEqual(frame('candidates.list')['cards'],[])
        status,body=request(self.api,'GET','/teams/'+self.teams['A']+'/board',self.tokens['Alice'])
        self.assertEqual(status,200)
        self.assertEqual(json.loads(body)['items'][0]['content'],'DB = SQLite')
        self.assertNotIn('intake-retry-',body)
        self.assertNotIn('messageId',body)
        self.assertEqual(request(self.api,'GET','/teams/'+self.teams['A']+'/board',self.tokens['Bob'])[0],403)
        self.assertEqual(request(srv,'POST','/rpc',data=dict(version=1,method='collection.status',params={}))[0],403)
        frame('delivery.retry',dict(id=card['id']),ok=False)
        # Existing HTTP transport also sees the added status without a new protocol.
        response=native_request(connection,dict(version=1,method='collection.status',params={}))
        self.assertTrue(response['ok'])
        self.assertEqual(response['result']['counts']['reviewPending'],0)


if __name__=='__main__':
    unittest.main(defaultTest='FunctionalHTTP.test_recovery_approval_and_second_member',verbosity=2)
