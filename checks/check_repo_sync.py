"""Saving SYNCUP.md·syncup.json to GitHub: a local fake GitHub API and real PostgreSQL; no network, no real token."""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import json
import logging
import threading
import time
import types
import unittest
import uuid
from unittest.mock import patch

import psycopg

import local_rpc
import repo_sync
import team_relay
import team_server
from ai.syncup_ai.team_state import build_state
from check_team_integration import checked
from check_teams import TeamIsolation, own_tests, request
from conflict_scheduler import schedule
from fake_github import COMMIT_URL, FakeGitHub, fake_github, header_trap
from github_repo import GitHubError, blob_sha, save, verify
from local_fixtures import public_card
from repo_sync import RepoTarget, commit_message, repo_status, schedule_save, target_from_env

TOKEN = 'synthetic-github-token-DO-NOT-LOG'
# Tokens a team types into the web: deliberately unlike any real GitHub token format.
WEB_TOKEN = 'synthetic-web-link-token-0001-DO-NOT-LOG'
OTHER_TOKEN = 'synthetic-web-link-token-0002-DO-NOT-LOG'
PRIVATE_SENTENCE = 'PRIVATE_SENTENCE_SENTINEL_512'
PRIVATE_SOURCE = 'PRIVATE_SOURCE_SENTINEL_512'
FILES = {'SYNCUP.md': '# 기록\n', 'syncup.json': '{"syncup_version": 1}\n'}


def card(cid, tag, content, topic='DB', state='active', at=1):
    return dict(id=cid, relevance='related', tag=tag, subtopic='작업·결과물', topic_key=topic, content=content,
                approvedAt=1793966400 + at, decisionState=state)


def wait_until(condition, timeout=5):
    end = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > end:
            raise AssertionError('condition not reached')
        time.sleep(.02)


