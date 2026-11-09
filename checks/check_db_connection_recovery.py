"""Real PostgreSQL connection timeout and idempotent recovery, synthetic DB only."""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import subprocess
import time
import unittest

from check_teams import TeamIsolation, own_tests, request


class DBConnectionRecovery(TeamIsolation):
    def test_paused_database_returns_503_then_recovers_without_duplicate(self):
        envelope = dict(packet=self.packet('db-recovery'), approved_by=self.users['Dana'],
                        approved_at=time.time())
        subprocess.run(['docker', 'pause', self.container], check=True, stdout=subprocess.DEVNULL)
        try:
            started = time.monotonic()
            status, _ = request(self.api, 'POST', self.path('A'), self.tokens['Dana'], envelope)
            self.assertEqual(status, 503)
            self.assertLess(time.monotonic()-started, 8)
        finally:
            subprocess.run(['docker', 'unpause', self.container], check=True, stdout=subprocess.DEVNULL)
        for _ in range(2):
            status, _ = request(self.api, 'POST', self.path('A'), self.tokens['Dana'], envelope)
            self.assertEqual(status, 200)
        self.assertEqual(len(self.client.items(self.teams['A'])), 1)


def load_tests(loader, tests, pattern):
    return own_tests(DBConnectionRecovery)


if __name__ == '__main__':
    unittest.main(verbosity=2)
