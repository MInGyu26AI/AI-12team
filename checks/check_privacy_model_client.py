"""Local privacy model client: loopback-only Ollama, strict JSON answers, and policy-versioned answer caching."""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import http.server
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import local_privacy
from local_fixtures import MIXED, offline
from local_privacy import Gate
from privacy_model import (ModelError, ModelOutputError, ModelUnavailable, OllamaClassifier, UnconfiguredClassifier,
                           classifier_from_env)
from storage import connect


class LocalModelBoundary(unittest.TestCase):
    def test_only_loopback_and_local_models_are_accepted(self):
        for url in ('http://10.0.0.5:11434', 'https://127.0.0.1:11434', 'http://localhost:11434',
                    'http://127.0.0.1:11434/v1', 'http://user:pw@127.0.0.1:11434', 'http://api.example.com'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                OllamaClassifier('gemma3:12b', url)
        with self.assertRaises(ValueError):
            OllamaClassifier('gpt-oss:120b-cloud')
        with patch.dict('os.environ', SYNCUP_LOCAL_PRIVACY_URL='http://10.0.0.5:11434'):
            self.assertIsInstance(classifier_from_env(), UnconfiguredClassifier)
        with patch.dict('os.environ', SYNCUP_LOCAL_PRIVACY_MODEL=''):
            self.assertIsInstance(classifier_from_env(), UnconfiguredClassifier)

    def serve(self, show, chat):
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def reply(self, payload):
                data = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            def do_GET(self):
                self.reply(dict(models=[dict(name='fixture:1b', model='fixture:1b', digest='a' * 64)]))
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                self.server.bodies.append(body)
                if self.server.no_schema and 'format' in body:
                    data = b'{"error":"structured output is unavailable"}'
                    self.send_response(501)
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                self.reply(show if self.path == '/api/show' else chat)
        server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
        server.bodies = []
        server.no_schema = False
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def test_new_engine_without_schema_falls_back_to_strict_json(self):
        # Ollama 0.40 + gemma4/qwen3.5: 501 for schema output. Retry once without it; prose still fails closed.
        answer = dict(message=dict(content='```json\n' + json.dumps(dict(label='mixed', personal=['병원 때문에'])) + '\n```'))
        server = self.serve({}, answer)
        server.no_schema = True
        classifier = OllamaClassifier('fixture:1b', f'http://127.0.0.1:{server.server_port}', timeout=5)
        with offline([], loopback=True):
            self.assertEqual(classifier.classify(MIXED)['label'], 'mixed')
            self.assertFalse(classifier.structured)
            classifier.classify(MIXED)
        chats = [b for b in server.bodies if 'messages' in b]
        self.assertEqual(['format' in b for b in chats], [True, False, False], 'schema asked once, then plain JSON')
        self.assertTrue(all(b['keep_alive'] == '60s' for b in chats), 'fallback must not restore long residency')
        prose = self.serve({}, dict(message=dict(content='이건 업무 같아요')))
        prose.no_schema = True
        with offline([], loopback=True), self.assertRaises(ModelOutputError):
            OllamaClassifier('fixture:1b', f'http://127.0.0.1:{prose.server_port}', timeout=5).classify(MIXED)

    def test_real_client_over_loopback_and_remote_model_refused(self):
        answer = dict(message=dict(content=json.dumps(dict(label='mixed', personal=['병원 때문에']))))
        server = self.serve({}, answer)
        classifier = OllamaClassifier('fixture:1b', f'http://127.0.0.1:{server.server_port}', timeout=5)
        with offline([], loopback=True):
            self.assertEqual(classifier.identity(), 'ollama:fixture:1b@aaaaaaaaaaaa')
            self.assertEqual(classifier.classify(MIXED)['label'], 'mixed')
        chat = server.bodies[-1]
        self.assertEqual(chat['keep_alive'], '60s')
        self.assertEqual((chat['stream'], chat['options']['temperature'], chat['format']['required']), (False, 0, ['label', 'personal']))
        remote = self.serve(dict(remote_host='https://ollama.com:443', remote_model='x'), answer)
        with offline([], loopback=True), self.assertRaises(ModelUnavailable):
            OllamaClassifier('fixture:1b', f'http://127.0.0.1:{remote.server_port}', timeout=5).identity()
        with offline([], loopback=True), self.assertRaises(ModelUnavailable):
            OllamaClassifier('fixture:1b', 'http://127.0.0.1:9', timeout=2).identity()

    def test_schema_fallback_rejects_ambiguous_json_wrappers(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        db = Path(temp.name) / 'privacy.sqlite'
        with connect(db) as c:
            local_privacy.initialize(c)
        valid = '{"label":"work","personal":[]}'
        invalid = [f'[{valid}]', f'불확실하지만 {valid}', f'{valid} 추가 설명',
                   valid + valid, '{"label":"unsure","label":"work","personal":[]}', None]
        for content in invalid:
            with self.subTest(content=content):
                classifier = OllamaClassifier('fixture:1b')
                unsupported = ModelError('local model HTTP 501', 501)
                response = dict(message=dict(content=content))
                with patch.object(classifier, '_call', side_effect=[unsupported, response, response]) as call:
                    with self.assertRaises(ModelOutputError):
                        classifier.classify('합성 업무 문장')
                    result = Gate(classifier).check(db, '합성 업무 문장', 'user', 'fixture:1b')
                    self.assertEqual((result.decision, result.reason), (local_privacy.HOLD, 'model_output'))
                    self.assertEqual(result.sanitized, '')
                    self.assertEqual(call.call_count, 3)

    def test_pre_strict_parser_cache_is_not_reused(self):
        for old_policy in ('syncup-local-privacy/1', 'syncup-local-privacy/2'):
            temp = tempfile.TemporaryDirectory()
            self.addCleanup(temp.cleanup)
            db = Path(temp.name) / 'privacy.sqlite'
            text, identity = '합성 업무 문장', 'fixture:1b'
            with patch.object(local_privacy, 'POLICY_VERSION', old_policy):
                old_key = local_privacy._key(identity, 'user', text)
            with connect(db) as c:
                local_privacy.initialize(c)
                label = local_privacy._compact(text, dict(label='work', personal=[]))
                c.execute('INSERT INTO privacy_results VALUES(?,?,?,?,?)',
                          (old_key, old_policy, identity, json.dumps(label), time.time()))
            classifier = OllamaClassifier('fixture:1b')
            with patch.object(classifier, 'classify', side_effect=ModelOutputError('ambiguous answer')) as classify:
                result = Gate(classifier).check(db, text, 'user', identity)
            self.assertEqual((result.decision, result.reason), (local_privacy.HOLD, 'model_output'))
            classify.assert_called_once_with(text)


if __name__ == '__main__':
    unittest.main()
