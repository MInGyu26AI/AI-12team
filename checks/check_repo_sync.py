"""Saving SYNCUP.md·syncup.json to GitHub: a local fake GitHub API and real PostgreSQL; no network, no real token."""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import json
import threading
import time
import types
import unittest
import uuid
from unittest.mock import patch

import repo_sync
import team_relay
from ai.syncup_ai.team_state import build_state
from check_team_integration import checked
from check_teams import TeamIsolation, own_tests, request
from conflict_scheduler import schedule
from fake_github import COMMIT_URL, FakeGitHub, fake_github, header_trap
from github_repo import GitHubError, blob_sha, save
from local_fixtures import public_card
from repo_sync import RepoTarget, commit_message, repo_status, schedule_save, target_from_env

TOKEN = 'synthetic-github-token-DO-NOT-LOG'
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

    def test_a_burst_of_approvals_is_one_public_commit(self):
        self.share('d1', 'DB = PostgreSQL')
        self.share('t1', '배포 페이지 만들기', tag='todo', topic='배포')
        status = self.settled()
        self.assertEqual(self.fake.commits(), ['SyncUp: DB 결정 추가 외 1건 (Dana 승인)', 'init'])
        self.assertEqual((status['state'], status['commit']['sha']), ('saved', self.fake.head))
        files = self.fake.files()
        self.assertIn('**DB**: DB = PostgreSQL', files['SYNCUP.md'])
        self.assertIn('`SU-1` 배포 페이지 만들기', files['SYNCUP.md'])
        self.assertEqual(json.loads(files['syncup.json'])['team'], dict(name='A팀', repo='team/repo'))
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


def load_tests(loader, tests, pattern):
    plain = [loader.loadTestsFromTestCase(case) for case in (GitHubSave, SaveScheduling)]
    return unittest.TestSuite([*plain, own_tests(RepoSyncTeam)])


if __name__ == '__main__':
    unittest.main(verbosity=2)
