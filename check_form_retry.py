"""Synthetic real-HTTP retry contracts; temporary SQLite, deterministic AI, no external API."""
import concurrent.futures
import http.client
from html.parser import HTMLParser
import time
import unittest
import urllib.parse

import app
from check_integrity import Integrity, server
from check_pipeline import PipelineTest
from storage import connect


class Forms(HTMLParser):
    def __init__(self, markup):
        super().__init__(); self.forms=[]; self.current=None; self.feed(markup)

    def handle_starttag(self, tag, attributes):
        attrs=dict(attributes)
        if tag == 'form':
            self.current=dict(action=attrs.get('action'), fields={}); self.forms.append(self.current)
        if tag == 'input' and self.current is not None and 'name' in attrs:
            self.current['fields'][attrs['name']]=attrs.get('value', '')

    def handle_endtag(self, tag):
        if tag == 'form': self.current=None


def request(srv, path='/', fields=None, origin=None):
    body=urllib.parse.urlencode(fields) if fields is not None else None
    headers={'Origin': origin or f'http://127.0.0.1:{srv.server_port}'}
    connection=http.client.HTTPConnection('127.0.0.1', srv.server_port, timeout=5)
    try:
        connection.request('POST' if fields is not None else 'GET', path, body, headers)
        response=connection.getresponse()
        return response.status, response.read().decode()
    finally:
        connection.close()


class IntegrationForms(unittest.TestCase):
    setUp=PipelineTest.setUp
    message=PipelineTest.message
    candidate=PipelineTest.candidate

    def review(self):
        srv=self.enterContext(server(app.Review,self.db))
        srv.pipeline=self.pipeline; srv.team_client=self.pipeline.client
        return srv

    def post(self, srv, path, **fields):
        return request(srv,path,dict(csrf=srv.csrf,**fields))[0]

    def failed(self):
        self.ai.fail=True; self.pipeline.append([self.message()],True); self.pipeline.process()
        return self.pipeline.status()['failedJobs'][0]['id']

    def blocked(self):
        card=self.candidate(); self.pipeline.rpc('candidates.approve',dict(ids=[card],teamId='a'))
        with connect(self.db) as c: c.execute("UPDATE outbox SET state='blocked',attempts=5,detail='synthetic'")
        return card

    def snapshot(self):
        with connect(self.db) as c:
            return {table:[tuple(row) for row in c.execute('SELECT * FROM '+table)]
                    for table in ('jobs','cards','outbox','outbox_destinations','job_context')}

    def test_rendered_form_carries_team_and_recovers_once(self):
        job=self.failed(); srv=self.review()
        status,markup=request(srv); self.assertEqual(status,200)
        form=next(f for f in Forms(markup).forms if f['action']=='/retry')
        self.assertEqual(form['fields']['teamId'],'a')
        self.assertEqual(form['fields']['id'],job)
        self.assertEqual(request(srv,form['action'],form['fields'])[0],303)
        self.assertEqual(request(srv,form['action'],form['fields'])[0],400)
        self.ai.fail=False; self.pipeline.process()
        self.assertEqual(len(self.pipeline.candidates()),1)
        with connect(self.db) as c: self.assertEqual(c.execute('SELECT count(*) FROM outbox').fetchone()[0],0)

    def test_stale_and_foreign_job_do_not_mutate(self):
        job=self.failed(); srv=self.review()
        for fields in ({},dict(id='missing',teamId='a'),dict(id=job),dict(id=job,teamId='b')):
            before=self.snapshot(); self.assertEqual(self.post(srv,'/retry',**fields),400)
            self.assertEqual(self.snapshot(),before)
        self.pipeline.configure(dict(teamId='b'))
        for team in ('a','b'):
            before=self.snapshot(); self.assertEqual(self.post(srv,'/retry',id=job,teamId=team),400)
            self.assertEqual(self.snapshot(),before)
        self.assertNotIn('action="/retry"',request(srv)[1])

    def test_pause_and_expiry_block_classification_retry(self):
        job=self.failed(); srv=self.review()
        self.pipeline.configure(dict(autoCollect=False))
        before=self.snapshot(); self.assertEqual(self.post(srv,'/retry',id=job,teamId='a'),400)
        self.assertEqual(self.snapshot(),before)
        with connect(self.db) as c: c.execute('UPDATE settings SET paused=0,end=?',(time.time()-1,))
        self.assertEqual(self.post(srv,'/retry',id=job,teamId='a'),400)
        self.assertEqual(self.snapshot(),before)

    def test_delivery_team_state_and_frozen_packet(self):
        card=self.blocked(); srv=self.review(); frozen=self.snapshot()
        form=next(f for f in Forms(request(srv)[1]).forms if f['action']=='/retry-delivery')
        self.assertEqual(form['fields']['teamId'],'a')
        for fields in (dict(id=card),dict(id='missing',teamId='a'),dict(id=card,teamId='b')):
            self.assertEqual(self.post(srv,'/retry-delivery',**fields),400)
            self.assertEqual(self.snapshot(),frozen)
        self.pipeline.configure(dict(teamId='b'))
        for team in ('a','b'):
            self.assertEqual(self.post(srv,'/retry-delivery',id=card,teamId=team),400)
            self.assertEqual(self.snapshot(),frozen)
        self.pipeline.configure(dict(teamId='a',autoCollect=False))
        self.assertEqual(request(srv,form['action'],form['fields'])[0],303)
        self.assertEqual(request(srv,form['action'],form['fields'])[0],400)
        after=self.snapshot()
        self.assertEqual(after['outbox_destinations'],frozen['outbox_destinations'])
        self.assertEqual(after['cards'],frozen['cards'])
        with connect(self.db) as c:
            row=c.execute('SELECT * FROM outbox').fetchone()
            self.assertEqual((row['state'],row['attempts'],row['next_attempt']),('pending',0,0))
            self.assertEqual(row['payload'],frozen['outbox'][0][1])

    def test_concurrent_form_submissions_queue_once(self):
        job=self.failed(); srv=self.review()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results=list(pool.map(lambda _:self.post(srv,'/retry',id=job,teamId='a'),range(4)))
        self.assertEqual(sorted(results),[303,400,400,400])

    def test_csrf_origin_and_ambiguous_fields_rejected(self):
        job=self.failed(); srv=self.review(); before=self.snapshot()
        valid=dict(csrf=srv.csrf,id=job,teamId='a')
        self.assertEqual(request(srv,'/retry',dict(valid,csrf='wrong'))[0],403)
        self.assertEqual(request(srv,'/retry',valid,origin='https://example.test')[0],403)
        for field in ('id','teamId'):
            self.assertEqual(request(srv,'/retry',list(valid.items())+[(field,'other')])[0],400)
            self.assertEqual(request(srv,'/retry',dict(valid,**{field:''}))[0],400)
        self.assertEqual(self.snapshot(),before)

    def test_legacy_team_delivery_without_pipeline_uses_destination_scope(self):
        card=self.blocked(); srv=self.review(); srv.pipeline=None
        frozen=self.snapshot()
        self.assertEqual(self.post(srv,'/retry-delivery',id=card),400)
        self.pipeline.configure(dict(teamId='b'))
        for team in ('a','b'):
            self.assertEqual(self.post(srv,'/retry-delivery',id=card,teamId=team),400)
            self.assertEqual(self.snapshot(),frozen)
        self.pipeline.configure(dict(teamId='a'))
        self.assertEqual(self.post(srv,'/retry-delivery',id=card,teamId='a'),303)
        self.assertEqual(self.post(srv,'/retry-delivery',id=card,teamId='a'),400)


