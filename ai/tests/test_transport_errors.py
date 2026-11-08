"""Actual loopback HTTP failures plus timeout and TLS exception classification."""
import http.client
import http.server
import json
import ssl
import threading
import unittest
import urllib.error
from unittest.mock import patch

from syncup_ai.llm import _post, LLMError, RetryableLLMError


class TransportTest(unittest.TestCase):
    def test_http_status_and_invalid_body_do_not_retry_inside_client(self):
        calls=[]; status=[503]; body=[b'{}']
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                calls.append(self.rfile.read(int(self.headers['Content-Length'])))
                self.send_response(status[0]); self.send_header('Content-Length',str(len(body[0])))
                self.end_headers(); self.wfile.write(body[0])
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        worker=threading.Thread(target=server.serve_forever,daemon=True); worker.start()
        try:
            url=f'http://127.0.0.1:{server.server_port}/test'
            for code in (408,429,500,502,503,504,400,401,403,404,422,501):
                status[0]=code; before=len(calls)
                with self.assertRaises(LLMError) as caught:
                    _post(url,'synthetic-key',{})
                self.assertEqual(isinstance(caught.exception,RetryableLLMError),code in (408,429,500,502,503,504))
                self.assertEqual(len(calls),before+1)
            status[0]=200; body[0]=b'not-json'
            with self.assertRaises(json.JSONDecodeError): _post(url,'synthetic-key',{})
        finally:
            server.shutdown(); server.server_close(); worker.join()

    def test_transport_exceptions_and_certificate_failure(self):
        for error,retry in [(TimeoutError(),True),(ConnectionResetError(),True),
                (http.client.IncompleteRead(b''),True),
                (urllib.error.URLError(ConnectionRefusedError()),True),
                (urllib.error.URLError('unknown url type'),False),
                (urllib.error.URLError(ssl.SSLCertVerificationError()),False)]:
            with self.subTest(error=type(error).__name__), patch('urllib.request.urlopen',side_effect=error) as call:
                with self.assertRaises(LLMError) as caught:
                    _post('http://localhost/test','synthetic-key',{})
                self.assertEqual(isinstance(caught.exception,RetryableLLMError),retry)
                self.assertEqual(call.call_count,1)


if __name__=='__main__': unittest.main()
