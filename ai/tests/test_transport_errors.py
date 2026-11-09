"""Actual loopback HTTP failures plus timeout and TLS exception classification."""
import http.client
import json
import ssl
import unittest
import urllib.error
from unittest.mock import patch

from syncup_ai.llm import RETRYABLE_STATUS, _post, describe_failure, LLMError, RetryableLLMError
from tests.loopback import Reply, loopback_server


class TransportTest(unittest.TestCase):
    def test_http_status_and_invalid_body_do_not_retry_inside_client(self):
        reply = Reply()
        with loopback_server(reply) as origin:
            url = f'{origin}/test'
            for code in (408, 429, 500, 502, 503, 504, 400, 401, 403, 404, 422, 501):
                reply.status = code
                before = len(reply.requests)
                with self.assertRaises(LLMError) as caught:
                    _post(url, 'synthetic-key', {})
                self.assertEqual(isinstance(caught.exception, RetryableLLMError), code in RETRYABLE_STATUS)
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(describe_failure(caught.exception), f'{type(caught.exception).__name__} HTTP {code}')
                self.assertEqual(len(reply.requests), before + 1)
            reply.status, reply.body = 200, b'not-json'
            with self.assertRaises(json.JSONDecodeError):
                _post(url, 'synthetic-key', {})

    def test_transport_exceptions_and_certificate_failure(self):
        for error, retry in [(TimeoutError(), True), (ConnectionResetError(), True),
                             (http.client.IncompleteRead(b''), True),
                             (urllib.error.URLError(ConnectionRefusedError()), True),
                             (urllib.error.URLError('unknown url type'), False),
                             (urllib.error.URLError(ssl.SSLCertVerificationError()), False)]:
            with self.subTest(error=type(error).__name__), patch('urllib.request.urlopen', side_effect=error) as call:
                with self.assertRaises(LLMError) as caught:
                    _post('http://localhost/test', 'synthetic-key', {})
                self.assertEqual(isinstance(caught.exception, RetryableLLMError), retry)
                self.assertIsNone(caught.exception.code)
                self.assertEqual(call.call_count, 1)


if __name__ == '__main__':
    unittest.main()
