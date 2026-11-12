"""Strict HTTP for SyncUp. Server side: the handler base of the local review page, the demo board and the team API
(strict response headers, an exact Host check, bounded request bodies) and the loopback server that owns its port.
Client side: an opener handler that refuses redirects."""
import http.server
import sys
import urllib.request

FORM_LIMIT = 64 * 1024
# Largest local RPC request; the Chrome native host (native_host.py) enforces the same limit on its side.
RPC_LIMIT = 4 * 1024 * 1024
CONTENT_SECURITY_POLICY = ("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
                           "form-action 'self'; frame-ancestors 'none'; base-uri 'none'")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse every redirect: the team API, the demo board and the local RPC endpoint never send one."""

    def redirect_request(self, *args, **kwargs):
        return None


class LoopbackServer(http.server.ThreadingHTTPServer):
    """The review page and demo board server. A second server on a port in use fails to start, as on POSIX: on Windows
    SO_REUSEADDR would let it bind the same port, and Windows needs no option to rebind a port after a restart."""

    def server_bind(self):
        if sys.platform == 'win32':
            self.allow_reuse_address = False
        super().server_bind()


class SecureHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, value, mime="text/html; charset=utf-8"):
        data = value.encode()
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", CONTENT_SECURITY_POLICY)
        try:
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            # A disconnected client cannot receive a second error response.
            self.close_connection = True

    def redirect_home(self):
        self.send_response(303)
        self.send_header("Location", "/")
        self.end_headers()

    def valid_host(self):
        """Loopback servers accept only their own address; the cloud server overrides this."""
        return self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"

    def body(self, limit=FORM_LIMIT):
        self.connection.settimeout(10)
        if self.headers.get("Transfer-Encoding"):
            raise ValueError("지원하지 않는 요청 형식입니다.")
        n = int(self.headers.get("Content-Length", "0"))
        if not 0 < n <= limit:
            raise ValueError("요청 크기를 확인해 주세요.")
        data = self.rfile.read(n)
        if len(data) != n:
            raise ValueError("요청이 끝나지 않았습니다.")
        return data
