"""실제 HTTP 로 응답하는 127.0.0.1 시험 서버."""
import contextlib
import http.server
import threading


class Reply:
    """시험이 바꿔 가며 쓰는 응답 상태 코드·본문과, 받은 요청 (경로, 본문 바이트) 기록."""

    def __init__(self, status=200, body=b'{}'):
        self.status, self.body, self.requests = status, body, []


@contextlib.contextmanager
def loopback_server(reply):
    """POST 마다 reply.status·reply.body 로 답하는 서버를 띄우고 'http://127.0.0.1:포트' 를 돌려준다."""

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            reply.requests.append((self.path, self.rfile.read(int(self.headers['Content-Length']))))
            self.send_response(reply.status)
            self.send_header('Content-Length', str(len(reply.body)))
            self.end_headers()
            self.wfile.write(reply.body)

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}'
    finally:
        server.shutdown()
        server.server_close()
        worker.join()
