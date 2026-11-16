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
# A link check makes up to three calls while the collector waits 8 seconds for the team server (team_client.py).
VERIFY_TIMEOUT_SECONDS = 2
MOVED_BRANCH_RETRIES = 2  # the branch moved between reading and updating it: build the files again on the new head


class GitHubError(Exception):
    """A GitHub API failure; `code` is the HTTP status when GitHub answered."""

    def __init__(self, message, code=None, limited=False):
        super().__init__(message)
        self.code = code
        self.limited = limited  # GitHub's rate limit, not the token or the repository


def call(target, method, path, body=None, timeout=REQUEST_TIMEOUT_SECONDS):
    """One request to `{api}/repos/{repo}/{path}` (the repository itself when path is empty) with `target.token`;
    the JSON answer."""
    request = urllib.request.Request(
        f'{target.api}/repos/{target.repo}' + (f'/{path}' if path else ''), method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
                 'User-Agent': 'SyncUp-team-server', 'Content-Type': 'application/json'})
    # urllib copies ordinary headers to wherever a redirect points; an unredirected one is never sent there
    request.add_unredirected_header('Authorization', 'Bearer ' + target.token)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        limited = error.code == 429 or (error.headers or {}).get('x-ratelimit-remaining') == '0'
        error.close()
        raise GitHubError(f'GitHub {method} 실패', code=error.code, limited=limited) from None
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


def is_private(target, timeout=VERIFY_TIMEOUT_SECONDS):
    """Whether GitHub says the repository is private now; GitHubError when it cannot say."""
    repo = call(target, 'GET', '', timeout=timeout)
    if not isinstance(repo, dict) or not isinstance(repo.get('private'), bool):
        raise GitHubError('GitHub 레포 정보 형식 오류')
    return repo['private']


def verify(target, timeout=VERIFY_TIMEOUT_SECONDS):
    """Whether `target.token` can commit to `target.branch`: (None, private) when it can, else (reason, private).

    private is None until GitHub has said. Three calls at most: the repository, the branch, and an empty blob as the
    write probe. The probe always runs, because the repository's `permissions` describe the person, not what a
    fine-grained token was granted. It adds an unreferenced object and moves no branch."""
    try:
        repo = call(target, 'GET', '', timeout=timeout)
    except GitHubError as error:
        return _refusal(error, {401: 'bad-token', 403: 'not-found', 404: 'not-found'}), None
    if not isinstance(repo, dict) or not isinstance(repo.get('private'), bool):
        return 'unreachable', None
    private = repo['private']
    if repo.get('archived') or (repo.get('permissions') or {}).get('push') is False:
        return 'no-write', private
    try:
        call(target, 'GET', f"git/ref/heads/{urllib.parse.quote(target.branch, safe='/')}", timeout=timeout)
    except GitHubError as error:  # 409: the repository has no commit yet, so no branch either
        return _refusal(error, {401: 'bad-token', 404: 'no-branch', 409: 'no-branch'}), private
    try:
        call(target, 'POST', 'git/blobs', dict(content='', encoding='utf-8'), timeout=timeout)
    except GitHubError as error:
        return _refusal(error, {401: 'bad-token', 403: 'no-write', 404: 'no-write'}), private
    return None, private


def _refusal(error, reasons):
    if error.limited:
        return 'rate-limited'
    return reasons.get(error.code, 'unreachable')
