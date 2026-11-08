"""Integrated HTTP, native transport, SQLite and real PostgreSQL checks."""
import json
import secrets
import time
import unittest
from check_local_privacy import work_gate
import subprocess
import struct
import http.server
from unittest.mock import patch
import psycopg
from check_teams import TeamIsolation, request, running_server
from check_pipeline import AI
from check_integration_store import public_card
from integration import Pipeline
from native_host import request as native_request
from storage import connect
from team_records import process_checks
from team_server import authorized
from prepare_native import prepare
import app


def checked(req, conflicts=None):
    return dict(ok=True, checkStatus='complete', conflicts=conflicts or [],
                results=[dict(cardId=req['newCards'][0]['id'], judgements=[
                    dict(id=c['id'], judgement='무관', confidence=.9, method='chat') for c in req['existing']])])


class TeamIntegration(TeamIsolation):
    def publish_card(self, identifier, text, tag='decision', topic='DB'):
        card=public_card(text); card.update(content=text,tag=tag,topic_key=topic)
        packet=dict(id=identifier,label='할 일' if tag=='todo' else '결정',text=text,quote=text,speaker='사용자',version=2,card=card)
        status,body=request(self.api,'POST',self.path('A'),self.tokens['Dana'],dict(packet=packet,approved_by=self.users['Dana'],approved_at=time.time()))
        self.assertEqual(status,200,body)
    def team_request(self, method, suffix, data=None, user='Dana'):
        status,body=request(self.api,method,'/teams/'+self.teams['A']+'/'+suffix,self.tokens[user],data)
        return status,json.loads(body)
    def check_pair(self, pair='pair', judgement='변경'):
        def engine(req):
            new=req['newCards'][0]; old=[c for c in req['existing'] if c['tag']=='decision']
            return checked(req, [] if not old else [dict(id=pair,topic_key='DB',cardA=old[0],cardB=new,judgement=judgement,reason='가상 판정',confidence=.9,method='chat')])
        self.api.conflict_engine=engine; process_checks(self.api,self.tokens['Dana'],self.teams['A'])
    def test_change_yes_discuss_and_history(self):
        self.publish_card('old','SQLite로 결정했다.'); self.publish_card('new','PostgreSQL로 변경했다.'); self.check_pair()
        self.assertEqual(len(self.team_request('GET','conflicts')[1]['conflicts']),1)
        self.assertEqual(self.team_request('POST','conflicts/pair/resolve',dict(resolution='discuss'))[0],200)
        self.assertEqual(len(self.team_request('GET','conflicts')[1]['conflicts']),1)
        self.assertEqual(self.team_request('POST','conflicts/pair/resolve',dict(resolution='adopt-new',resolutionNote='예'))[0],200)
        self.assertEqual([c['id'] for c in self.team_request('GET','board')[1]['items']],['new'])
        self.assertEqual(self.team_request('GET','history')[1]['items'][0]['decisionState'],'superseded')
        self.assertEqual([e['resolution'] for e in self.team_request('GET','conflicts/history')[1]['events']],['discuss','adopt-new'])
        self.assertEqual(self.team_request('POST','conflicts/pair/resolve',dict(resolution='keep-existing'))[0],409)
        with authorized(self.api_dsn,self.tokens['Dana'],self.teams['A']) as (c,_):
            with self.assertRaises(psycopg.errors.InsufficientPrivilege): c.execute("UPDATE syncup.conflict_events SET note='tamper'")
    def test_change_no_and_both_valid(self):
        self.publish_card('old','SQLite로 결정했다.'); self.publish_card('new','PostgreSQL로 변경했다.'); self.check_pair()
        self.assertEqual(self.team_request('POST','conflicts/pair/resolve',dict(resolution='keep-existing'))[0],200)
        self.assertEqual([c['id'] for c in self.team_request('GET','board')[1]['items']],['old'])
        self.publish_card('third','두 DB를 병행한다.'); self.check_pair('pair2','충돌')
        self.assertEqual(self.team_request('POST','conflicts/pair2/resolve',dict(resolution='both-valid'))[0],200)
        self.assertEqual(len(self.team_request('GET','board')[1]['items']),2)
        self.assertFalse(self.team_request('GET','conflicts')[1]['conflicts'])
    def test_failure_retry_other_team_and_todo(self):
        self.publish_card('one','SQLite로 결정했다.'); self.api.conflict_engine=lambda req:dict(ok=False)
        process_checks(self.api,self.tokens['Dana'],self.teams['A'])
        self.assertEqual(self.team_request('GET','board')[1]['items'][0]['conflictCheckStatus'],'failed')
        for suffix in ('board','history','conflicts','conflicts/history','todos/done'):
            self.assertEqual(self.team_request('GET',suffix,user='Bob')[0],403)
        self.assertEqual(self.team_request('POST','items/one/retry-check',{},user='Bob')[0],403)
        self.assertEqual(self.team_request('POST','items/one/retry-check',{})[0],200)
        self.api.conflict_engine=checked
        process_checks(self.api,self.tokens['Dana'],self.teams['A'])
        self.assertEqual(self.team_request('GET','board')[1]['items'][0]['conflictCheckStatus'],'complete')
        self.publish_card('todo','내일까지 발표를 준비한다.','todo')
        self.assertEqual(self.team_request('POST','items/todo/done',dict(done=True))[0],200)
        self.assertEqual(self.team_request('GET','todos/done')[1]['ids'],['todo'])
    def test_decisions_batches_failure_retry_and_team_boundary(self):
        from ai.syncup_ai.llm import DecisionsClient
        calls=[]
        fail_second=[True]
        class Model(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append((self.path,body))
                answers=[] if fail_second[0] and len(calls)==2 else [dict(
                    name=q['name'],type='choice',choice='충돌' if 'CROSS_KEY_TARGET' in body['input'] else '무관',confidence=.9
                ) for q in body['questions']]
                data=json.dumps(dict(answers=answers)).encode()
                self.send_response(200); self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
        model=self.enterContext(running_server(Model))
        for i in range(3): self.publish_card('old'+str(i),'NEIGHBOR_'+str(i))
        self.publish_card('alias','CROSS_KEY_TARGET',topic='다른 이름')
        self.publish_card('inactive','INACTIVE_SENTINEL')
        self.publish_card('todo','TODO_SENTINEL',tag='todo')
        # A valid approved decision in another team must never enter the model input.
        card=public_card('OTHER_TEAM_SENTINEL')
        packet=dict(id='other-team',label='결정',text=card['content'],quote=card['sentence'],speaker='사용자',version=2,card=card)
        status,body=request(self.api,'POST',self.path('B'),self.tokens['Bob'],
                            dict(packet=packet,approved_by=self.users['Bob'],approved_at=time.time()))
        self.assertEqual(status,200,body)
        with authorized(self.api_dsn,self.tokens['Dana'],self.teams['A']) as (c,_):
            c.execute("UPDATE syncup.record_states SET state='superseded' WHERE team_id=%s AND card_id='inactive'",(self.teams['A'],))
            c.execute("UPDATE syncup.conflict_checks SET state='complete' WHERE team_id=%s",(self.teams['A'],))
        self.publish_card('new','NEW_DECISION')
        with patch('team_records.from_env',return_value=None), patch('team_records.decider_from_env',
                return_value=DecisionsClient(f'http://127.0.0.1:{model.server_port}/v1','synthetic-key')):
            process_checks(self.api,self.tokens['Dana'],self.teams['A'])
            self.assertEqual(len(calls),2)
            self.assertFalse(self.team_request('GET','conflicts')[1]['conflicts'])
            board=self.team_request('GET','board')[1]['items']
            self.assertEqual(next(c for c in board if c['id']=='new')['conflictCheckStatus'],'failed')
            self.assertEqual(self.team_request('POST','items/new/retry-check',{})[0],200)
            fail_second[0]=False; calls.clear()
            process_checks(self.api,self.tokens['Dana'],self.teams['A'])
        self.assertEqual([len(body['questions']) for _,body in calls],[1,1,1])  # First pair was committed before failure.
        self.assertTrue(all(path=='/v1/decisions' for path,_ in calls))
        prompts='\n'.join(body['input'] for _,body in calls)
        for marker in ('OTHER_TEAM_SENTINEL','INACTIVE_SENTINEL','TODO_SENTINEL', 'UNAPPROVED_PRIVATE_SENTINEL_739'):
            self.assertNotIn(marker,prompts)
        self.assertIn('CROSS_KEY_TARGET',calls[-1][1]['input'])
        board=self.team_request('GET','board')[1]['items']
        self.assertEqual(next(c for c in board if c['id']=='new')['conflictCheckStatus'],'complete')
        found=self.team_request('GET','conflicts')[1]['conflicts']
        self.assertEqual(len(found),1)
        self.assertEqual((found[0]['cardA']['id'],found[0]['cardB']['id'],found[0]['method']),('alias','new','decisions'))
    def test_uncertain_check_stays_failed_until_explicit_retry(self):
        from ai.syncup_ai.llm import DecisionsClient
        calls=[]
        confidence=[.4]
        class Model(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append(body)
                data=json.dumps(dict(answers=[dict(name=q['name'],type='choice',choice='무관',
                    confidence=confidence[0]) for q in body['questions']])).encode()
                self.send_response(200); self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
        model=self.enterContext(running_server(Model))
        self.publish_card('old','기존 결정')
        with authorized(self.api_dsn,self.tokens['Dana'],self.teams['A']) as (c,_):
            c.execute("UPDATE syncup.conflict_checks SET state='complete' WHERE team_id=%s",(self.teams['A'],))
        self.publish_card('new','새 결정')
        with patch('team_records.from_env',return_value=None), patch('team_records.decider_from_env',
                return_value=DecisionsClient(f'http://127.0.0.1:{model.server_port}/v1','synthetic-key')):
            process_checks(self.api,self.tokens['Dana'],self.teams['A'])
            self.assertEqual([len(b['questions']) for b in calls],[1])
            board=self.team_request('GET','board')[1]['items']
            item=next(c for c in board if c['id']=='new')
            self.assertEqual(item['conflictCheckStatus'],'failed')
            self.assertIn('확인 필요',item['conflictCheckDetail'])
            self.assertIn('확신도 부족',item['conflictCheckDetail'])
            self.assertFalse(self.team_request('GET','conflicts')[1]['conflicts'])
            with authorized(self.api_dsn,self.tokens['Dana'],self.teams['A']) as (c,_):
                c.execute("UPDATE syncup.conflict_checks SET next_attempt=now()-interval '1 minute' WHERE card_id='new'")
            process_checks(self.api,self.tokens['Dana'],self.teams['A'])
            self.assertEqual(len(calls),1)
            confidence[0]=.9
            self.assertEqual(self.team_request('POST','items/new/retry-check',{})[0],200)
            process_checks(self.api,self.tokens['Dana'],self.teams['A'])
        board=self.team_request('GET','board')[1]['items']
        self.assertEqual(next(c for c in board if c['id']=='new')['conflictCheckStatus'],'complete')
        self.assertEqual(len(calls),2)

    def test_actual_transport_retry_waits_and_stops_at_three_attempts(self):
        from ai.syncup_ai.llm import DecisionsClient
        calls=[]; available=[False]
        class Model(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append(body)
                data=json.dumps(dict(answers=[dict(name=q['name'],type='choice',choice='충돌',confidence=.9)
                    for q in body['questions']]) if available[0] else dict(error='temporary')).encode()
                self.send_response(200 if available[0] else 503)
                self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
        model=self.enterContext(running_server(Model))
        self.publish_card('old','기존 결정')
        with authorized(self.api_dsn,self.tokens['Dana'],self.teams['A']) as (c,_):
            c.execute("UPDATE syncup.conflict_checks SET state='complete' WHERE team_id=%s",(self.teams['A'],))
        self.publish_card('new','새 결정')
        with patch('team_records.from_env',return_value=None), patch('team_records.decider_from_env',
                return_value=DecisionsClient(f'http://127.0.0.1:{model.server_port}/v1','synthetic-key')):
            for attempt in range(1,4):
                process_checks(self.api,self.tokens['Dana'],self.teams['A'])
                self.assertEqual(len(calls),attempt)
                with authorized(self.api_dsn,self.tokens['Dana'],self.teams['A']) as (c,_):
                    row=c.execute("SELECT state,attempts,next_attempt>now() AS waiting FROM syncup.conflict_checks WHERE card_id='new'").fetchone()
                self.assertEqual(row['attempts'],attempt)
                self.assertEqual(row['state'],'pending' if attempt<3 else 'failed')
                self.assertTrue(row['waiting'])
                process_checks(self.api,self.tokens['Dana'],self.teams['A'])
                self.assertEqual(len(calls),attempt)
                with authorized(self.api_dsn,self.tokens['Dana'],self.teams['A']) as (c,_):
                    c.execute("UPDATE syncup.conflict_checks SET next_attempt=now()-interval '1 second' WHERE card_id='new'")
            process_checks(self.api,self.tokens['Dana'],self.teams['A'])
            self.assertEqual(len(calls),3)
            self.assertFalse(self.team_request('GET','conflicts')[1]['conflicts'])
            self.assertEqual(self.team_request('POST','items/new/retry-check',{},user='Bob')[0],403)
            self.assertEqual(self.team_request('POST','items/new/retry-check',{})[0],200)
            available[0]=True
            process_checks(self.api,self.tokens['Dana'],self.teams['A'])
            self.assertEqual(len(calls),4)
            item=next(c for c in self.team_request('GET','board')[1]['items'] if c['id']=='new')
            self.assertEqual(item['conflictCheckStatus'],'complete')
            self.assertEqual(item['conflictCheckDetail'],'')
            self.assertEqual(len(self.team_request('GET','conflicts')[1]['conflicts']),1)
            self.publish_card('recovered','통신 복구 후 결정')
            available[0]=False
            process_checks(self.api,self.tokens['Dana'],self.teams['A'])
            with authorized(self.api_dsn,self.tokens['Dana'],self.teams['A']) as (c,_):
                c.execute("UPDATE syncup.conflict_checks SET next_attempt=now()-interval '1 second' WHERE card_id='recovered'")
            available[0]=True
            process_checks(self.api,self.tokens['Dana'],self.teams['A'])
            with authorized(self.api_dsn,self.tokens['Dana'],self.teams['A']) as (c,_):
                row=c.execute("SELECT state,attempts FROM syncup.conflict_checks WHERE card_id='recovered'").fetchone()
                # Retry budget resets after each committed pair; the review-state decision also participates.
                self.assertEqual((row['state'],row['attempts']),('complete',1))
            item=next(c for c in self.team_request('GET','board')[1]['items'] if c['id']=='recovered')
            self.assertEqual(item['conflictCheckProgress'],dict(total=2,completed=2,skipped=0))

    def test_unknown_interruption_and_legacy_failure_require_manual_retry(self):
        self.publish_card('interrupted','중단된 결정')
        self.publish_card('legacy','이전 버전 실패')
        with authorized(self.api_dsn,self.tokens['Dana'],self.teams['A']) as (c,_):
            c.execute("UPDATE syncup.conflict_checks SET state='running',attempts=1,next_attempt=now()-interval '1 minute' WHERE card_id='interrupted'")
            c.execute("UPDATE syncup.conflict_checks SET state='failed',attempts=1,next_attempt=now()-interval '1 minute' WHERE card_id='legacy'")
        with patch('team_records.check_conflicts') as engine:
            process_checks(self.api,self.tokens['Dana'],self.teams['A'])
            engine.assert_not_called()
        items=self.team_request('GET','board')[1]['items']
        self.assertTrue(all(c['conflictCheckStatus']=='failed' for c in items))
        self.assertEqual(len(items),2)
        self.assertEqual(self.team_request('POST','items/interrupted/retry-check',{})[0],200)

    def test_actual_permanent_and_invalid_responses_never_auto_retry(self):
        from ai.syncup_ai.llm import DecisionsClient
        calls=[]; mode=[401]
        class Model(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                calls.append(self.rfile.read(int(self.headers['Content-Length'])))
                data=b'not-json' if mode[0]=='json' else b'{}'
                self.send_response(mode[0] if isinstance(mode[0],int) else 200)
                self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
        model=self.enterContext(running_server(Model))
        self.publish_card('old','기존 결정')
        with authorized(self.api_dsn,self.tokens['Dana'],self.teams['A']) as (c,_):
            c.execute("UPDATE syncup.conflict_checks SET state='complete' WHERE team_id=%s",(self.teams['A'],))
        with patch('team_records.from_env',return_value=None), patch('team_records.decider_from_env',
                return_value=DecisionsClient(f'http://127.0.0.1:{model.server_port}/v1','synthetic-key')):
            for i,value in enumerate([400,401,403,422,'json','missing']):
                mode[0]=value; identifier='invalid-'+str(i)
                self.publish_card(identifier,'새 결정')
                process_checks(self.api,self.tokens['Dana'],self.teams['A'])
                self.assertEqual(len(calls),i+1)
                with authorized(self.api_dsn,self.tokens['Dana'],self.teams['A']) as (c,_):
                    row=c.execute('SELECT state,attempts FROM syncup.conflict_checks WHERE card_id=%s',(identifier,)).fetchone()
                    self.assertEqual((row['state'],row['attempts']),('failed',1))
                    c.execute("UPDATE syncup.conflict_checks SET next_attempt=now()-interval '1 minute'")
                process_checks(self.api,self.tokens['Dana'],self.teams['A'])
                self.assertEqual(len(calls),i+1)
        self.assertFalse(self.team_request('GET','conflicts')[1]['conflicts'])
    def test_native_http_approval_delivery(self):
        with connect(self.db) as c: c.execute('UPDATE settings SET end=?',(time.time()+600,))
        pipeline=Pipeline(self.db,self.client); pipeline.llm_factory=lambda:AI(); pipeline.decider_factory=lambda:None; pipeline.privacy=work_gate()
        pipeline.configure(dict(projectTopic='가상 통합 검사'))
        srv=self.enterContext(running_server(app.Review)); srv.db=self.db; srv.pipeline=pipeline; srv.rpc_secret=secrets.token_urlsafe(32)
        connection=self.state/'connection.json'; connection.write_text(json.dumps(dict(url=f'http://127.0.0.1:{srv.server_port}/rpc',token=srv.rpc_secret))); connection.chmod(0o600)
        def rpc(method,params=None):
            result=native_request(connection,dict(version=1,method=method,params=params or {})); self.assertTrue(result['ok'],result); return result['result']
        manifest=prepare('a'*32,connection,self.state/'native')
        registration=json.loads(manifest.read_text())
        self.assertEqual(registration['allowed_origins'],['chrome-extension://'+'a'*32+'/'])
        frame=json.dumps(dict(version=1,method='collection.status',params={})).encode()
        result=subprocess.run([registration['path'],registration['allowed_origins'][0]],input=struct.pack('=I',len(frame))+frame,capture_output=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(struct.unpack('=I',result.stdout[:4])[0],len(result.stdout)-4)
        self.assertTrue(json.loads(result.stdout[4:])['ok'])
        result=subprocess.run([registration['path'],'chrome-extension://'+'b'*32+'/'],input=b'',capture_output=True,timeout=5)
        self.assertNotEqual(result.returncode,0)
        msg=dict(id='m1',conversationId='manual',site='manual',role='user',text='SQLite로 결정했다.',collectedAt='2026-11-08T00:00:00+09:00')
        rpc('turns.append',dict(messages=[msg],flush=True)); pipeline.process()
        card=rpc('candidates.list')['cards'][0]
        rpc('candidates.update',dict(id=card['id'],patch=dict(content='검토 후 승인 문구')))
        rpc('candidates.approve',dict(ids=[card['id']],teamId=self.teams['A'])); self.assertTrue(self.deliver())
        board=rpc('team.board')['items']; self.assertEqual(board[0]['content'],'검토 후 승인 문구')
        self.assertFalse(rpc('candidates.list')['cards']); self.assertNotIn('messageId',json.dumps(board))
        self.assertEqual(request(srv,'POST','/rpc',data=dict(version=1,method='collection.status',params={}))[0],403)

if __name__=='__main__': unittest.main(defaultTest='TeamIntegration',verbosity=2)