class StandaloneForms(unittest.TestCase):
    setUp=Integrity.setUp
    card=Integrity.card
    approve=Integrity.approve
    row=Integrity.row

    def test_failed_draft_recovers_but_completed_missing_paused_do_not(self):
        self.card(manual=True)
        with connect(self.db) as c: c.execute('UPDATE settings SET end=?,paused=1',(time.time()+300,))
        srv=self.enterContext(server(app.Review,self.db))
        fields=dict(csrf=srv.csrf,id='c')
        self.assertEqual(request(srv,'/retry',fields)[0],400)
        self.assertEqual(self.row('cards')['status'],'manual')
        with connect(self.db) as c: c.execute('UPDATE settings SET paused=0')
        self.assertEqual(request(srv,'/retry',dict(fields,id='missing'))[0],400)
        self.assertEqual(request(srv,'/retry',fields)[0],303)
        self.assertEqual(self.row('jobs')['state'],'draft')
        self.assertEqual(self.row('cards')['status'],'drafting')
        self.assertEqual(request(srv,'/retry',fields)[0],400)

    def test_local_delivery_preserves_packet_and_rejects_noop(self):
        self.approve(self.card()); srv=self.enterContext(server(app.Review,self.db))
        fields=dict(csrf=srv.csrf,id='c'); frozen=self.row('outbox')['payload']
        self.assertEqual(request(srv,'/retry-delivery',fields)[0],400)
        with connect(self.db) as c: c.execute("UPDATE outbox SET state='blocked'")
        self.assertEqual(request(srv,'/retry-delivery',dict(fields,id='missing'))[0],400)
        self.assertEqual(request(srv,'/retry-delivery',fields)[0],303)
        self.assertEqual(self.row('outbox')['payload'],frozen)
        self.assertEqual(request(srv,'/retry-delivery',fields)[0],400)


if __name__=='__main__':
    unittest.main(verbosity=2)