class GitHubSave(unittest.TestCase):
    def setUp(self):
        self.fake = FakeGitHub()
        origin = self.enterContext(fake_github(self.fake))
        self.target = RepoTarget(uuid.uuid4(), 'team/repo', 'main', TOKEN, api=origin)

    def test_blob_ids_are_the_ones_git_uses(self):
        self.assertEqual(blob_sha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a')  # git hash-object
        self.assertEqual(blob_sha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')

    def test_both_files_in_one_commit_and_nothing_when_unchanged(self):
        commit = save(self.target, lambda: FILES, lambda previous: f'sync {previous}')
        self.assertEqual(self.fake.head, commit['sha'])
        self.assertEqual(self.fake.files(), {'README.md': '# 팀 레포\n', **FILES})
        self.assertEqual(self.fake.commits(), ['sync {}', 'init'])
        sent = len(self.fake.requests)
        self.assertIsNone(save(self.target, lambda: FILES, lambda previous: 'unused'))
        self.assertEqual([method for method, *_ in self.fake.requests[sent:]], ['GET'] * 3)  # ref, commit, tree
        self.assertEqual({auth for *_, auth in self.fake.requests}, {'Bearer ' + TOKEN})
        self.assertFalse(any(TOKEN in path + body for _, path, body, _ in self.fake.requests))

    def test_only_changed_files_are_sent_and_the_message_sees_the_previous_state(self):
        save(self.target, lambda: {'SYNCUP.md': 'a\n', 'syncup.json': '{"n": 1}\n'}, lambda previous: 'first')
        seen = []
        save(self.target, lambda: {'SYNCUP.md': 'a\n', 'syncup.json': '{"n": 2}\n'},
             lambda previous: seen.append(previous) or 'second')
        self.assertEqual(seen, [{'n': 1}])
        tree = json.loads(self.fake.sent('POST', '/git/trees')[-1][2])
        self.assertEqual([entry['path'] for entry in tree['tree']], ['syncup.json'])

    def test_after_a_teammate_push_the_files_are_built_again_on_top_of_it(self):
        builds = []
        self.fake.before_ref_update = lambda: self.fake.push({'docs.md': 'teammate\n'}, 'teammate push')
        save(self.target, lambda: builds.append(1) or FILES, lambda previous: 'sync')
        self.assertEqual(len(builds), 2)
        self.assertEqual(self.fake.commits(), ['sync', 'teammate push', 'init'])
        self.assertEqual(self.fake.files()['docs.md'], 'teammate\n')

    def test_a_branch_rule_refusal_is_reported_without_retrying(self):
        self.fake.refuse_updates = True
        with self.assertRaises(GitHubError) as caught:
            save(self.target, lambda: FILES, lambda previous: 'sync')
        self.assertEqual(caught.exception.code, 422)
        self.assertEqual(len(self.fake.sent('POST', '/git/commits')), 1)

    def test_a_redirect_elsewhere_never_carries_the_token(self):
        origin, seen = self.enterContext(header_trap())
        self.fake.redirect_next = ('/git/ref/', origin + '/somewhere')
        with self.assertRaises(GitHubError):
            save(self.target, lambda: FILES, lambda previous: 'sync')
        self.assertEqual(seen, [None])

    def test_branch_names_with_a_slash(self):
        self.fake.branch = 'feat/sync'
        target = RepoTarget(self.target.team_id, 'team/repo', 'feat/sync', TOKEN, api=self.target.api)
        self.assertIsNotNone(save(target, lambda: FILES, lambda previous: 'sync'))
        self.assertTrue(self.fake.sent('PATCH', '/git/refs/heads/feat/sync'))

    def test_failures_carry_the_status_but_never_the_token(self):
        self.fake.branch = 'server'  # the linked branch (main) does not exist yet
        with self.assertRaises(GitHubError) as caught:
            save(self.target, lambda: FILES, lambda previous: 'sync')
        self.assertEqual(caught.exception.code, 404)
        self.assertNotIn(TOKEN, str(caught.exception) + repr(self.target))

    def test_settings_are_all_or_nothing_and_errors_never_show_the_token(self):
        team = uuid.uuid4()
        self.assertIsNone(target_from_env({}))
        full = dict(SYNCUP_GITHUB_TEAM=str(team), SYNCUP_GITHUB_REPO='MInGyu26AI/AI-12team', SYNCUP_GITHUB_TOKEN=TOKEN)
        target = target_from_env(full)
        self.assertEqual((target.team_id, target.repo, target.branch), (team, 'MInGyu26AI/AI-12team', 'main'))
        self.assertEqual(target_from_env(dict(full, SYNCUP_GITHUB_BRANCH='feat/github-sync')).branch, 'feat/github-sync')
        bad = [dict(SYNCUP_GITHUB_TOKEN=''), dict(SYNCUP_GITHUB_REPO='https://github.com/a/b'), dict(SYNCUP_GITHUB_TEAM='A팀')]
        bad += [dict(SYNCUP_GITHUB_BRANCH=name) for name in ('a..b', '/main', 'main/', 'a//b', '.hidden', 'x.lock')]
        for change in bad:
            with self.subTest(change=change), self.assertRaises(ValueError) as caught:
                target_from_env(dict(full, **change))
            self.assertNotIn(TOKEN, str(caught.exception))

    def test_commit_message_names_the_first_change_the_rest_and_who(self):
        first = build_state([card('d1', 'decision', 'DB = SQLite'), card('t1', 'todo', '배포')])
        later = build_state([card('d1', 'decision', 'DB = SQLite', state='superseded'), card('t1', 'todo', '배포'),
                             card('d2', 'decision', 'DB = PostgreSQL', at=2)], done=['t1'])
        self.assertEqual(commit_message({}, first, {'Dana': True}), 'SyncUp: DB 결정 추가 외 1건 (Dana 승인)')
        self.assertEqual(commit_message(first, later, {'Dana': True, 'Alice': False}),
                         'SyncUp: DB 결정 변경 외 1건 (Dana 승인, Alice)')
        self.assertEqual(commit_message({'decisions': 'edited by hand'}, first), 'SyncUp: 팀 기록 갱신')


class Server:
    """Just what schedule_save needs from a team server."""

    def __init__(self, target):
        self.repo_target, self.checks_stop = target, threading.Event()


class SaveScheduling(unittest.TestCase):
    """Waiting and batching only: the save itself is replaced."""

    def setUp(self):
        self.team = uuid.uuid4()
        self.server = Server(RepoTarget(self.team, 'team/repo', 'main', TOKEN))

    def test_pending_stays_true_while_any_save_is_under_way(self):
        gates, started = [threading.Event(), threading.Event()], []

        def blocked_save(server, target, job):
            started.append(job)
            gates[len(started) - 1].wait(5)
        with patch.object(repo_sync, '_save_and_record', blocked_save):
            for count in (1, 2):
                schedule_save(self.server, 'token', self.team, delay=0)
                wait_until(lambda: len(started) == count)
            gates[0].set()
            time.sleep(.1)
            self.assertTrue(repo_status(self.server, self.team)['pending'])
            gates[1].set()
            wait_until(lambda: not repo_status(self.server, self.team)['pending'])

    def test_a_steady_stream_of_changes_still_saves_within_the_longest_wait(self):
        saves = []
        with patch.object(repo_sync, 'SAVE_DELAY_SECONDS', .3), patch.object(repo_sync, 'SAVE_MAX_WAIT_SECONDS', .6), \
                patch.object(repo_sync, '_save_and_record', lambda server, target, job: saves.append(time.monotonic())):
            start = time.monotonic()
            while time.monotonic() - start < 1.5:
                schedule_save(self.server, 'token', self.team, actor='Dana')
                time.sleep(.1)
        self.assertTrue(saves and saves[0] - start < 1.0, saves)


class RepoSyncTeam(TeamIsolation):
    """Team A is linked to the fake repository; team B is not."""

    def setUp(self):
        super().setUp()
        self.fake = FakeGitHub()
        origin = self.enterContext(fake_github(self.fake))
        self.api.repo_target = RepoTarget(uuid.UUID(self.teams['A']), 'team/repo', 'main', TOKEN, api=origin)
        self.enterContext(patch.object(repo_sync, 'SAVE_DELAY_SECONDS', .3))

    def share(self, identifier, content, tag='decision', topic='DB', user='Dana', team='A'):
        shared = dict(public_card(PRIVATE_SENTENCE), content=content, tag=tag, topic_key=topic, source=PRIVATE_SOURCE)
        packet = dict(id=identifier, label='할 일' if tag == 'todo' else '결정', text=content, quote=PRIVATE_SENTENCE,
                      speaker='사용자', version=2, card=shared)
        envelope = dict(packet=packet, approved_by=self.users[user], approved_at=time.time())
        status, body = request(self.api, 'POST', self.path(team), self.tokens[user], envelope)
        self.assertEqual(status, 200, body)

    def repo_status(self, user='Dana', team='A'):
        status, body = request(self.api, 'GET', f"/teams/{self.teams[team]}/repo", self.tokens[user])
        self.assertEqual(status, 200, body)
        self.assertNotIn(TOKEN, body)
        return json.loads(body)['repo']

    def settled(self, timeout=10):
        """Team A's repository status once no save is waiting or running."""
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            status = self.repo_status()
            if not status['pending'] and status['state'] != 'unknown':
                return status
            time.sleep(.05)
        self.fail('the repository save did not finish')

    def assert_public(self):
        for text in self.fake.files().values():
            for private in (PRIVATE_SENTENCE, PRIVATE_SOURCE, self.users['Dana'], self.users['Alice'], TOKEN):
                self.assertNotIn(private, text)

    def scheduled(self):
        """Count the team server's save requests. The HTTP reply goes out before the save is scheduled, so a returned
        request is not yet a scheduled one; tests wait on this count instead."""
        calls = []
        real = team_server.schedule_save

        def counting(*args, **kwargs):
            real(*args, **kwargs)
            calls.append(kwargs.get('actor'))
        self.enterContext(patch.object(team_server, 'schedule_save', counting))
        return calls

    def waiting(self):
        """True while a save job for team A waits for changes to settle."""
        with repo_sync._lock:
            return uuid.UUID(self.teams['A']) in repo_sync._saves(self.api).waiting

    def hold_snapshot(self, after_read):
        """Stop the first save while it builds the files: before it reads the database, or right after.
        Returns (started, release) events."""
        started, release, real, calls = threading.Event(), threading.Event(), repo_sync.state_files, []

        def held(c, target):
            calls.append(1)
            first = len(calls) == 1
            if first and not after_read:
                started.set()
                release.wait(10)
            result = real(c, target)
            if first and after_read:
                started.set()
                release.wait(10)
            return result
        self.enterContext(patch.object(repo_sync, 'state_files', held))
        return started, release

    def test_a_burst_of_approvals_is_one_public_commit(self):
        """Both approvals are scheduled before the save starts: one job, one commit with both."""
        calls = self.scheduled()
        with patch.object(repo_sync, 'SAVE_DELAY_SECONDS', 5):  # long enough that nothing saves on its own
            self.share('d1', 'DB = PostgreSQL')
            self.share('t1', '배포 페이지 만들기', tag='todo', topic='배포')
            wait_until(lambda: len(calls) == 2)
        self.assertEqual(self.fake.commits(), ['init'])
        schedule_save(self.api, self.tokens['Dana'], self.teams['A'], delay=0)  # the batch is complete: save now
        status = self.settled()
        self.assertEqual(self.fake.commits(), ['SyncUp: DB 결정 추가 외 1건 (Dana 승인)', 'init'])
        self.assertEqual((status['state'], status['commit']['sha']), ('saved', self.fake.head))
        files = self.fake.files()
        self.assertIn('**DB**: DB = PostgreSQL', files['SYNCUP.md'])
        self.assertIn('`SU-1` 배포 페이지 만들기', files['SYNCUP.md'])
        self.assertEqual(json.loads(files['syncup.json'])['team'], dict(name='A팀', repo='team/repo'))
        self.assert_public()

    def test_a_second_job_whose_changes_the_first_already_saved_is_unchanged(self):
        """The second approval is scheduled as its own job while the first save waits to read the database;
        the first save then reads both, so the second finds nothing new. Not a failure: the web shows both
        'saved' and 'unchanged' as saved."""
        calls, (started, release) = self.scheduled(), self.hold_snapshot(after_read=False)
        self.share('d1', 'DB = PostgreSQL')
        started.wait(5)
        self.share('t1', '배포 페이지 만들기', tag='todo', topic='배포')
        wait_until(lambda: len(calls) == 2 and self.waiting())
        release.set()
        wait_until(lambda: not self.waiting())
        status = self.settled()
        self.assertEqual(self.fake.commits(), ['SyncUp: DB 결정 추가 외 1건 (Dana 승인)', 'init'])
        self.assertEqual((status['state'], status['commit']['sha']), ('unchanged', self.fake.head))
        self.assertIn('`SU-1` 배포 페이지 만들기', self.fake.files()['SYNCUP.md'])
        self.assert_public()

    def test_an_approval_after_the_first_snapshot_gets_its_own_commit(self):
        """The second approval lands after the first save has read the database: the next save must add it."""
        calls, (started, release) = self.scheduled(), self.hold_snapshot(after_read=True)
        self.share('d1', 'DB = PostgreSQL')
        started.wait(5)
        self.share('t1', '배포 페이지 만들기', tag='todo', topic='배포')
        wait_until(lambda: len(calls) == 2 and self.waiting())
        release.set()
        wait_until(lambda: not self.waiting())
        status = self.settled()
        self.assertEqual(self.fake.commits(), ['SyncUp: SU-1 할 일 추가 (Dana 승인)', 'SyncUp: DB 결정 추가 (Dana 승인)', 'init'])
        self.assertEqual((status['state'], status['commit']['sha']), ('saved', self.fake.head))
        files = self.fake.files()['SYNCUP.md']
        self.assertIn('**DB**: DB = PostgreSQL', files)
        self.assertIn('`SU-1` 배포 페이지 만들기', files)
        self.assert_public()

    def test_todo_checks_are_saved_and_unlinked_teams_never(self):
        self.share('t1', '배포 페이지 만들기', tag='todo', topic='배포')
        self.settled()
        for _ in range(2):  # two quick checks: one commit
            self.assertEqual(self.team_request('POST', 'items/t1/done', dict(done=True))[0], 200)
        self.settled()
        self.share('b1', 'B팀만의 결정', user='Bob', team='B')
        time.sleep(.6)
        self.assertEqual(self.fake.commits(), ['SyncUp: SU-1 완료 (Dana)', 'SyncUp: SU-1 할 일 추가 (Dana 승인)', 'init'])
        self.assertIn('- [x] `SU-1`', self.fake.files()['SYNCUP.md'])
        self.assertEqual(self.repo_status('Bob', 'B'), dict(linked=False))

    def test_a_github_failure_is_reported_and_its_people_named_in_the_next_commit(self):
        self.fake.fail_next = ('GET', '/git/ref/', 403)
        self.share('d1', 'DB = PostgreSQL', user='Alice')
        status = self.settled()
        self.assertEqual((status['state'], status['httpStatus']), ('failed', 403))
        self.assertEqual(self.fake.commits(), ['init'])
        self.share('d2', '저장 위치 = 팀 레포', topic='저장 위치')  # the next change saves everything
        self.assertEqual(self.settled()['state'], 'saved')
        self.assertEqual(self.fake.commits()[0], 'SyncUp: DB 결정 추가 외 1건 (Alice 승인, Dana 승인)')
        self.assertIn('DB = PostgreSQL', self.fake.files()['SYNCUP.md'])

    def test_the_first_request_after_a_start_saves_once(self):
        self.fake.push({'SYNCUP.md': '예전 기록\n'}, 'earlier sync')
        self.assertEqual(self.team_request('GET', 'board')[0], 200)  # any request, e.g. the board the web polls
        status = self.settled()
        self.assertEqual(status['state'], 'saved')  # the empty board replaces the stale file
        self.assertEqual(self.fake.commits()[0], 'SyncUp: 팀 기록 갱신')
        self.assertEqual(status['commit']['url'], COMMIT_URL + self.fake.head)
        self.team_request('GET', 'board')
        time.sleep(.2)
        self.assertEqual(len(self.fake.commits()), 3)  # only once

    def test_the_web_reads_the_status_through_the_local_relay(self):
        pipeline = types.SimpleNamespace(db=self.db, client=self.client)  # the collector's bound team is A
        relayed = team_relay.relay(pipeline, 'team.repo', {})
        self.assertEqual((relayed['repo']['linked'], relayed['repo']['repo'], relayed['repo']['branch']),
                         (True, 'team/repo', 'main'))
        self.assertEqual(self.settled()['state'], 'saved')
        self.assertEqual(team_relay.relay(pipeline, 'team.repo', {})['repo']['state'], 'saved')

    def test_alerts_found_by_the_worker_are_saved_without_quoting_the_ai(self):
        self.share('old', 'DB = SQLite')
        self.share('new', 'DB = PostgreSQL')
        self.settled()

        def engine(req):
            earlier = [c for c in req['existing'] if c['tag'] == 'decision']
            quoted = f"원문 '{PRIVATE_SENTENCE}'과 어긋남"  # what a chat judge may write
            return checked(req, [dict(id='pair', topic_key='DB', cardA=earlier[0], cardB=req['newCards'][0],
                                      judgement='충돌', reason=quoted, confidence=.9, method='chat')] if earlier else [])
        self.api.conflict_engine, self.api.disable_checks = engine, False
        schedule(self.api, self.tokens['Dana'], self.teams['A'])
        wait_until(lambda: len(self.fake.commits()) == 3, timeout=10)
        self.assertEqual(self.fake.commits()[0], 'SyncUp: DB 충돌 확인 필요')
        self.assertIn('확인이 필요한 결정', self.fake.files()['SYNCUP.md'])
        self.assert_public()


class GitHubVerify(unittest.TestCase):
    """The link check: the repository, the branch, then a write probe; a reason instead of every failure."""

    def setUp(self):
        self.fake = FakeGitHub()
        origin = self.enterContext(fake_github(self.fake))
        self.target = RepoTarget(uuid.uuid4(), 'team/repo', 'main', WEB_TOKEN, api=origin)

    def test_a_token_that_can_write_passes_in_three_calls(self):
        self.assertEqual(verify(self.target), (None, True))
        self.assertEqual([(m, p.split('/repos/team/repo')[1]) for m, p, *_ in self.fake.requests],
                         [('GET', ''), ('GET', '/git/ref/heads/main'), ('POST', '/git/blobs')])
        self.assertEqual(self.fake.commits(), ['init'])  # the probe moves no branch
        self.assertFalse(any(WEB_TOKEN in path + body for _, path, body, _ in self.fake.requests))
        self.fake.info['private'] = False
        self.assertEqual(verify(self.target), (None, False))

    def test_each_failure_has_its_reason(self):
        cases = [
            ('bad-token', None, lambda: setattr(self.fake, 'tokens', {OTHER_TOKEN})),
            ('not-found', None, lambda: self.fake.missing.add('team/repo')),
            ('no-branch', True, lambda: setattr(self.fake, 'branch', 'develop')),
            ('no-write', True, lambda: setattr(self.fake, 'refuse_blobs', 403)),
            ('no-write', True, lambda: self.fake.info.update(permissions=dict(push=False))),
            ('no-write', True, lambda: self.fake.info.update(archived=True)),
            ('rate-limited', None, lambda: setattr(self.fake, 'fail_next',
                                                   ('GET', '/repos/', 403, {'x-ratelimit-remaining': '0'}))),
            ('rate-limited', True, lambda: setattr(self.fake, 'fail_next', ('GET', '/git/ref/', 429))),
            ('unreachable', None, lambda: setattr(self.fake, 'fail_next', ('GET', '/repos/', 502))),
        ]
        for reason, private, arrange in cases:
            with self.subTest(reason=reason):
                self.fake = FakeGitHub()
                origin = self.enterContext(fake_github(self.fake))
                arrange()
                target = RepoTarget(self.target.team_id, 'team/repo', 'main', WEB_TOKEN, api=origin)
                self.assertEqual(verify(target), (reason, private))
                self.assertEqual(self.fake.commits(), ['init'])
        self.fake.info['permissions'] = dict(push=False)  # GitHub said no: no write probe is sent
        verify(RepoTarget(self.target.team_id, 'team/repo', 'main', WEB_TOKEN, api=origin))
        self.assertEqual(self.fake.sent('POST', '/git/blobs'), [])

    def test_no_permissions_field_still_probes_the_write(self):
        del self.fake.info['permissions']  # what a fine-grained token may see; the person's role is not the token's
        self.fake.refuse_blobs = 403
        self.assertEqual(verify(self.target), ('no-write', True))


class LinkChangeDuringSave(unittest.TestCase):
    """A save under way for one repository must not report its outcome as another's. The GitHub calls are replaced;
    the link bookkeeping, the save lock and the status are the real ones."""

    ROW = dict(repo='team/a', branch='main', token=WEB_TOKEN, private=True, linkedBy='u', linkedByName='Dana',
               linkedAt='2026-11-15T00:00:00+00:00')
    CHANGES = {
        'repository': lambda row: dict(row, repo='team/b'),
        'branch': lambda row: dict(row, branch='feat/sync'),
        'token': lambda row: dict(row, token=OTHER_TOKEN),
        'unlink': lambda row: None,
    }

    def setUp(self):
        self.team = uuid.uuid4()
        self.server = Server(None)
        repo_sync._remember(self.server, self.team, self.ROW)
        self.saved_to, self.started, self.release = [], threading.Event(), threading.Event()

        def held_save(target, build, message):
            self.saved_to.append((target.repo, target.branch))
            if len(self.saved_to) == 1:
                self.started.set()
                self.release.wait(5)
            return dict(sha=f'sha-{target.repo}-{len(self.saved_to)}', html_url=f'https://github.example/{target.repo}',
                        committer=dict(date='2026-11-15T00:00:00Z'))
        self.enterContext(patch.object(repo_sync, 'save', held_save))
        self.enterContext(patch.object(repo_sync, 'is_private', lambda target: True))  # never the real GitHub

    def save_in_background(self):
        job = repo_sync._Job('token')
        thread = threading.Thread(target=repo_sync._save_and_record,
                                  args=(self.server, RepoTarget(self.team, 'team/a', 'main', WEB_TOKEN), job))
        thread.start()
        self.assertTrue(self.started.wait(5))
        return thread

    def test_without_a_change_the_save_is_reported(self):  # the checks below would pass vacuously without this
        thread = self.save_in_background()
        self.release.set()
        thread.join(5)
        self.assertEqual((repo_status(self.server, self.team)['state'], repo_status(self.server, self.team)['commit']['sha']),
                         ('saved', 'sha-team/a-1'))

    def test_an_old_save_never_reports_on_the_new_link(self):
        for name, change in self.CHANGES.items():
            with self.subTest(change=name):
                self.setUp()
                thread = self.save_in_background()
                repo_sync._remember(self.server, self.team, change(self.ROW))
                self.release.set()
                thread.join(5)
                status = repo_status(self.server, self.team)
                if change(self.ROW) is None:
                    self.assertEqual(status, dict(linked=False))
                    continue
                self.assertEqual((status['state'], status.get('commit')), ('unknown', None), status)

    def test_a_to_b_and_back_to_a_still_drops_the_old_result(self):
        thread = self.save_in_background()
        repo_sync._remember(self.server, self.team, dict(self.ROW, repo='team/b'))
        repo_sync._remember(self.server, self.team, self.ROW)
        self.release.set()
        thread.join(5)
        self.assertEqual(repo_status(self.server, self.team)['state'], 'unknown')

    def test_rereading_the_same_link_keeps_the_status(self):
        thread = self.save_in_background()
        repo_sync._remember(self.server, self.team, dict(self.ROW))
        self.release.set()
        thread.join(5)
        self.assertEqual(repo_status(self.server, self.team)['state'], 'saved')

    def test_a_save_waiting_its_turn_goes_to_the_link_of_that_moment(self):
        first = self.save_in_background()  # holds the save lock
        second = threading.Thread(target=repo_sync._save_and_record,
                                  args=(self.server, RepoTarget(self.team, 'team/a', 'main', WEB_TOKEN),
                                        repo_sync._Job('token')))
        second.start()
        time.sleep(.1)  # the second save now waits for the lock, having been asked for team/a
        repo_sync._remember(self.server, self.team, dict(self.ROW, repo='team/b'))
        self.release.set()
        first.join(5)
        second.join(5)
        self.assertEqual(self.saved_to, [('team/a', 'main'), ('team/b', 'main')])
        status = repo_status(self.server, self.team)
        self.assertEqual((status['repo'], status['state'], status['commit']['sha']), ('team/b', 'saved', 'sha-team/b-2'))

    def test_unlinking_while_a_save_waits_its_turn_sends_nothing_more(self):
        first = self.save_in_background()
        second = threading.Thread(target=repo_sync._save_and_record,
                                  args=(self.server, RepoTarget(self.team, 'team/a', 'main', WEB_TOKEN),
                                        repo_sync._Job('token')))
        second.start()
        time.sleep(.1)
        repo_sync._remember(self.server, self.team, None)
        self.release.set()
        first.join(5)
        second.join(5)
        self.assertEqual(self.saved_to, [('team/a', 'main')])  # the save already sent still finishes (documented)
        self.assertEqual(repo_status(self.server, self.team), dict(linked=False))


class RepoLinkTeam(TeamIsolation):
    """Teams link their own repository from the web; team A's members link, team B stays out."""

    def setUp(self):
        super().setUp()
        self.fake = FakeGitHub()
        self.api.github_api = self.enterContext(fake_github(self.fake))
        self.api.repo_target = None
        self.enterContext(patch.object(repo_sync, 'SAVE_DELAY_SECONDS', .3))
        self.logged = self.enterContext(self.assertLogs('syncup', logging.WARNING))
        logging.getLogger('syncup').warning('start')  # assertLogs needs one record even when nothing fails

    def tearDown(self):
        for secret in (WEB_TOKEN, OTHER_TOKEN):
            self.assertFalse(any(secret in line for line in self.logged.output), self.logged.output)
        super().tearDown()

    def link(self, action='', data=None, user='Dana', team='A'):
        path = f"/teams/{self.teams[team]}/repo" + (f'/{action}' if action else '')
        status, body = request(self.api, 'POST', path, self.tokens[user], data if data is not None else {})
        for secret in (WEB_TOKEN, OTHER_TOKEN):
            self.assertNotIn(secret, body)
        return status, json.loads(body)

    def status(self, user='Dana', team='A'):
        status, body = request(self.api, 'GET', f"/teams/{self.teams[team]}/repo", self.tokens[user])
        self.assertEqual(status, 200, body)
        self.assertNotIn(WEB_TOKEN, body)
        return json.loads(body)['repo']

    def stored(self, team='A'):
        with psycopg.connect(self.admin_dsn) as c:
            return c.execute('SELECT repo,branch,token,private,active FROM syncup.team_repo_links WHERE team_id=%s',
                             (self.teams[team],)).fetchone()

    def share(self, identifier, content, user='Dana', team='A'):
        packet = dict(id=identifier, label='결정', text=content, quote='합성 인용', speaker='사용자', version=2,
                      card=dict(public_card('합성 인용'), content=content, tag='decision', topic_key='DB'))
        status, body = request(self.api, 'POST', self.path(team), self.tokens[user],
                               dict(packet=packet, approved_by=self.users[user], approved_at=time.time()))
        self.assertEqual(status, 200, body)

    def settled(self, timeout=10):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            status = self.status()
            if not status['pending'] and status['state'] != 'unknown':
                return status
            time.sleep(.05)
        self.fail('the repository save did not finish')

    def test_a_member_checks_links_and_the_team_saves_there(self):
        status, body = self.link('verify', dict(repo='https://github.com/team/repo.git', token=WEB_TOKEN))
        self.assertEqual((status, body['ok'], body['check']),
                         (200, True, dict(repo='team/repo', branch='main', private=True, canWrite=True)))
        self.assertNotIn('alternative', body)
        self.assertEqual((self.status(), self.stored()), (dict(linked=False), None))  # a check stores nothing
        status, body = self.link(data=dict(repo='team/repo', branch='main', token=WEB_TOKEN))
        self.assertEqual((status, body['ok']), (200, True))
        linked = body['repo']
        self.assertEqual({k: linked[k] for k in ('linked', 'repo', 'branch', 'source', 'tokenSet', 'private',
                                                 'linkedBy', 'linkedByName')},
                         dict(linked=True, repo='team/repo', branch='main', source='team', tokenSet=True, private=True,
                              linkedBy=self.users['Dana'], linkedByName='Dana'))
        self.assertEqual(self.stored(), ('team/repo', 'main', WEB_TOKEN, True, True))
        self.assertEqual(self.status('Alice')['linkedByName'], 'Dana')  # every member sees who linked it
        self.share('d1', 'DB = PostgreSQL')
        self.assertEqual(self.settled()['state'], 'saved')
        self.assertEqual(self.fake.commits()[0], 'SyncUp: DB 결정 추가 (Dana 승인)')
        self.assertEqual({auth for m, p, b, auth in self.fake.requests if '/git/commits' in p}, {'Bearer ' + WEB_TOKEN})
        self.assertEqual(self.status('Bob', 'B'), dict(linked=False))

    def test_a_public_repository_needs_consent_and_points_to_notion(self):
        self.fake.info['private'] = False
        status, body = self.link('verify', dict(repo='team/repo', token=WEB_TOKEN))
        self.assertEqual((body['ok'], body['check']['private'], body['alternative']), (True, False, 'notion'))
        status, body = self.link(data=dict(repo='team/repo', token=WEB_TOKEN))
        self.assertEqual((status, body['ok'], body['reason'], body['alternative']),
                         (200, False, 'public-needs-consent', 'notion'))
        self.assertIsNone(self.stored())
        self.assertEqual(self.link(data=dict(repo='team/repo', token=WEB_TOKEN, acceptPublic=False))[1]['reason'],
                         'public-needs-consent')
        status, body = self.link(data=dict(repo='team/repo', token=WEB_TOKEN, acceptPublic=True))
        self.assertEqual((body['ok'], body['repo']['private']), (True, False))

    def test_refusals_say_why_and_store_nothing(self):
        self.fake.tokens = {WEB_TOKEN}
        cases = [
            (dict(repo='not a repo', token=WEB_TOKEN), 'bad-format'),
            (dict(repo='team/repo', branch='a..b', token=WEB_TOKEN), 'bad-format'),
            (dict(repo='team/repo', token='short'), 'bad-format'),
            (dict(repo='team/repo', token='has space ' + WEB_TOKEN), 'bad-format'),
            (dict(repo='team/repo'), 'token-needed'),
            (dict(repo='team/repo', token=OTHER_TOKEN), 'bad-token'),
            (dict(repo='team/repo', branch='develop', token=WEB_TOKEN), 'no-branch'),
        ]
        for data, reason in cases:
            with self.subTest(reason=reason, data=data):
                status, body = self.link(data=data)
                self.assertEqual((status, body['ok'], body['reason']), (200, False, reason))
        self.fake.missing.add('team/secret')
        self.assertEqual(self.link(data=dict(repo='team/secret', token=WEB_TOKEN))[1]['reason'], 'not-found')
        self.fake.refuse_blobs = 403
        self.assertEqual(self.link(data=dict(repo='team/repo', token=WEB_TOKEN))[1]['reason'], 'no-write')
        self.assertIsNone(self.stored())
        for bad in (dict(repo='team/repo', token=WEB_TOKEN, owner='x'), dict(repo=3), dict(repo='team/repo', token=5),
                    dict(repo='team/repo', acceptPublic='yes')):
            with self.subTest(bad=bad):
                self.assertEqual(self.link(data=bad)[0], 400)
        self.assertEqual(self.link('unlink', dict(token=WEB_TOKEN))[0], 400)
        self.assertEqual(self.link('elsewhere', {})[0], 404)

    def test_relinking_reuses_the_token_only_for_the_same_repository(self):
        self.assertTrue(self.link(data=dict(repo='team/repo', token=WEB_TOKEN))[1]['ok'])
        self.fake.branch = 'feat/sync'
        status, body = self.link(data=dict(repo='team/repo', branch='feat/sync'), user='Alice')
        self.assertEqual((body['ok'], body['repo']['branch'], body['repo']['linkedByName']), (True, 'feat/sync', 'Alice'))
        self.assertEqual(self.stored()[:3], ('team/repo', 'feat/sync', WEB_TOKEN))
        self.assertEqual(self.link(data=dict(repo='other/repo', branch='feat/sync'))[1]['reason'], 'token-needed')
        self.assertEqual(self.link('verify', dict(repo='team/repo', branch='feat/sync'))[1]['ok'], True)

    def test_unlinking_clears_the_token_and_stops_saving(self):
        self.link(data=dict(repo='team/repo', token=WEB_TOKEN))
        self.share('d1', 'DB = PostgreSQL')
        self.settled()
        commits = len(self.fake.commits())
        status, body = self.link('unlink', {}, user='Alice')
        self.assertEqual((status, body['ok'], body['repo']), (200, True, dict(linked=False)))
        self.assertEqual(self.stored(), ('team/repo', 'main', '', True, False))
        self.share('d2', 'DB = SQLite')
        time.sleep(.8)
        self.assertEqual(len(self.fake.commits()), commits)
        self.assertEqual(self.status(), dict(linked=False))
        self.assertEqual(self.link('unlink', {})[1]['ok'], True)  # again: nothing to clear, still fine

    def test_the_team_link_wins_over_the_server_setting_and_unlinking_returns_to_it(self):
        self.api.repo_target = RepoTarget(uuid.UUID(self.teams['A']), 'admin/repo', 'main', TOKEN, api=self.api.github_api)
        self.assertEqual((self.status()['repo'], self.status()['source']), ('admin/repo', 'env'))
        self.link(data=dict(repo='team/repo', token=WEB_TOKEN))
        self.assertEqual((self.status()['repo'], self.status()['source']), ('team/repo', 'team'))
        self.link('unlink', {})
        self.assertEqual((self.status()['repo'], self.status()['source'], self.status()['linkedBy']),
                         ('admin/repo', 'env', None))

    def test_a_save_waiting_for_the_old_repository_goes_to_the_new_one(self):
        with patch.object(repo_sync, 'SAVE_DELAY_SECONDS', 1.5):
            self.link(data=dict(repo='team/old', token=WEB_TOKEN))
            self.share('d1', 'DB = PostgreSQL')
            self.link(data=dict(repo='team/new', token=WEB_TOKEN))
            self.settled()
        saved_to = {p.split('/')[3] for m, p, *_ in self.fake.requests if m == 'PATCH'}
        self.assertEqual(saved_to, {'new'})

    def test_a_private_link_that_became_public_stops_saving_until_consent(self):
        self.link(data=dict(repo='team/repo', token=WEB_TOKEN))
        self.share('d1', 'DB = PostgreSQL')
        self.assertEqual(self.settled()['state'], 'saved')
        reads = lambda: sum(m == 'GET' and p.endswith('/repos/team/repo') for m, p, *_ in self.fake.requests)  # noqa: E731
        before = reads()
        self.share('d2', 'DB = MySQL')  # within the cache time: the 'still private' answer is reused
        self.assertEqual(self.settled()['state'], 'saved')
        self.assertEqual(reads(), before)
        commits = len(self.fake.commits())
        self.fake.info['private'] = False  # someone made it public on GitHub
        with patch.object(repo_sync, 'VISIBILITY_CACHE_SECONDS', 0):
            self.share('d3', 'DB = SQLite', user='Alice')
            status = self.settled()
            self.assertEqual((status['state'], status['reason'], status['private']), ('blocked', 'became-public', True))
            self.assertEqual(len(self.fake.commits()), commits)
            self.fake.info['private'] = True
            self.fake.fail_next = ('GET', '/repos/', 502)  # visibility unknown: not committed, a normal failure
            self.share('d4', 'DB = Oracle')
            self.assertEqual(self.settled()['state'], 'failed')
            self.assertEqual(len(self.fake.commits()), commits)
            self.fake.info['private'] = False
            self.assertTrue(self.link(data=dict(repo='team/repo', token=WEB_TOKEN, acceptPublic=True))[1]['ok'])
            self.assertEqual((self.status()['state'], self.status()['private']), ('unknown', False))
            self.share('d5', 'DB = DuckDB')
            self.assertEqual(self.settled()['state'], 'saved')  # consented: public saves go on
        self.assertTrue(any('Alice 승인' in m for m in self.fake.commits()[:2]), self.fake.commits())  # the blocked batch's people are named in the next commit

    def test_other_teams_can_neither_read_nor_change_it_even_in_sql(self):
        self.link(data=dict(repo='team/repo', token=WEB_TOKEN))
        self.assertEqual(request(self.api, 'GET', f"/teams/{self.teams['A']}/repo", self.tokens['Bob'])[0], 403)
        self.assertEqual(self.link('unlink', {}, user='Bob')[0], 403)
        self.assertEqual(self.link(data=dict(repo='team/repo', token=OTHER_TOKEN), user='Bob')[0], 403)
        self.assertEqual(self.stored()[2], WEB_TOKEN)
        with self.team_db('Bob', 'B') as c:
            self.assertEqual(c.execute('SELECT * FROM syncup.team_repo_links').fetchall(), [])
        with self.team_db('Alice', 'A') as c:
            user = self.users['Alice']
            for query, args in [
                    ('INSERT INTO syncup.team_repo_links(team_id,repo,token,actor) VALUES(%s,%s,%s,%s)',
                     (self.teams['B'], 'evil/repo', OTHER_TOKEN, user)),
                    ('UPDATE syncup.team_repo_links SET repo=%s, actor=%s', ('evil/repo', self.users['Bob'])),
                    ('DELETE FROM syncup.team_repo_links', ())]:
                with self.subTest(query=query), self.assertRaises(psycopg.errors.InsufficientPrivilege), c.transaction():
                    c.execute(query, args)

    def test_github_is_called_outside_any_database_transaction(self):
        waiting = []

        def look():
            with psycopg.connect(self.admin_dsn) as c:
                waiting.append(c.execute("""SELECT count(*) FROM pg_stat_activity
                    WHERE usename='syncup_api' AND state LIKE 'idle in transaction%'""").fetchone()[0])
        self.fake.during = look
        self.assertTrue(self.link(data=dict(repo='team/repo', token=WEB_TOKEN))[1]['ok'])
        self.fake.during = None
        self.assertEqual(waiting, [0, 0, 0])  # the three link-check calls

    def test_the_web_links_through_the_local_relay_and_errors_never_echo_the_token(self):
        pipeline = types.SimpleNamespace(db=self.db, client=self.client)  # the collector's bound team is A
        result = team_relay.relay(pipeline, 'team.verifyRepo', dict(repo='team/repo', token=WEB_TOKEN))
        self.assertEqual((result['ok'], result['check']['canWrite']), (True, True))
        result = local_rpc.dispatch(pipeline, 'team.linkRepo', dict(repo='team/repo', token=WEB_TOKEN))
        self.assertEqual((result['ok'], result['repo']['source']), (True, 'team'))
        self.assertEqual(team_relay.relay(pipeline, 'team.repo', {})['repo']['repo'], 'team/repo')
        for bad in (dict(repo='team/repo', token=WEB_TOKEN, extra=WEB_TOKEN), dict(token=WEB_TOKEN, id=WEB_TOKEN)):
            with self.subTest(bad=sorted(bad)), self.assertRaises(ValueError) as caught:
                local_rpc.dispatch(pipeline, 'team.linkRepo', bad)
            self.assertNotIn(WEB_TOKEN, str(caught.exception))  # the local RPC answers str(error) to the web
        with self.assertRaises(OSError) as caught:  # the server's 400: the local RPC answers a fixed 503 text for it
            local_rpc.dispatch(pipeline, 'team.linkRepo', dict(repo=['team/repo'], token=WEB_TOKEN))
        self.assertNotIn(WEB_TOKEN, str(caught.exception) + repr(caught.exception))
        self.assertEqual(team_relay.relay(pipeline, 'team.unlinkRepo', {})['repo'], dict(linked=False))


def load_tests(loader, tests, pattern):
    plain = [loader.loadTestsFromTestCase(case) for case in (GitHubSave, SaveScheduling, GitHubVerify,
                                                             LinkChangeDuringSave)]
    return unittest.TestSuite([*plain, own_tests(RepoSyncTeam), own_tests(RepoLinkTeam)])


if __name__ == '__main__':
    unittest.main(verbosity=2)
