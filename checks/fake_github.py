"""A local stand-in for the GitHub REST API (the Git Data endpoints server/github_repo.py uses), for checks only.

One branch and root files only. Blob ids follow git's own formula here, independently of github_repo.blob_sha.
"""
import base64
from contextlib import contextmanager
import hashlib
import http.server
import json
import threading
import urllib.parse

from check_teams import running_server

COMMIT_URL = 'https://github.example/commit/'
COMMIT_DATE = '2026-11-13T05:00:00Z'


def git_blob_id(text):
    data = text.encode('utf-8')
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\x00' + data).hexdigest()


class FakeGitHub:
    def __init__(self):
        self.objects, self.requests, self.lock = {}, [], threading.RLock()
        self.branch = 'main'
        self.fail_next = None  # (method, path fragment, status): answered once instead of the real reply
        self.redirect_next = None  # (path fragment, location): answered once with a 302 to `location`
        self.before_ref_update = None  # runs once before a branch move, e.g. a teammate's push
        self.refuse_updates = False  # a branch rule (protection) refuses every update with 422
        self.head = self.commit({'README.md': '# 팀 레포\n'}, 'init', [])

    def store(self, kind, value, sha=None):
        sha = sha or hashlib.sha1(json.dumps([kind, value, len(self.objects)], ensure_ascii=False).encode()).hexdigest()
        self.objects[sha] = value
        return sha

    def tree(self, files):
        return self.store('tree', {path: self.store('blob', text, git_blob_id(text)) for path, text in files.items()})

    def commit(self, files, message, parents):
        return self.store('commit', dict(tree=self.tree(files), message=message, parents=parents))

    def files(self, sha=None):
        """{path: text} at a commit (default: the branch head)."""
        with self.lock:
            tree = self.objects[self.objects[sha or self.head]['tree']]
            return {path: self.objects[blob] for path, blob in tree.items()}

    def commits(self):
        """Commit messages from the branch head back to the first commit."""
        with self.lock:
            messages, sha = [], self.head
            while sha:
                messages.append(self.objects[sha]['message'])
                sha = (self.objects[sha]['parents'] or [None])[0]
            return messages

    def push(self, files, message):
        """A teammate's push straight to the branch."""
        with self.lock:
            self.head = self.commit(dict(self.files(), **files), message, [self.head])

    def sent(self, method, fragment):
        """The requests with this method whose path contains `fragment`."""
        with self.lock:
            return [r for r in self.requests if r[0] == method and fragment in r[1]]

    def answer(self, method, path, body):
        if self.redirect_next and self.redirect_next[0] in path:
            location, self.redirect_next = self.redirect_next[1], None
            return 302, {'location': location}
        if self.fail_next and method == self.fail_next[0] and self.fail_next[1] in path:
            status, self.fail_next = self.fail_next[2], None
            return status, {'message': 'synthetic failure'}
        url = urllib.parse.urlsplit(path)
        parts = url.path.split('/')[4:]  # after /repos/{owner}/{name}
        if method == 'GET':
            return self.read(parts, urllib.parse.parse_qs(url.query))
        if method == 'POST' and parts == ['git', 'trees']:
            files = {p: self.objects[s] for p, s in self.objects[body['base_tree']].items()}
            return 201, {'sha': self.tree(dict(files, **{e['path']: e['content'] for e in body['tree']}))}
        if method == 'POST' and parts == ['git', 'commits']:
            sha = self.store('commit', dict(tree=body['tree'], message=body['message'], parents=body['parents']))
            return 201, {'sha': sha, 'html_url': COMMIT_URL + sha, 'committer': {'date': COMMIT_DATE}}
        if method == 'PATCH' and parts[:3] == ['git', 'refs', 'heads']:
            return self.move_branch(body['sha'])
        return 404, {}

    def read(self, parts, query):
        if parts[:3] == ['git', 'ref', 'heads']:
            return (200, {'object': {'sha': self.head}}) if '/'.join(parts[3:]) == self.branch else (404, {})
        if parts[:2] == ['git', 'commits']:
            return 200, {'sha': parts[2], 'tree': {'sha': self.objects[parts[2]]['tree']}}
        if parts[:2] == ['git', 'trees']:
            entries = self.objects[parts[2]].items()
            return 200, {'tree': [dict(path=p, sha=s, type='blob', mode='100644') for p, s in entries]}
        if parts[:2] == ['git', 'blobs']:
            return 200, {'content': base64.b64encode(self.objects[parts[2]].encode()).decode(), 'encoding': 'base64'}
        if parts == ['commits']:
            return 200, self.last_change(query['path'][0])
        return 404, {}

    def move_branch(self, sha):
        if self.before_ref_update:
            hook, self.before_ref_update = self.before_ref_update, None
            hook()
        if self.refuse_updates:
            return 422, {'message': 'Protected branch update failed'}
        if self.objects[sha]['parents'] != [self.head]:
            return 422, {'message': 'Update is not a fast forward'}
        self.head = sha
        return 200, {'object': {'sha': sha}}

    def last_change(self, path):
        sha = self.head
        while sha:
            parent = (self.objects[sha]['parents'] or [None])[0]
            if self.files(sha).get(path) != (self.files(parent).get(path) if parent else None):
                return [dict(sha=sha, html_url=COMMIT_URL + sha, commit={'committer': {'date': COMMIT_DATE}})]
            sha = parent
        return []


def _reply(handler, status, reply):
    data = json.dumps(reply).encode()
    handler.send_response(status)
    if 300 <= status < 400:
        handler.send_header('Location', reply['location'])
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Content-Length', str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


@contextmanager
def fake_github(fake):
    """Serve `fake` on loopback; yields the API base URL."""
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def handle_api(self):
            raw = self.rfile.read(int(self.headers.get('Content-Length') or 0))
            with fake.lock:
                fake.requests.append((self.command, self.path, raw.decode(), self.headers.get('Authorization')))
                status, reply = fake.answer(self.command, self.path, json.loads(raw) if raw else None)
            _reply(self, status, reply)

        do_GET = do_POST = do_PATCH = handle_api
    with running_server(Handler) as srv:
        yield f'http://127.0.0.1:{srv.server_port}'


@contextmanager
def header_trap():
    """Another host: records each request's Authorization header and answers 404. Yields (origin, headers seen)."""
    seen = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            seen.append(self.headers.get('Authorization'))
            _reply(self, 404, {})
    with running_server(Handler) as srv:
        yield f'http://localhost:{srv.server_port}', seen
