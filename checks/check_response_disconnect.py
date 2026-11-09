"""A lost response must not become a second RPC error response."""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import unittest
from unittest.mock import Mock

from secure_http import SecureHandler


class ResponseDisconnect(unittest.TestCase):
    def handler(self):
        handler = SecureHandler.__new__(SecureHandler)
        handler.send_response = Mock()
        handler.send_header = Mock()
        handler.end_headers = Mock()
        handler.wfile = Mock()
        return handler

    def test_disconnect_during_headers_or_body_closes_without_rethrow(self):
        for phase in ('headers', 'body'):
            for error in (BrokenPipeError, ConnectionResetError):
                with self.subTest(phase=phase, error=error):
                    handler = self.handler()
                    target = handler.end_headers if phase == 'headers' else handler.wfile.write
                    target.side_effect = error()
                    handler.reply(200, '{}', 'application/json')
                    self.assertTrue(handler.close_connection)
                    handler.send_response.assert_called_once_with(200)
                    target.assert_called_once()

    def test_other_io_error_still_propagates(self):
        handler = self.handler()
        handler.wfile.write.side_effect = OSError('test disk or device error')
        with self.assertRaises(OSError):
            handler.reply(200, '{}')

    def test_normal_response_is_unchanged(self):
        handler = self.handler()
        handler.reply(200, '승인')
        handler.wfile.write.assert_called_once_with('승인'.encode())


if __name__ == '__main__':
    unittest.main()
