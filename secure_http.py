"""HTTP handler base for the local review page, the demo board and the team API: strict response headers, an exact Host
check and bounded request bodies."""
import http.server

FORM_LIMIT = 64 * 1024
CONTENT_SECURITY_POLICY = ("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
                           "form-action 'self'; frame-ancestors 'none'; base-uri 'none'")


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
