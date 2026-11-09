"""Real HTTP boundary checks; synthetic settings, no cloud credentials."""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import ast
import http.client
import os
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

import psycopg

from cloud_server import CloudHandler, main, settings
from team_access import DatabaseSetupError
from team_server import TeamServer

ROOT = repo_paths.REPO
IMAGE_FOLDERS = ('server', 'contract')  # what the cloud image copies
SOURCE_FOLDERS = IMAGE_FOLDERS + ('collector',)  # where an import can resolve to repository code


def module_path(name):
    """The repository file of a module (server/, contract/ or collector/); None for the standard library and packages."""
    return next((p for p in (ROOT / folder / f'{name}.py' for folder in SOURCE_FOLDERS) if p.exists()), None)


def startup_modules(name, seen=None):
    """Repository modules (server/, contract/ and collector/ files) that importing `name` loads, following module-level imports.

    Imports inside functions are left out: they belong to code paths the cloud service does not start with."""
    seen = set() if seen is None else seen
    seen.add(name)
    for node in ast.parse(module_path(name).read_text(encoding='utf-8')).body:
        if isinstance(node, ast.Import):
            imported = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            imported = [node.module]
        else:
            continue
        for module in imported:
            if module_path(module) and module not in seen:
                startup_modules(module, seen)
    return seen


def listed_modules(path, prefix):
    """Module names of server/ and contract/ .py files on the `prefix` lines of a Docker file."""
    words = [w for line in path.read_text(encoding='utf-8').splitlines() if line.startswith(prefix)
             for w in line[len(prefix):].split()]
    paths = [Path(w.removeprefix('!')) for w in words if w.endswith('.py')]
    return {p.stem for p in paths if p.parent.name in IMAGE_FOLDERS}


class CloudBoundary(unittest.TestCase):
    def setUp(self):
        self.server = TeamServer(('127.0.0.1', 0), CloudHandler)
        self.server.public_host = 'synthetic.example.com'
        self.server.dsn = 'host=invalid.example password=FAKE_DO_NOT_LOG'
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.thread.join)
        self.addCleanup(self.server.shutdown)

    def request(self, path, hosts=None):
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            c.putrequest('GET', path, skip_host=True)
            for host in hosts or [self.server.public_host]:
                c.putheader('Host', host)
            c.endheaders()
            r = c.getresponse()
            return r.status, r.read().decode()
        finally:
            c.close()

    def test_public_routes_do_not_bypass_auth_or_host_checks(self):
        self.assertEqual(self.request('/me')[0], 401)
        self.assertEqual(self.request('/me', ['evil.example.com'])[0], 400)
        self.assertEqual(self.request('/me', [self.server.public_host]*2)[0], 400)
        self.assertEqual(self.request('/me', ['healthcheck.railway.app'])[0], 400)
        self.assertEqual(self.request('/healthz?token=FAKE')[0], 404)

    def test_health_is_bounded_and_does_not_leak_connection_errors(self):
        with patch('cloud_server.psycopg.connect') as connect:
            self.assertEqual(self.request('/healthz'), (200, '{"ready": true}'))
            self.assertEqual(self.request('/healthz', ['healthcheck.railway.app'])[0], 200)
            self.assertEqual(self.request('/healthz', ['healthcheck.railway.app']*2)[0], 400)
            connect.assert_called_with(self.server.dsn, connect_timeout=3)
        with patch('cloud_server.psycopg.connect', side_effect=psycopg.OperationalError('FAKE_DO_NOT_LOG')):
            self.assertEqual(self.request('/healthz'), (503, '{"ready": false}'))

    def test_image_copies_every_module_the_service_starts_with(self):
        copied = listed_modules(ROOT/'Dockerfile.cloud', 'COPY ')
        self.assertLessEqual(startup_modules('cloud_server'), copied)
        self.assertEqual(listed_modules(ROOT/'.dockerignore', '!'), copied)

    def test_cloud_configuration_fails_closed(self):
        env = dict(SYNCUP_DATABASE_URL='host=db.example.com sslmode=verify-full',
                   RENDER_EXTERNAL_HOSTNAME='synthetic.onrender.com', PORT='10000')
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(settings()[1:], ('synthetic.onrender.com', 10000))
            for key, value in [('SYNCUP_ADMIN_DATABASE_URL','FAKE'),
                               ('SYNCUP_DATABASE_URL','host=db.example.com sslmode=require'),
                               ('SYNCUP_PUBLIC_HOST','evil.example.com/path'),('PORT','0')]:
                with patch.dict(os.environ, {key: value}):
                    with self.assertRaises(ValueError):
                        settings()

    def test_startup_names_fixed_reasons_but_never_driver_errors(self):
        verified = 'host=db.example.com sslmode=verify-full password=FAKE_DO_NOT_LOG'
        generic = 'Cloud configuration or restricted DB connection failed; credentials are not logged.'
        for dsn, db_error, message in [
                ('host=db.example.com sslmode=require', None, 'Database TLS hostname verification is required.'),
                (verified, DatabaseSetupError('migrate-integration hint'), 'migrate-integration hint'),
                (verified, psycopg.OperationalError('FAKE_DO_NOT_LOG'), generic)]:
            with self.subTest(message=message):
                env = dict(SYNCUP_DATABASE_URL=dsn, SYNCUP_PUBLIC_HOST='synthetic.example.com')
                with patch.dict(os.environ, env, clear=True), patch('cloud_server.verify_database', side_effect=db_error):
                    with self.assertRaises(SystemExit) as stop:
                        main()
                self.assertEqual(str(stop.exception), message)


if __name__ == '__main__':
    unittest.main(verbosity=2)
