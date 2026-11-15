"""Installer checks in temporary homes only; never touch the user's Chrome registration or start collection."""
import repo_paths  # noqa: F401
import contextlib
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile

import desktop_setup
from desktop import SetupServer


class Registry:
    HKEY_CURRENT_USER, REG_SZ = 1, 1
    def __init__(self): self.value = 'old-manifest.json'
    @contextlib.contextmanager
    def OpenKey(self, *_): yield self
    CreateKey = OpenKey
    def QueryValueEx(self, *_): return self.value, self.REG_SZ
    def SetValueEx(self, _key, _name, _reserved, _kind, value): self.value = value


class DesktopSetup(unittest.TestCase):
    def setUp(self):
        self.tmp = self.enterContext(tempfile.TemporaryDirectory())
        self.home = Path(self.tmp)
        self.root = self.home/'SyncUp'
        self.executable = self.home/'fake-executable'
        self.executable.write_text('synthetic executable, never run')

    def test_mac_registration_preserves_old_manifest_and_exact_origin(self):
        target = self.home/'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.syncup.collector.json'
        target.parent.mkdir(parents=True)
        target.write_bytes(b'OLD CONFIG')
        result = desktop_setup.register('a'*32, self.executable, self.root, 'https://team.example.com', self.home, 'darwin')
        self.assertEqual(Path(result['backup']).read_bytes(), b'OLD CONFIG')
        manifest = json.loads(target.read_text())
        self.assertEqual(manifest['allowed_origins'], ['chrome-extension://'+'a'*32+'/'])
        launcher = Path(manifest['path']).read_text()
        self.assertIn('--team-api https://team.example.com/', launcher)
        self.assertFalse((self.root/'state/team.key').exists())

    def test_windows_registration_backs_up_previous_registry_target(self):
        registry = Registry()
        # Use UTF-8 only for the synthetic Windows launcher encoding on Mac.
        with patch('prepare_native.CMD_ENCODING', 'utf-8'):
            result = desktop_setup.register('b'*32, self.executable, self.root, 'https://team.example.com', self.home, 'win32', registry)
        self.assertEqual(json.loads(Path(result['backup']).read_text())['previous'], 'old-manifest.json')
        self.assertEqual(registry.value, result['manifest'])
        self.assertIn('syncup-native.cmd', Path(result['manifest']).read_text())

    def test_invalid_extension_or_insecure_api_never_registers(self):
        for extension, url in [('not-an-id', 'https://team.example.com'), ('a'*32,'http://127.0.0.1:8888')]:
            with self.assertRaises(ValueError):
                desktop_setup.register(extension, self.executable, self.root, url, self.home, 'darwin')
        self.assertFalse(self.root.exists())

    def test_zip_traversal_is_refused_before_extraction(self):
        archive = self.home/'bad.zip'
        with zipfile.ZipFile(archive,'w') as z:
            z.writestr('../escape','bad')
        with self.assertRaises(ValueError):
            desktop_setup.unpack_extension(archive,self.root)
        self.assertFalse(self.root.exists())
        self.assertFalse((self.home/'escape').exists())

    def test_loopback_demo_is_explicit_and_cannot_target_remote_http(self):
        config = self.home/'desktop-config.json'
        value = dict(web_url='http://localhost:3000', team_api='http://127.0.0.1:18878', version='demo')
        config.write_text(json.dumps(value))
        with self.assertRaises(ValueError): desktop_setup.read_config(self.home)
        value['local_demo'] = True
        config.write_text(json.dumps(value))
        self.assertEqual(desktop_setup.read_config(self.home)['web_url'], 'http://localhost:3000')
        value['team_api'] = 'http://example.com'
        config.write_text(json.dumps(value))
        with self.assertRaises(ValueError): desktop_setup.read_config(self.home)

    def test_runtime_copy_keeps_source_and_each_install_separate(self):
        source = self.home/'app'
        source.mkdir(); (source/'SyncUp').write_text('binary')
        first = desktop_setup.copy_runtime(source,'SyncUp',self.root)
        second = desktop_setup.copy_runtime(source,'SyncUp',self.root)
        self.assertNotEqual(first,second)
        self.assertEqual(first.read_text(), 'binary')
        self.assertTrue((source/'SyncUp').exists())


class SetupHttp(unittest.TestCase):
    def setUp(self):
        class State:
            lock = threading.Lock()
            def status(self): return {'installed':False}
            def install(self, _extension): raise AssertionError('must not run')
        self.server = SetupServer(State())
        thread = threading.Thread(target=self.server.serve_forever,daemon=True); thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def call(self, method,path,headers=None,body=None):
        c = http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5)
        try:
            c.request(method,path,body=body,headers=headers or {})
            r=c.getresponse(); return r.status,dict(r.getheaders()),r.read()
        finally: c.close()

    def test_bootstrap_is_one_use_and_credentials_not_in_status(self):
        path='/open/'+self.server.bootstrap
        status,headers,_=self.call('GET',path)
        self.assertEqual(status,303)
        self.assertIn('HttpOnly',headers['Set-Cookie'])
        cookie=headers['Set-Cookie'].split(';')[0]
        self.assertEqual(self.call('GET',path)[0],403)
        status,_,body=self.call('GET','/status',{'Cookie':cookie})
        self.assertEqual(status,200)
        self.assertNotIn(self.server.secret.encode(),body)

    def test_wrong_origin_missing_cookie_and_rebinding_host_are_rejected(self):
        cookie=self.server.cookie_name+'='+self.server.secret
        for headers in [ {'Origin':self.server.origin}, {'Cookie':cookie,'Origin':'https://evil.example'},
                         {'Cookie':cookie,'Origin':self.server.origin,'Host':'evil.example'} ]:
            self.assertEqual(self.call('POST','/install',headers,'{}')[0],403)


if __name__=='__main__': unittest.main(verbosity=2)
