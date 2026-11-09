"""Real HTTP/PostgreSQL recovery plus the existing team isolation/integration suite."""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import socket
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

import check_team_integration
from check_teams import ObservedTeamHandler, ROOT, request, running_server
from native_host import request as native_request
from review_page import Review
from storage import connect
from turn_pipeline import TurnPipeline


class ServerRecovery(check_team_integration.TeamIntegration):
    def test_slow_body_does_not_hold_team_transaction(self):
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
        # A lease taken before checkpoints existed (no progress) cannot resume and waits for a member.
        with self.team_db() as c:
            c.execute("UPDATE syncup.conflict_checks SET state='running',attempts=5,next_attempt=now()-interval '1 second'")
        self.run_due_checks()
        self.assertEqual(self.team_request('GET','board')[1]['items'][0]['conflictCheckStatus'], 'failed')
        self.assertEqual(self.team_request('POST','items/last/retry-check',{})[0], 200)
        self.api.conflict_engine = check_team_integration.checked
        self.run_due_checks()
        self.assertEqual(self.team_request('GET','board')[1]['items'][0]['conflictCheckStatus'], 'complete')

    def test_late_worker_cannot_overwrite_retried_attempt_with_same_number(self):
        self.assert_late_worker_loses_lease()

    def test_legacy_approval_and_switch_network_outside_local_lock(self):
        srv = self.enterContext(running_server(Review))
        srv.db, srv.csrf, srv.team_client = self.db, 'csrf', self.client
        original = self.client.me
        def probe():
            with connect(self.db) as c:
                c.execute('BEGIN IMMEDIATE')
            return original()
        with patch.object(self.client, 'me', side_effect=probe):
            self.assertEqual(request(srv,'POST','/switch-team',data=dict(csrf='csrf',team_id=self.teams['B']),form=True)[0],303)
            self.assertEqual(request(srv,'POST','/approve',data=dict(csrf='csrf',id='missing',target_team=self.teams['B']),form=True)[0],400)

    def test_actual_app_restarts_during_team_outage(self):
        TurnPipeline(self.db,self.client,self.client.me())
        empty = self.state/'empty'; empty.mkdir()
        connection = self.state/'connection.json'
        command = [sys.executable, str(ROOT/'collector'/'app.py'), 'run', '--integrated', '--port','0',
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
    # Runs ServerRecovery with every inherited TeamIsolation and TeamIntegration test, once.
    unittest.main(verbosity=2)
