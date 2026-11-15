"""Real bundled Mac app, isolated PostgreSQL and simulated Supabase; no real Chrome registration."""
import repo_paths  # noqa: F401
import json
from pathlib import Path
import struct
import subprocess
import unittest

from check_onboarding import Onboarding
from check_teams import own_tests
from desktop import DesktopState
from native_host import request

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / 'dist/desktop/SyncUp.app'


class DesktopE2E(Onboarding):
    def native(self, method, params=None):
        payload = json.dumps(dict(version=1, method=method, params=params or {})).encode()
        result = subprocess.run([str(self.desktop.executable), 'native-host',
            '--connection', str(self.desktop.state/'connection.json'), '--extension-id', 'a'*32,
            '--team-api', self.api_url, 'chrome-extension://'+'a'*32+'/'],
            input=struct.pack('=I', len(payload))+payload, capture_output=True, timeout=45)
        self.assertEqual(result.returncode, 0, 'native host process failed')
        size = struct.unpack('=I', result.stdout[:4])[0]
        return json.loads(result.stdout[4:4+size])

    def test_signup_install_key_and_running_collector(self):
        signed = self.login()[1]
        status, team = self.team(signed['session'])
        self.assertEqual(status, 200)
        self.api_url = f'http://127.0.0.1:{self.api.server_port}'
        resources = self.state/'resources'
        resources.mkdir()
        (resources/'desktop-config.json').write_text(json.dumps(dict(web_url='http://localhost:3000',
            team_api=self.api_url, version='synthetic-e2e', local_demo=True)))
        self.desktop = DesktopState(resources, APP, 'Contents/MacOS/SyncUp', home=self.state/'isolated-home')
        self.addCleanup(self.desktop.stop)
        self.assertTrue(self.desktop.install('a'*32)['installed'])
        begun = self.native('setup.begin')
        self.assertTrue(begun['ok'])
        code = self.supabase.login(begun['result']['challenge'], self.identity)
        connected = self.native('setup.connect', {'code': code})
        self.assertTrue(connected['ok'], connected.get('error'))
        self.assertTrue(self.desktop.status()['key_present'])
        self.assertTrue(self.desktop.start(team['id'])['running'])
        response = request(self.desktop.state/'connection.json', dict(version=1, method='collection.status', params={}))
        self.assertTrue(response['ok'])
        self.assertFalse(response['result']['autoCollect'])
        self.assertTrue(response['result']['browserOnly'])
        connectors = self.native('connectors.list')
        self.assertTrue(connectors['ok'])
        self.assertEqual({p['site'] for p in connectors['result']['providers']}, {'notion', 'google-docs'})
        self.assertTrue(connectors['result']['setupUrl'].endswith('/connectors'))
        from collection_session import require_active
        with self.assertRaises(ValueError):
            require_active(self.desktop.state/'private.sqlite')
        self.assertTrue(self.desktop.stop()['running'] is False)


if __name__ == '__main__':
    if not APP.is_dir(): raise SystemExit('Build the Mac desktop app first.')
    result = unittest.TextTestRunner(verbosity=2).run(own_tests(DesktopE2E))
    raise SystemExit(not result.wasSuccessful())
