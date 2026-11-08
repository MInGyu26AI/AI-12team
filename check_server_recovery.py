"""Real HTTP/PostgreSQL recovery plus the existing team isolation/integration suite."""
import json
import os
import socket
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

import check_team_integration
from check_teams import request, running_server
from team_records import process_checks
from team_server import authorized
from storage import connect
import app


class ServerRecovery(check_team_integration.TeamIntegration):
    def test_slow_body_does_not_hold_team_transaction(self):
        from check_teams import ObservedTeamHandler
        entered = threading.Event()
        original = ObservedTeamHandler.body
        def observed(handler, limit=65536):
            entered.set()
            return original(handler, limit)
        with patch.object(ObservedTeamHandler, 'body', observed):
            with socket.create_connection(('127.0.0.1', self.api.server_port), timeout=3) as slow:
                slow.sendall((f'POST {self.path("A")} HTTP/1.1\r\nHost: 127.0.0.1:{self.api.server_port}\r\n'
                    f'Authorization: Bearer {self.tokens["Dana"]}\r\nContent-Length: 100\r\n\r\n').encode())
                self.assertTrue(entered.wait(2))
                started = time.monotonic()
                self.assertEqual(self.publish('Dana','A','fast')[0], 200)
                self.assertLess(time.monotonic()-started, 2)
                slow.sendall(b'{}' + b' '*98)
                self.assertIn(b'400', slow.recv(1024))

    def test_expired_fifth_attempt_recovers_and_retries(self):
        self.publish_card('last', 'SQLite로 결정했다.')
        with authorized(self.api_dsn, self.tokens['Dana'], self.teams['A']) as (c,_):
            c.execute("UPDATE syncup.conflict_checks SET state='running',attempts=5,next_attempt=now()-interval '1 second'")
        process_checks(self.api,self.tokens['Dana'],self.teams['A'])
        self.assertEqual(self.team_request('GET','board')[1]['items'][0]['conflictCheckStatus'], 'failed')
        self.assertEqual(self.team_request('POST','items/last/retry-check',{})[0], 200)
        self.api.conflict_engine = check_team_integration.checked
        process_checks(self.api,self.tokens['Dana'],self.teams['A'])
        self.assertEqual(self.team_request('GET','board')[1]['items'][0]['conflictCheckStatus'], 'complete')

    def test_late_worker_cannot_overwrite_retried_attempt_with_same_number(self):
        self.publish_card('late', 'SQLite로 결정했다.')
        entered, release = threading.Event(), threading.Event()
        errors = []
        def engine(req):
            entered.set()
            if not release.wait(10): raise TimeoutError()
            return check_team_integration.checked(req)
        self.api.conflict_engine = engine
        def run():
            try: process_checks(self.api,self.tokens['Dana'],self.teams['A'])
            except Exception as error: errors.append(type(error).__name__)
        worker = threading.Thread(target=run)
        worker.start()
        try:
            self.assertTrue(entered.wait(3))
            with authorized(self.api_dsn,self.tokens['Dana'],self.teams['A']) as (c,_):
                c.execute("UPDATE syncup.conflict_checks SET state='failed'")
            self.assertEqual(self.team_request('POST','items/late/retry-check',{})[0],200)
            with authorized(self.api_dsn,self.tokens['Dana'],self.teams['A']) as (c,_):
                c.execute("UPDATE syncup.conflict_checks SET state='running',attempts=1,next_attempt=clock_timestamp()+interval '3 minutes'")
        finally:
            release.set(); worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(self.team_request('GET','board')[1]['items'][0]['conflictCheckStatus'],'running')

    def test_legacy_approval_and_switch_network_outside_local_lock(self):
        srv = self.enterContext(running_server(app.Review))
        srv.db, srv.csrf, srv.team_client = self.db, 'csrf', self.client
        original = self.client.me
        def probe():
            with connect(self.db) as c: c.execute('BEGIN IMMEDIATE')
            return original()
        with patch.object(self.client, 'me', side_effect=probe):
            self.assertEqual(request(srv,'POST','/switch-team',data=dict(csrf='csrf',team_id=self.teams['B']),form=True)[0],303)
            self.assertEqual(request(srv,'POST','/approve',data=dict(csrf='csrf',id='missing',target_team=self.teams['B']),form=True)[0],400)

    def test_actual_app_restarts_during_team_outage(self):
        from check_teams import ObservedTeamHandler, ROOT
        from integration import Pipeline
        from native_host import request as native_request
        Pipeline(self.db,self.client,self.client.me())
        empty = self.state/'empty'; empty.mkdir()
        connection = self.state/'connection.json'
        command = [sys.executable, str(ROOT/'app.py'), 'run', '--integrated', '--port','0',
            '--state',str(self.state),'--project',str(self.state), '--team-api',self.url,
            '--team-token-file',str(self.keys['Dana']), '--team-id',self.teams['A'],
            '--codex-dir',str(empty),'--codex-sqlite-dir',str(empty),'--claude-dir',str(empty)]
        with patch.object(ObservedTeamHandler,'do_GET',lambda h:h.reply(503,'{}','application/json')):
            child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                deadline = time.monotonic()+10
                while not connection.exists() and child.poll() is None and time.monotonic()<deadline:
                    time.sleep(.05)
                self.assertTrue(connection.exists(), 'offline app did not start')
                response = native_request(connection,dict(version=1,method='collection.status',params={}))
                self.assertTrue(response['ok'])
                self.assertEqual(response['result']['teamId'],self.teams['A'])
                self.assertEqual(response['result']['state'],'ended')
            finally:
                child.terminate()
                child.communicate(timeout=5)


if __name__ == '__main__':
    unittest.main(verbosity=2)
