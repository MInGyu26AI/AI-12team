"""The few GitHub REST calls that commit files to one branch (Git Data API, standard library only).

The token goes only to the configured API host: it is dropped when GitHub answers with a redirect.
"""
import base64
import hashlib
import http.client
import json
import urllib.error
import urllib.parse
import urllib.request

REQUEST_TIMEOUT_SECONDS = 15
MOVED_BRANCH_RETRIES = 2  # the branch moved between reading and updating it: build the files again on the new head


class GitHubError(Exception):
    """A GitHub API failure; `code` is the HTTP status when GitHub answered."""

    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def call(target, method, path, body=None):
    """One request to `{api}/repos/{repo}/{path}` with `target.token`; the JSON answer."""
    request = urllib.request.Request(
        f'{target.api}/repos/{target.repo}/{path}', method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
                 'User-Agent': 'SyncUp-team-server', 'Content-Type': 'application/json'})
    # urllib copies ordinary headers to wherever a redirect points; an unredirected one is never sent there
    request.add_unredirected_header('Authorization', 'Bearer ' + target.token)
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        error.close()
        raise GitHubError(f'GitHub {method} 실패', code=error.code) from None
    except (OSError, ValueError, http.client.HTTPException):  # no connection, timeout, broken reply or not JSON
        raise GitHubError('GitHub 응답을 받지 못했습니다.') from None


def blob_sha(text):
    """Git's id for a file with this content, to compare with the branch without downloading it."""
    data = text.encode('utf-8')
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


def save(target, build, message):
    """Commit the files `build()` returns where they differ from the branch head, in one commit; None if none differ.

    build() runs on every attempt, so after the branch moved (a teammate's push or another server's save) the files
    are made again from current data instead of replacing newer files with older ones.
    message(previous) makes the commit message from the branch's syncup.json at that point ({} when absent)."""
    branch = urllib.parse.quote(target.branch, safe='/')
    for _ in range(MOVED_BRANCH_RETRIES + 1):
        files = build()
        head = _head(target, branch)
        tree = call(target, 'GET', f'git/commits/{head}')['tree']['sha']
        current = {entry['path']: entry['sha'] for entry in call(target, 'GET', f'git/trees/{tree}')['tree']}
        changed = [name for name, text in files.items() if current.get(name) != blob_sha(text)]
        if not changed:
            return None
        entries = [dict(path=name, mode='100644', type='blob', content=files[name]) for name in changed]
        new_tree = call(target, 'POST', 'git/trees', dict(base_tree=tree, tree=entries))['sha']
        commit = call(target, 'POST', 'git/commits',
                      dict(message=message(_previous_state(target, current)), tree=new_tree, parents=[head]))
        try:
            call(target, 'PATCH', f'git/refs/heads/{branch}', dict(sha=commit['sha'], force=False))
            return commit
        except GitHubError as error:
            # 422 is also a rule refusing the update (protected branch): only a moved head is worth another try
            if error.code != 422 or _head(target, branch) == head:
                raise
    raise GitHubError('브랜치가 계속 바뀌어 저장하지 못했습니다.', code=422)


def last_commit(target, path):
    """The newest commit on the branch that changed `path`, as {sha, url, at}; None when unknown."""
    query = urllib.parse.urlencode(dict(path=path, sha=target.branch, per_page=1))
    try:
        found = call(target, 'GET', f'commits?{query}')
        return dict(sha=found[0]['sha'], url=found[0].get('html_url'), at=found[0]['commit']['committer']['date'])
    except (GitHubError, LookupError, TypeError):  # failed, no such commit, or an unexpected shape
        return None


def _head(target, branch):
    return call(target, 'GET', f'git/ref/heads/{branch}')['object']['sha']


def _previous_state(target, current):
    if 'syncup.json' not in current:
        return {}
    blob = call(target, 'GET', f"git/blobs/{current['syncup.json']}")
    try:
        previous = json.loads(base64.b64decode(blob['content']))
    except (KeyError, TypeError, ValueError):
        return {}
    return previous if isinstance(previous, dict) else {}
