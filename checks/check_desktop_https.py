"""Opt-in real-bundle HTTPS check: public invalid-invite lookup, then reject a self-signed server.

No real invite, login, key or Chrome registration is used. Requires openssl and network access.
python checks/check_desktop_https.py --api https://your-team-api.example
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import ssl
import struct
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--api', required=True)
    parser.add_argument('--binary', type=Path, default=ROOT / (
        'dist/desktop/SyncUp/SyncUp.exe' if sys.platform == 'win32' else 'dist/desktop/SyncUp.app/Contents/MacOS/SyncUp'))
    args = parser.parse_args()
    if not args.api.startswith('https://'):
        parser.error('The live probe requires HTTPS.')
    with tempfile.TemporaryDirectory(prefix='syncup-bundle-https-') as folder:
        root = Path(folder)
        # A missing build-host path must not be needed by the packaged application.
        env = {k: v for k, v in os.environ.items() if not k.startswith(('PYTHON', 'SYNCUP', 'OPENAI', 'SSL_CERT'))}
        env['SSL_CERT_FILE'] = str(root / 'missing-system-ca.pem')

        def native(api, method, params):
            payload = json.dumps({'version': 1, 'method': method, 'params': params}).encode()
            done = subprocess.run([str(args.binary), 'native-host', '--connection', str(root / 'state/connection.json'),
                '--extension-id', 'a' * 32, '--team-api', api, 'chrome-extension://' + 'a' * 32 + '/'],
                input=struct.pack('=I', len(payload)) + payload, capture_output=True, timeout=30, env=env)
            assert done.returncode == 0, done.stderr.decode(errors='replace')
            assert len(done.stdout) >= 4, 'No native message response'
            size = struct.unpack('=I', done.stdout[:4])[0]
            assert len(done.stdout) == size + 4, 'Invalid native framing'
            return json.loads(done.stdout[4:])

        response = native(args.api, 'setup.invite', {'code': 'x' * 24})
        assert response == {'ok': True, 'result': {'status': 'unknown_link'}}, response
        print('PASS: actual bundled native host reaches HTTPS with packaged roots (synthetic invalid invite)')

        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
            '-subj', '/CN=localhost', '-keyout', str(root/'key.pem'), '-out', str(root/'cert.pem')],
            capture_output=True, check=True)

        class RejectTest(http.server.BaseHTTPRequestHandler):
            calls = 0
            def log_message(self, *_args):
                pass
            def do_POST(self):
                type(self).calls += 1
                body = b'{"status":"unknown_link"}'
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        with http.server.ThreadingHTTPServer(('127.0.0.1', 0), RejectTest) as server:
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(root/'cert.pem', root/'key.pem')
            server.socket = context.wrap_socket(server.socket, server_side=True)
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                rejected = native(f'https://127.0.0.1:{server.server_port}', 'setup.invite', {'code': 'x' * 24})
                assert rejected.get('ok') is False, rejected
                assert RejectTest.calls == 0, 'Untrusted HTTPS reached the application handler'
            finally:
                server.shutdown()
                worker.join(timeout=5)
        print('PASS: actual bundled native host rejects self-signed HTTPS before sending application data')
        status = native(args.api, 'setup.status', {})
        assert status['result']['keyPresent'] is False, status
        print('PASS: no PC key issued or stored')


if __name__ == '__main__':
    main()
