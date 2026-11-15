"""Saving the team state to a Notion page: a local fake Notion API and real PostgreSQL; no network, no real token."""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import io
import json
import os
import threading
import time
import unittest
import uuid
from contextlib import nullcontext, redirect_stderr
from unittest.mock import patch

import psycopg

import notion_page
import notion_sync
import repo_sync
import team_relay
import team_server
from ai.syncup_ai.team_state import build_state, short_date, to_kst
from check_repo_sync import card, wait_until
from check_team_integration import checked
from check_teams import TeamIsolation, own_tests, request
from cloud_server import main as cloud_main, save_targets
from conflict_scheduler import schedule
from fake_github import FakeGitHub, fake_github, header_trap
from fake_notion import FakeNotion, fake_notion
from local_fixtures import public_card
from notion_page import NotionError, save
from notion_sync import NotionTarget, notion_status, page_blocks, page_from, target_from_env
from repo_sync import RepoTarget
from team_access import authorized

TOKEN = 'synthetic-notion-token-DO-NOT-LOG'
GITHUB_TOKEN = 'synthetic-github-token-DO-NOT-LOG'
PRIVATE_SENTENCE = 'PRIVATE_SENTENCE_SENTINEL_733'
PRIVATE_SOURCE = 'PRIVATE_SOURCE_SENTINEL_733'


def full_state():
    """Every section SYNCUP.md has: team criteria, open and resolved conflicts, decisions, todos and research."""
    cards = [card('d1', 'decision', 'DB = SQLite', state='superseded'), card('d2', 'decision', 'DB = PostgreSQL', at=2),
             dict(card('d3', 'decision', '확장 = 크롬 우선', topic='확장', at=3), subtopic='주제·목표', reason='시연 브라우저'),
             card('t1', 'todo', '배포 페이지 만들기', topic='배포', at=4), card('t2', 'todo', '발표 자료', topic='발표', at=5),
             card('r1', 'research', 'Notion API는 초당 3회', topic='노션', at=6)]
    conflicts = [dict(id='c1', topic_key='DB', judgement='충돌', cardA=cards[1], cardB=cards[2]),
                 dict(id='c2', topic_key='확장', judgement='변경', cardA=cards[2], cardB=cards[1], resolution='discuss'),
                 dict(id='c3', topic_key='DB', judgement='변경', cardA=cards[0], cardB=cards[1],
                      resolution='adopt-new', resolutionNote='팀 회의')]
    team = dict(name='A팀', goal='시연 완성', rules=['원문은 올리지 않는다'], repo='team/repo')
    return build_state(cards, conflicts, done=['t2'], team=team)


def plain(block):
    return ''.join(r['text']['content'] for r in block[block['type']]['rich_text'])


def runs(block):
    """(text, annotations) of each rich text item."""
    return [(r['text']['content'], r.get('annotations', {})) for r in block[block['type']]['rich_text']]


class PageBlocks(unittest.TestCase):
    """The page shows SYNCUP.md's sections as Notion blocks."""

    def test_the_sections_follow_syncup_md(self):
        blocks = page_blocks(full_state())
        outline = [(b['type'], plain(b).split('\n')[0]) for b in blocks]
        self.assertEqual(outline, [
            ('callout', 'SyncUp 팀 기록 — A팀'),
            ('heading_2', '팀 기준'), ('bulleted_list_item', '목표: 시연 완성'),
            ('bulleted_list_item', '규칙: 원문은 올리지 않는다'),
            ('heading_2', '⚠️ 확인이 필요한 결정'),
            ('bulleted_list_item', 'DB [충돌]: 기존 "DB = PostgreSQL"(?) ↔ 새 "확장 = 크롬 우선"(?)'),
            ('bulleted_list_item', '확장 [변경] (팀 논의 중): 기존 "확장 = 크롬 우선"(?) ↔ 새 "DB = PostgreSQL"(?)'),
            ('heading_2', '현재 결정'),
            ('heading_3', '주제·목표'), ('bulleted_list_item', '확장: 확장 = 크롬 우선 — 11/6'),
            ('heading_3', '작업·결과물'), ('bulleted_list_item', 'DB: DB = PostgreSQL — 11/6'),
            ('heading_2', '할 일'), ('to_do', 'SU-1 배포 페이지 만들기'), ('to_do', 'SU-2 발표 자료'),
            ('heading_2', '조사한 내용'), ('bulleted_list_item', 'Notion API는 초당 3회 (노션)'),
            ('heading_2', '최근 해결한 충돌')])
        header = plain(blocks[0])
        self.assertIn('기준 시각 2026-11-06T', header)
        self.assertRegex(header, '결정 2 · 열린 충돌 2 · 할 일 2 \\(완료 1\\) · 레포 team/repo · 지문 [0-9a-f]{16}$')
        self.assertEqual(runs(blocks[0])[-1], (header[-16:], {'code': True, 'color': 'gray'}))
        conflict, decided, db = blocks[5], blocks[9], blocks[11]
        self.assertEqual(runs(conflict)[2], ('[충돌]', {'bold': True, 'color': 'red'}))
        self.assertEqual(runs(blocks[6])[2], ('[변경]', {'bold': True, 'color': 'blue'}))
        self.assertEqual([plain(k) for k in conflict['bulleted_list_item']['children']],
                         ['이유: 다른 사람이 합의 없이 양립할 수 없는 값을 정함'])
        self.assertEqual([plain(k) for k in decided['bulleted_list_item']['children']], ['이유: 시연 브라우저'])
        history = db['bulleted_list_item']['children'][0]
        self.assertEqual(runs(history)[0], ('DB = SQLite', {'strikethrough': True}))
        self.assertTrue(plain(history).endswith('(바뀜)'))
        todo, done = blocks[13]['to_do'], blocks[14]['to_do']
        self.assertEqual((todo['checked'], done['checked']), (False, True))
        self.assertEqual(runs(blocks[13])[0], ('SU-1', {'code': True}))
        resolved = blocks[-1]['heading_2']
        self.assertTrue(resolved['is_toggleable'])
        self.assertEqual([plain(k) for k in resolved['children']], ['DB: 새 결정 채택 — 팀 회의'])

    def test_an_empty_team_and_the_review_mark(self):
        blocks = page_blocks(build_state([]))
        self.assertEqual([(b['type'], plain(b)) for b in blocks[1:]], [
            ('heading_2', '현재 결정'), ('paragraph', '(아직 승인된 결정이 없습니다)'),
            ('heading_2', '할 일'), ('paragraph', '(아직 승인된 할 일이 없습니다)')])
        reviewing = page_blocks(build_state([card('d1', 'decision', 'DB = PostgreSQL', state='review')]))
        self.assertEqual(runs(reviewing[3])[-1], (' (검토 중)', {'italic': True}))

    def test_long_text_is_split_into_items_notion_accepts(self):
        for content in ('가' * 4500, '가😀' * 1500):  # an emoji is two UTF-16 units
            with self.subTest(content=content[:2]):
                blocks = page_blocks(build_state([card('t1', 'todo', content, topic='배포')]))
                items = [text for text, _ in runs(blocks[-1])]
                self.assertTrue(all(len(text.encode('utf-16-le')) <= 4000 for text in items))
                self.assertEqual(''.join(items), 'SU-1 ' + content)

    def test_earlier_decisions_show_once_under_a_topic_like_syncup_md(self):
        state = build_state([card('d1', 'decision', 'DB = SQLite', state='superseded'),
                             card('d2', 'decision', 'DB = PostgreSQL', at=2),
                             card('d3', 'decision', 'DB = MySQL', state='review', at=3)])
        decisions = [b for b in page_blocks(state) if b['type'] == 'bulleted_list_item']
        self.assertEqual([plain(b).split(' — ')[0] for b in decisions], ['DB: DB = MySQL', 'DB: DB = PostgreSQL'])
        self.assertEqual([[plain(k) for k in b['bulleted_list_item'].get('children', [])] for b in decisions],
                         [[], ['DB = SQLite — 11/6 (바뀜)']])

    def test_the_mark_changes_with_any_content_and_only_then(self):
        def mark(state):
            return plain(page_blocks(state)[0])[-16:]
        self.assertEqual(mark(full_state()), mark(full_state()))
        reason = build_state([dict(card('d1', 'decision', 'DB = SQLite'), reason='가볍다')])
        other = build_state([dict(card('d1', 'decision', 'DB = SQLite'), reason='빠르다')])  # a child block only
        self.assertNotEqual(mark(reason), mark(other))
        self.assertEqual(page_blocks(reason)[3]['bulleted_list_item']['rich_text'],
                         page_blocks(other)[3]['bulleted_list_item']['rich_text'])


class NotionSave(unittest.TestCase):
    """Writing blocks to the fake Notion API: only what differs, within its limits."""

    def setUp(self):
        self.fake = FakeNotion(TOKEN)
        origin = self.enterContext(fake_notion(self.fake))
        self.target = NotionTarget(uuid.uuid4(), self.fake.page, TOKEN, api=origin)
        self.enterContext(patch.object(notion_page, 'REQUEST_INTERVAL_SECONDS', 0))

    def save(self, state, known=None):
        """(what the server keeps knowing about the page, whether anything was written); known=None: a fresh start."""
        known = {} if known is None else known
        return known, save(self.target, page_blocks(state), known)

    def methods_since(self, start):
        return [r[0] for r in self.fake.requests[start:]]

    def test_the_first_save_writes_the_page_in_one_request(self):
        written, wrote = self.save(full_state())
        self.assertTrue(wrote)
        self.assertEqual(self.methods_since(0), ['GET', 'PATCH'])
        lines = self.fake.outline()
        self.assertEqual(len(written), len(page_blocks(full_state())))
        self.assertIn('  bulleted_list_item: DB = SQLite — 11/6 (바뀜)', lines)
        self.assertIn('to_do: SU-2 발표 자료 ✓', lines)
        self.assertIn('  bulleted_list_item: DB: 새 결정 채택 — 팀 회의', lines)  # inside the toggle heading
        self.assertEqual(set(written), set(self.fake.top_ids()))

    def test_an_unchanged_page_is_read_but_never_written_even_after_a_restart(self):
        written, _ = self.save(full_state())
        for memory in (written, None):  # None: the server started again and remembers nothing
            with self.subTest(remembered=memory is not None):
                start = len(self.fake.requests)
                again, wrote = self.save(full_state(), memory and dict(memory))
                self.assertFalse(wrote)
                self.assertEqual(self.methods_since(start), ['GET'])
                self.assertEqual(again, written)

    def test_text_notion_keeps_differently_is_not_written_again_and_again(self):
        self.fake.stored_text = str.rstrip  # e.g. the header's line breaks
        written, _ = self.save(full_state())
        start = len(self.fake.requests)
        self.assertFalse(self.save(full_state(), written)[1])
        self.assertEqual(self.methods_since(start), ['GET'])

    def test_a_change_replaces_only_the_blocks_that_differ(self):
        cards = [card('d1', 'decision', 'DB = PostgreSQL'), card('t1', 'todo', '배포 페이지 만들기', topic='배포', at=2)]
        written, _ = self.save(build_state(cards))
        before = self.fake.top_ids()
        changed = build_state([*cards, card('t2', 'todo', '시연 영상', topic='발표', at=3)])
        start = len(self.fake.requests)
        now, wrote = self.save(changed, written)
        self.assertTrue(wrote)
        # the new header (its counts and mark) and the new to-do go in; only the old header goes out
        self.assertEqual(sorted(self.methods_since(start)), ['DELETE', 'GET', 'PATCH', 'PATCH'])
        after = self.fake.top_ids()
        self.assertEqual(set(before) - set(after), {before[0]})
        outline = self.fake.outline()
        self.assertTrue(outline[0].startswith('callout: ') and '할 일 2 (완료 0)' in outline[0])
        self.assertEqual(outline[-2:], ['to_do: SU-1 배포 페이지 만들기', 'to_do: SU-2 시연 영상'])
        self.assertEqual(set(now), set(after))
        self.assertFalse(self.save(changed, now)[1])

    def test_a_change_only_below_a_block_still_replaces_it(self):
        before = build_state([card('d2', 'decision', 'DB = PostgreSQL', at=2)])
        after = build_state([card('d1', 'decision', 'DB = SQLite', state='superseded'),
                             card('d2', 'decision', 'DB = PostgreSQL', at=2)])  # same counts and time: only a child
        known, _ = self.save(before)
        self.assertTrue(self.save(after, known)[1])
        self.assertEqual(self.fake.outline(), self.fresh_outline(after))
        self.save(before, {})
        self.assertTrue(self.save(after, {})[1])  # after a restart the header's mark tells them apart
        self.assertEqual(self.fake.outline(), self.fresh_outline(after))

    def test_many_blocks_go_in_several_requests_in_order(self):
        cards = [card(f't{n}', 'todo', f'할 일 {n}', topic='배포', at=n) for n in range(250)]
        written, _ = self.save(build_state(cards))
        appends = [json.loads(body) for _, _, body, *_ in self.fake.sent('PATCH')]
        self.assertEqual([len(a['children']) for a in appends], [100, 100, 54])  # header, 2 headings, a note, 250
        self.assertEqual(appends[0]['position'], {'type': 'start'})
        self.assertEqual(appends[1]['position']['type'], 'after_block')
        todos = [l for l in self.fake.outline() if l.startswith('to_do')]
        self.assertEqual(todos[:2] + todos[-1:], ['to_do: SU-1 할 일 0', 'to_do: SU-2 할 일 1', 'to_do: SU-250 할 일 249'])
        self.fake.page_size = 7  # the read pages through the children
        start = len(self.fake.requests)
        self.assertFalse(self.save(build_state(cards), written)[1])
        self.assertEqual(set(self.methods_since(start)), {'GET'})
        self.assertGreater(len(self.methods_since(start)), 30)

    def test_big_bodies_are_split_by_the_bytes_sent(self):
        cards = [card(f't{n}', 'todo', '한' * 1500, topic='배포', at=n) for n in range(300)]  # about 1.4MB in all
        self.assertTrue(self.save(build_state(cards))[1])
        sizes = [len(body.encode()) for _, _, body, _ in self.fake.sent('PATCH')]
        self.assertGreater(len(sizes), 3)
        self.assertLess(max(sizes), 500_000)
        self.assertEqual(len(self.fake.top_ids()), len(page_blocks(build_state(cards))))

    def test_a_write_refused_halfway_never_piles_blocks_up(self):
        state = build_state([card(f't{n}', 'todo', f'할 일 {n}', topic='배포', at=n) for n in range(250)])
        self.fake.fail_from = ('PATCH', 2, 400)  # the second append and every later one
        known = {}
        for _ in range(3):  # three changes in a row meet the same refusal
            with self.assertRaises(NotionError):
                save(self.target, page_blocks(state), known)
            self.assertEqual(len(self.fake.top_ids()), 100)
        first = self.fake.top_ids()
        self.fake.fail_from = None
        self.assertTrue(save(self.target, page_blocks(state), known))
        self.assertEqual(self.fake.outline(), self.fresh_outline(state))
        self.assertEqual(self.fake.top_ids()[:100], first)  # the part that went in is kept

    def test_other_blocks_on_the_page_stay(self):
        sub_page = self.fake.add_by_hand('child_page', '회의록')
        self.save(full_state())
        self.save(build_state([card('d9', 'decision', 'DB = SQLite')]))  # unknown blocks: every SyncUp block replaced
        self.assertIn(sub_page, self.fake.top_ids())
        self.assertFalse(self.fake.blocks[sub_page]['in_trash'])
        self.assertEqual(self.fake.outline()[-1], 'child_page: 회의록')

    def test_hand_edits_are_undone_block_by_block(self):
        written, _ = self.save(full_state())
        expected, ids = self.fake.outline(), self.fake.top_ids()
        self.fake.blocks[ids[3]]['in_trash'] = True  # deleted by hand
        self.fake.blocks[ids[9]]['body']['rich_text'][0]['plain_text'] = '고친 결정'  # edited by hand
        self.fake.add_by_hand('paragraph', '손으로 쓴 메모')
        start = len(self.fake.requests)
        self.assertTrue(self.save(full_state(), written)[1])
        self.assertEqual(self.fake.outline(), expected)
        self.assertEqual(sorted(self.methods_since(start)), ['DELETE', 'DELETE', 'GET', 'PATCH', 'PATCH'])

    def test_the_save_after_a_failed_one_puts_the_page_right(self):
        small = build_state([card('d9', 'decision', 'DB = SQLite')])
        for memory in ('kept', 'lost'):  # the server keeps what it wrote before; after a restart it knows nothing
            with self.subTest(memory=memory):
                written, _ = self.save(full_state())
                self.fake.fail_next = ('DELETE', '/blocks/', 400)  # fails after the new blocks went in
                with self.assertRaises(NotionError):
                    self.save(small, written)
                self.assertGreater(len(self.fake.top_ids()), len(page_blocks(small)))  # both versions on the page
                self.assertTrue(self.save(small, written if memory == 'kept' else None)[1])
                self.assertEqual(self.fake.outline(), self.fresh_outline(small))

    def fresh_outline(self, state):
        """The page an empty page gets for `state`."""
        fake = FakeNotion(TOKEN)
        with fake_notion(fake) as origin:
            save(NotionTarget(self.target.team_id, fake.page, TOKEN, api=origin), page_blocks(state), {})
        return fake.outline()

    def test_a_rate_limited_request_waits_for_retry_after_and_goes_again(self):
        self.fake.rate_limited = 1
        started = time.monotonic()
        self.assertTrue(self.save(full_state())[1])
        self.assertGreaterEqual(time.monotonic() - started, 1)  # Retry-After: 1
        self.assertEqual([m for m, *_ in self.fake.requests], ['GET', 'GET', 'PATCH'])

    def test_rate_limits_that_do_not_end_fail_without_waiting_long(self):
        self.fake.rate_limited, self.fake.retry_after = 99, '0'
        with self.assertRaises(NotionError) as caught:
            self.save(full_state())
        self.assertEqual((caught.exception.code, len(self.fake.requests)), (429, notion_page.RATE_LIMIT_RETRIES + 1))
        self.fake.rate_limited, self.fake.retry_after = 1, '3600'
        started = time.monotonic()
        with self.assertRaises(NotionError):
            self.save(full_state())
        self.assertLess(time.monotonic() - started, 1)

    def test_requests_keep_to_the_average_rate(self):
        starts, take_turn = [], notion_page._take_turn

        def recorded(longest=None):  # when each request may start, measured where it is sent rather than where it arrives
            took = take_turn(longest)
            starts.append(time.monotonic())
            return took
        with patch.object(notion_page, 'REQUEST_INTERVAL_SECONDS', .1), patch.object(notion_page, '_take_turn', recorded):
            self.save(build_state([card(f't{n}', 'todo', f'할 일 {n}', topic='배포', at=n) for n in range(5)]))
            self.save(build_state([]))
        self.assertEqual(len(starts), len(self.fake.requests))
        self.assertGreater(len(starts), 5)
        # A late wake-up shortens the next gap a little; the pace keeps the average and every gap stays close to it.
        self.assertTrue(all(later - earlier >= .08 for earlier, later in zip(starts, starts[1:])), starts)
        self.assertGreaterEqual((starts[-1] - starts[0]) / (len(starts) - 1), .095, starts)

    def test_server_errors_are_retried_for_reads_but_never_for_writes(self):
        self.fake.fail_next = ('GET', '/children', 502)
        self.assertTrue(self.save(full_state())[1])
        self.assertEqual([m for m, *_ in self.fake.requests], ['GET', 'GET', 'PATCH'])
        self.fake.fail_next = ('PATCH', '/children', 503)  # the write may have happened: never sent twice
        with self.assertRaises(NotionError) as caught:
            self.save(build_state([]))
        self.assertEqual((caught.exception.step, caught.exception.code), ('append', 503))
        self.assertEqual(len(self.fake.sent('PATCH')), 2)

    def test_the_token_goes_only_to_the_api_in_its_header(self):
        self.save(full_state())
        self.assertEqual({auth for *_, auth in self.fake.requests}, {'Bearer ' + TOKEN})
        self.assertFalse(any(TOKEN in path + body for _, path, body, *_ in self.fake.requests))
        self.assertNotIn(TOKEN, repr(self.target))
        origin, seen = self.enterContext(header_trap())
        self.fake.redirect_next = ('/children', origin + '/somewhere')
        with self.assertRaises(NotionError) as caught:
            self.save(full_state())
        self.assertEqual((seen, caught.exception.code), ([], 302))  # a redirect is refused, not followed
        self.assertNotIn(TOKEN, str(caught.exception) + repr(caught.exception))

    def test_a_page_not_shared_with_the_integration_is_a_404(self):
        target = NotionTarget(self.target.team_id, str(uuid.uuid4()), TOKEN, api=self.target.api)
        with self.assertRaises(NotionError) as caught:
            save(target, page_blocks(full_state()), {})
        self.assertEqual((caught.exception.step, caught.exception.code), ('read', 404))


class Settings(unittest.TestCase):
    FULL = dict(SYNCUP_NOTION_TEAM=str(uuid.UUID(int=7)), SYNCUP_NOTION_PAGE='0123456789abcdef0123456789ABCDEF',
                SYNCUP_NOTION_TOKEN=TOKEN)

    def test_all_three_or_none_and_errors_never_show_the_token(self):
        self.assertIsNone(target_from_env({}))
        target = target_from_env(self.FULL)
        self.assertEqual((target.team_id, target.page_id), (uuid.UUID(int=7), '01234567-89ab-cdef-0123-456789abcdef'))
        self.assertEqual(target_from_env(dict(self.FULL, SYNCUP_NOTION_PAGE='01234567-89ab-cdef-0123-456789abcdef')),
                         target)
        bad = [dict(SYNCUP_NOTION_TOKEN=''), dict(SYNCUP_NOTION_PAGE=''), dict(SYNCUP_NOTION_TEAM=''),
               dict(SYNCUP_NOTION_PAGE='https://www.notion.so/SyncUp-0123456789abcdef0123456789abcdef'),
               dict(SYNCUP_NOTION_PAGE='0123456789abcdef'), dict(SYNCUP_NOTION_TEAM='A팀'),
               dict(SYNCUP_NOTION_TOKEN=TOKEN + ' extra'), dict(SYNCUP_NOTION_TOKEN='short')]
        for change in bad:
            with self.subTest(change=change), self.assertRaises(ValueError) as caught:
                target_from_env(dict(self.FULL, **change))
            self.assertNotIn(TOKEN, str(caught.exception))

    def test_notion_and_github_are_set_apart(self):
        github = dict(SYNCUP_GITHUB_TEAM=str(uuid.UUID(int=8)), SYNCUP_GITHUB_REPO='team/repo',
                      SYNCUP_GITHUB_TOKEN=GITHUB_TOKEN)
        for env, expected in [(self.FULL, (False, True)), (github, (True, False)), ({**self.FULL, **github}, (True, True))]:
            with self.subTest(env=sorted(env)), patch.dict(os.environ, env, clear=True):
                self.assertEqual(tuple(t is not None for t in save_targets()), expected)

    def test_both_servers_refuse_to_start_with_part_of_the_settings(self):
        partial = dict(SYNCUP_DATABASE_URL='host=db.example.com sslmode=verify-full', SYNCUP_PUBLIC_HOST='x.example.com',
                       SYNCUP_NOTION_TEAM=str(uuid.UUID(int=7)), SYNCUP_NOTION_TOKEN=TOKEN)
        expected = 'SYNCUP_NOTION_TEAM·SYNCUP_NOTION_PAGE·SYNCUP_NOTION_TOKEN을 함께 설정하세요.'
        with patch.dict(os.environ, partial, clear=True), patch('cloud_server.verify_database') as verify:
            with self.assertRaises(SystemExit) as stop:
                cloud_main()
            self.assertEqual(str(stop.exception), expected)
            verify.assert_not_called()
            errors = io.StringIO()
            with patch('sys.argv', ['team_server.py']), patch('ai.syncup_ai.config.load_env'), \
                    patch('team_server.verify_database') as local_verify, redirect_stderr(errors), \
                    self.assertRaises(SystemExit) as stop:
                team_server.main()
            self.assertEqual(stop.exception.code, 2)
            self.assertIn(expected, errors.getvalue())
            self.assertNotIn(TOKEN, errors.getvalue())
            local_verify.assert_not_called()


class Server:
    """Just what notion_sync.schedule_save needs from a team server."""

    def __init__(self, target):
        self.notion_target, self.checks_stop = target, threading.Event()


class SaveScheduling(unittest.TestCase):
    def test_a_burst_waits_for_quiet_and_a_steady_stream_still_saves_within_the_longest_wait(self):
        team, saves = uuid.uuid4(), []
        server = Server(NotionTarget(team, str(uuid.uuid4()), TOKEN))
        with patch.object(repo_sync, 'SAVE_DELAY_SECONDS', .3), patch.object(repo_sync, 'SAVE_MAX_WAIT_SECONDS', .6), \
                patch.object(notion_sync, '_save_and_record', lambda server, target, job: saves.append(time.monotonic())):
            start = time.monotonic()
            while time.monotonic() - start < 1.5:
                notion_sync.schedule_save(server, 'token', team)
                time.sleep(.1)
            self.assertTrue(saves and saves[0] - start < 1.0, saves)
            wait_until(lambda: not notion_status(server, team)['pending'])
            done, other = len(saves), uuid.uuid4()
            notion_sync.schedule_save(server, 'token', other, delay=0)  # a team with no page
            time.sleep(.2)
            self.assertEqual((len(saves), notion_status(server, other)), (done, dict(linked=False)))
        self.assertLessEqual(len(saves), 3)


class NotionSyncTeam(TeamIsolation):
    """Team A is linked to the fake Notion page; team B is not."""

    def setUp(self):
        super().setUp()
        self.fake = FakeNotion(TOKEN)
        origin = self.enterContext(fake_notion(self.fake))
        self.api.notion_target = NotionTarget(uuid.UUID(self.teams['A']), self.fake.page, TOKEN, api=origin)
        self.enterContext(patch.object(repo_sync, 'SAVE_DELAY_SECONDS', .3))
        self.enterContext(patch.object(notion_page, 'REQUEST_INTERVAL_SECONDS', 0))

    def share(self, identifier, content, tag='decision', topic='DB', user='Dana', team='A'):
        shared = dict(public_card(PRIVATE_SENTENCE), content=content, tag=tag, topic_key=topic, source=PRIVATE_SOURCE)
        packet = dict(id=identifier, label='할 일' if tag == 'todo' else '결정', text=content, quote=PRIVATE_SENTENCE,
                      speaker='사용자', version=2, card=shared)
        envelope = dict(packet=packet, approved_by=self.users[user], approved_at=time.time())
        status, body = request(self.api, 'POST', self.path(team), self.tokens[user], envelope)
        self.assertEqual(status, 200, body)

    def notion(self, user='Dana', team='A'):
        status, body = request(self.api, 'GET', f"/teams/{self.teams[team]}/notion", self.tokens[user])
        self.assertEqual(status, 200, body)
        self.assertNotIn(TOKEN, body)
        return json.loads(body)['notion']

    def settled(self, timeout=10):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            status = self.notion()
            if not status['pending'] and status['state'] != 'unknown':
                return status
            time.sleep(.05)
        self.fail('the Notion save did not finish')

    def assert_private_stays_out(self):
        page = '\n'.join(self.fake.outline())
        for private in (PRIVATE_SENTENCE, PRIVATE_SOURCE, self.users['Dana'], self.users['Alice'], TOKEN):
            self.assertNotIn(private, page)

    def test_a_burst_of_approvals_is_one_page_write(self):
        self.share('d1', 'DB = PostgreSQL')
        self.share('t1', '배포 페이지 만들기', tag='todo', topic='배포')
        status = self.settled()
        self.assertEqual((status['linked'], status['page'], status['state']), (True, self.fake.page, 'saved'))
        self.assertIsInstance(status['savedAt'], float)
        self.assertEqual(len(self.fake.sent('PATCH')), 1)
        lines = self.fake.outline()
        self.assertEqual(lines[0].split('\n')[0], 'callout: SyncUp 팀 기록 — A팀')
        self.assertIn('bulleted_list_item: DB: DB = PostgreSQL — 테스트, ' + short_date(to_kst(time.time())), lines)
        self.assertIn('to_do: SU-1 배포 페이지 만들기 — 테스트', lines)
        self.assert_private_stays_out()
        self.assertEqual(self.notion('Bob', 'B'), dict(linked=False))

    def test_todo_checks_are_saved_and_an_unchanged_page_is_left_alone(self):
        self.share('t1', '배포 페이지 만들기', tag='todo', topic='배포')
        self.settled()
        self.assertEqual(self.team_request('POST', 'items/t1/done', dict(done=True))[0], 200)
        self.assertEqual(self.settled()['state'], 'saved')
        self.assertIn('to_do: SU-1 배포 페이지 만들기 — 테스트 ✓', self.fake.outline())
        writes = len(self.fake.sent('PATCH')) + len(self.fake.sent('DELETE'))
        notion_sync.schedule_save(self.api, self.tokens['Dana'], self.teams['A'], delay=0)  # a change that shows nowhere
        self.assertEqual(self.settled()['state'], 'unchanged')
        self.assertEqual(len(self.fake.sent('PATCH')) + len(self.fake.sent('DELETE')), writes)

    def test_a_notion_failure_is_reported_without_the_token_and_the_next_change_saves(self):
        self.fake.fail_next = ('GET', '/children', 404)  # e.g. the page is not shared with the integration
        with self.assertLogs('syncup', 'WARNING') as logs:
            self.share('d1', 'DB = PostgreSQL', user='Alice')
            status = self.settled()
        self.assertEqual((status['state'], status['httpStatus'], status['savedAt']), ('failed', 404, None))
        records = [json.loads(r.getMessage()) for r in logs.records]
        self.assertIn(dict(stage='notion_read', error='NotionError', http_status=404),
                      [{k: r[k] for k in ('stage', 'error', 'http_status')} for r in records])
        self.assertNotIn(TOKEN, '\n'.join(logs.output))
        self.assertEqual(self.fake.outline(), [])
        self.share('d2', '저장 위치 = 노션', topic='저장 위치')  # the next change saves everything
        self.assertEqual(self.settled()['state'], 'saved')
        self.assertIn('bulleted_list_item: DB: DB = PostgreSQL — 테스트, ' + short_date(to_kst(time.time())), self.fake.outline())

    def test_the_first_request_after_a_start_checks_the_page_once(self):
        self.share('d1', 'DB = PostgreSQL')
        self.settled()
        writes = len(self.fake.sent('PATCH'))
        notion_sync._servers.pop(self.api)  # a restart: nothing remembered
        self.assertEqual(notion_status(self.api, self.teams['A'])['state'], 'unknown')
        self.assertEqual(self.team_request('GET', 'board')[0], 200)  # any request, e.g. the board the web polls
        self.assertEqual(self.settled()['state'], 'unchanged')  # recognised by the header's mark, not rewritten
        self.assertEqual(len(self.fake.sent('PATCH')), writes)
        reads = len(self.fake.sent('GET'))
        self.team_request('GET', 'board')
        time.sleep(.2)
        self.assertEqual(len(self.fake.sent('GET')), reads)  # only once

    def test_github_and_notion_save_apart(self):
        github = FakeGitHub()
        origin = self.enterContext(fake_github(github))
        self.api.repo_target = RepoTarget(uuid.UUID(self.teams['A']), 'team/repo', 'main', GITHUB_TOKEN, api=origin)
        github.fail_next = ('GET', '/git/ref/', 403)
        self.share('d1', 'DB = PostgreSQL')
        self.assertEqual(self.settled()['state'], 'saved')
        wait_until(lambda: repo_sync.repo_status(self.api, self.teams['A']).get('state') == 'failed')
        self.assertIn('레포 team/repo', self.fake.outline()[0])
        self.fake.fail_next = ('PATCH', '/children', 400)
        self.share('d2', '저장 위치 = 노션', topic='저장 위치')
        self.assertEqual(self.settled()['state'], 'failed')
        wait_until(lambda: repo_sync.repo_status(self.api, self.teams['A']).get('state') == 'saved')
        self.assertNotIn(GITHUB_TOKEN, '\n'.join(self.fake.outline()))

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
        wait_until(lambda: 'heading_2: ⚠️ 확인이 필요한 결정' in self.fake.outline(), timeout=10)
        self.assertIn('  bulleted_list_item: 이유: 다른 사람이 합의 없이 양립할 수 없는 값을 정함', self.fake.outline())
        self.assert_private_stays_out()


# --- a team's own link from the web ---------------------------------------------------------------------------------
# Synthetic tokens, shaped unlike real Notion secrets (secret_…, ntn_…).
LINK_TOKEN = 'synthetic-team-link-token-DO-NOT-LOG'
OTHER_TOKEN = 'synthetic-other-team-token-DO-NOT-LOG'
READ_ONLY_TOKEN = 'synthetic-read-only-token-DO-NOT-LOG'


class PageAddress(unittest.TestCase):
    def test_a_page_id_or_a_notion_address_gives_the_page_id(self):
        hex_id = '0123456789abcdef0123456789ABCDEF'
        page = str(uuid.UUID(hex_id))
        for text in (hex_id, page, f' {page.upper()} ', f'https://www.notion.so/team/A-Title-{hex_id}?pvs=4',
                     f'https://www.notion.so/{hex_id}', f'https://team.notion.site/Title-{hex_id}/'):
            with self.subTest(text=text):
                self.assertEqual(page_from(text), page)
        for text in ('', 'not a page', hex_id[:-1], f'http://www.notion.so/{hex_id}', f'https://evil.example/{hex_id}',
                     f'https://notion.so.evil.example/{hex_id}', f'https://www.notion.so/{hex_id}x', 'https://[::1/x'):
            with self.subTest(text=text):
                self.assertIsNone(page_from(text))


class _Pipeline:
    db = None

    def __init__(self):
        self.sent = []
        self.client = self

    def request(self, path, data=None):
        self.sent.append((path, data))
        return dict(team_id='a', ok=True)


class NotionRelay(unittest.TestCase):
    """The collector passes the web's Notion link requests on, with only the fields the server takes."""

    def test_the_relay_sends_only_the_link_fields(self):
        pipeline = _Pipeline()
        with patch.object(team_relay, 'connect', lambda db: nullcontext()), \
                patch.object(team_relay, 'bound_team', lambda c: 'a'):
            team_relay.relay(pipeline, 'team.notion', {})
            team_relay.relay(pipeline, 'team.verifyNotion', dict(page='p', token=LINK_TOKEN))
            team_relay.relay(pipeline, 'team.linkNotion', dict(page='p'))
            team_relay.relay(pipeline, 'team.unlinkNotion', {})
            for method, bad in [('team.linkNotion', dict(page='p', team='b')), ('team.unlinkNotion', dict(page='p'))]:
                with self.subTest(method=method), self.assertRaisesRegex(ValueError, '노션 연결 필드 오류'):
                    team_relay.relay(pipeline, method, bad)
        self.assertEqual(pipeline.sent, [('teams/a/notion', None),
                                         ('teams/a/notion/verify', dict(page='p', token=LINK_TOKEN)),
                                         ('teams/a/notion', dict(page='p')), ('teams/a/notion/unlink', {})])


class NotionLinkTeam(TeamIsolation):
    """Teams link their own pages from the web; the server's environment link stays the fallback."""

    def setUp(self):
        super().setUp()
        self.fake = FakeNotion(TOKEN)
        self.origin = self.enterContext(fake_notion(self.fake))
        self.api.notion_api, self.api.notion_target = self.origin, None
        self.enterContext(patch.object(repo_sync, 'SAVE_DELAY_SECONDS', .3))
        self.enterContext(patch.object(notion_page, 'REQUEST_INTERVAL_SECONDS', 0))
        self.team_page = self.fake.new_page('A팀 결정 기록', LINK_TOKEN)
        self.raws = []  # every answer the API gave in this test
        self.forget_links()
        self.addCleanup(self.forget_links)

    def forget_links(self):
        with psycopg.connect(self.admin_dsn) as c:
            c.execute('DELETE FROM syncup.team_notion_links')
        notion_sync._links.pop(self.api, None)
        notion_sync._servers.pop(self.api, None)

    def link(self, action='', user='Dana', team='A', **body):
        path = f"/teams/{self.teams[team]}/notion" + (f'/{action}' if action else '')
        status, raw = request(self.api, 'POST', path, self.tokens[user], body)
        self.raws.append(raw)
        return status, json.loads(raw)

    def status(self, user='Dana', team='A'):
        status, raw = request(self.api, 'GET', f"/teams/{self.teams[team]}/notion", self.tokens[user])
        self.assertEqual(status, 200, raw)
        self.raws.append(raw)
        return json.loads(raw)['notion']

    def settled(self, user='Dana', team='A'):
        end = time.monotonic() + 10
        while time.monotonic() < end:
            status = self.status(user, team)
            if not status.get('pending') and status.get('state') != 'unknown':
                return status
            time.sleep(.05)
        self.fail('the Notion save did not finish')

    def share(self, identifier, content, user='Dana', team='A'):
        shared = dict(public_card(PRIVATE_SENTENCE), content=content, tag='decision', topic_key='DB', source=PRIVATE_SOURCE)
        packet = dict(id=identifier, label='결정', text=content, quote=PRIVATE_SENTENCE, speaker='사용자', version=2,
                      card=shared)
        envelope = dict(packet=packet, approved_by=self.users[user], approved_at=time.time())
        status, body = request(self.api, 'POST', self.path(team), self.tokens[user], envelope)
        self.assertEqual(status, 200, body)

    def rows(self):
        with psycopg.connect(self.admin_dsn) as c:
            return c.execute('SELECT team_id::text,page_id::text,token,active FROM syncup.team_notion_links').fetchall()

    def assert_token_stays_out(self):
        for raw in self.raws:
            for secret in (LINK_TOKEN, OTHER_TOKEN, READ_ONLY_TOKEN, TOKEN):
                self.assertNotIn(secret, raw)

    def test_a_check_names_each_refusal_and_stores_nothing(self):
        database = str(uuid.uuid4())
        self.fake.databases.add(database)
        read_only = self.fake.new_page('읽기만', READ_ONLY_TOKEN)
        self.fake.read_only.add(READ_ONLY_TOKEN)
        cases = [('bad-format', dict(page='페이지 아님', token=LINK_TOKEN)),
                 ('bad-format', dict(page=f'https://evil.example/{self.team_page.replace("-", "")}', token=LINK_TOKEN)),
                 ('bad-format', dict(page=self.team_page, token='짧은 토큰')),
                 ('token-needed', dict(page=self.team_page)),
                 ('bad-token', dict(page=self.team_page, token='synthetic-unknown-token-0000')),
                 ('not-found', dict(page=str(uuid.uuid4()), token=LINK_TOKEN)),
                 ('not-found', dict(page=self.fake.page, token=LINK_TOKEN)),  # exists, shared with another integration
                 ('not-a-page', dict(page=database, token=LINK_TOKEN)),
                 ('no-write', dict(page=read_only, token=READ_ONLY_TOKEN))]
        for reason, body in cases:
            for action in ('verify', ''):
                with self.subTest(reason=reason, action=action, body=body):
                    status, answer = self.link(action, **body)
                    self.assertEqual((status, answer['ok'], answer['reason']), (200, False, reason))
        self.fake.rate_limited = 1
        self.assertEqual(self.link('verify', page=self.team_page, token=LINK_TOKEN)[1]['reason'], 'rate-limited')
        self.fake.fail_next = ('GET', '/pages/', 500)
        self.assertEqual(self.link('verify', page=self.team_page, token=LINK_TOKEN)[1]['reason'], 'unreachable')
        status, answer = self.link('verify', page=self.team_page, token=LINK_TOKEN)
        self.assertEqual((status, answer['ok'], answer['check']),
                         (200, True, dict(page=self.team_page, title='A팀 결정 기록', canWrite=True)))
        self.assertEqual(self.fake.outline(self.team_page), [])  # the probe went to the trash again
        self.assertEqual(len(self.fake.sent('DELETE')), 1)
        self.assertEqual((self.rows(), self.status()), ([], dict(linked=False)))
        for bad in ({'page': self.team_page, 'name': 'x'}, {'page': 3}, {'page': self.team_page, 'token': 7}):
            with self.subTest(bad=bad):
                self.assertEqual(self.link('verify', **bad)[0], 400)
        self.assertEqual(self.link('other', page=self.team_page)[0], 404)
        self.assert_token_stays_out()

    def test_link_then_approve_saves_to_the_team_page_and_unlink_stops_it(self):
        address = f'https://www.notion.so/team/A-{self.team_page.replace("-", "")}?pvs=4'
        status, answer = self.link(page=address, token=LINK_TOKEN)
        self.assertEqual((status, answer['ok']), (200, True), answer)
        notion = answer['notion']
        self.assertEqual({k: notion[k] for k in ('linked', 'page', 'title', 'source', 'tokenSet', 'linkedBy')},
                         dict(linked=True, page=self.team_page, title='A팀 결정 기록', source='team', tokenSet=True,
                              linkedBy=self.users['Dana']))
        self.assertTrue(notion['linkedByName'] and notion['linkedAt'])
        self.assertEqual(self.settled()['state'], 'saved')  # written at once, before any change
        self.assertEqual(self.fake.outline(self.team_page)[0].split('\n')[0], 'callout: SyncUp 팀 기록 — A팀')
        self.share('d1', 'DB = PostgreSQL')
        wait_until(lambda: any(line.startswith('bulleted_list_item: DB: DB = PostgreSQL')
                               for line in self.fake.outline(self.team_page)))
        self.assertEqual(self.settled('Alice')['state'], 'saved')  # every member sees the team's link
        self.assertEqual(self.fake.outline(), [])  # the environment's page is not this team's

        status, answer = self.link('unlink', user='Alice')
        self.assertEqual((status, answer['ok'], answer['notion']), (200, True, dict(linked=False)))
        self.assertEqual(self.rows(), [(self.teams['A'], self.team_page, '', False)])  # the token is gone
        writes = len(self.fake.sent('PATCH'))
        self.share('d2', 'DB = MySQL')
        time.sleep(.8)
        self.assertEqual((len(self.fake.sent('PATCH')), self.status()), (writes, dict(linked=False)))
        self.assertEqual(self.link('verify', page=self.team_page)[1]['reason'], 'token-needed')  # not kept anywhere
        self.assert_private_and_token_stay_out()

    def assert_private_and_token_stay_out(self):
        self.assert_token_stays_out()
        for page in (self.team_page, self.fake.page):
            text = '\n'.join(self.fake.outline(page))
            for secret in (PRIVATE_SENTENCE, PRIVATE_SOURCE, LINK_TOKEN, TOKEN):
                self.assertNotIn(secret, text)

    def test_a_kept_token_is_reused_only_for_the_same_page(self):
        self.assertTrue(self.link(page=self.team_page, token=LINK_TOKEN)[1]['ok'])
        self.assertTrue(self.link('verify', page=self.team_page)[1]['ok'])
        other = self.fake.new_page('다른 페이지', LINK_TOKEN)
        self.assertEqual(self.link('verify', page=other)[1]['reason'], 'token-needed')
        self.assertEqual(self.link(page=other)[1]['reason'], 'token-needed')
        self.assertEqual(self.status()['page'], self.team_page)
        self.assert_token_stays_out()

    def test_the_environment_page_is_the_fallback_and_a_team_link_wins(self):
        self.api.notion_target = NotionTarget(uuid.UUID(self.teams['A']), self.fake.page, TOKEN, api=self.origin)
        self.assertEqual(self.status()['source'], 'env')
        self.share('d1', 'DB = PostgreSQL')
        wait_until(lambda: any('DB = PostgreSQL' in line for line in self.fake.outline()))
        self.assertEqual(self.settled()['source'], 'env')
        self.assertTrue(self.link(page=self.team_page, token=LINK_TOKEN)[1]['ok'])
        self.assertEqual(self.settled()['source'], 'team')
        self.share('d2', '저장 위치 = 팀 노션', user='Alice')
        wait_until(lambda: any('저장 위치 = 팀 노션' in line for line in self.fake.outline(self.team_page)))
        self.assertFalse(any('저장 위치 = 팀 노션' in line for line in self.fake.outline()))
        status, answer = self.link('unlink')
        self.assertEqual((answer['notion']['source'], answer['notion']['page']), ('env', self.fake.page))
        self.assertEqual(self.link('unlink')[1]['notion']['source'], 'env')  # the environment link cannot be unlinked
        self.share('d3', '발표 = 일요일')
        wait_until(lambda: any('발표 = 일요일' in line for line in self.fake.outline()))
        self.assertEqual(self.settled()['source'], 'env')
        self.assert_private_and_token_stay_out()

    def test_another_team_is_untouched_and_cannot_link_or_read(self):
        b_page = self.fake.new_page('B팀 기록', OTHER_TOKEN)
        for action in ('verify', '', 'unlink'):
            with self.subTest(action=action):
                body = {} if action == 'unlink' else dict(page=b_page, token=OTHER_TOKEN)
                self.assertEqual(self.link(action, user='Bob', team='A', **body)[0], 403)
        self.assertEqual(self.fake.sent('GET', '/pages/'), [])  # refused before Notion is asked
        self.assertTrue(self.link(page=self.team_page, token=LINK_TOKEN)[1]['ok'])
        self.assertEqual(self.status('Bob', 'B'), dict(linked=False))
        self.assertTrue(self.link(user='Bob', team='B', page=b_page, token=OTHER_TOKEN)[1]['ok'])
        self.assertEqual((self.status()['page'], self.status('Bob', 'B')['page']), (self.team_page, b_page))
        self.settled('Bob', 'B')
        self.assertEqual(self.link('unlink', user='Bob', team='B')[1]['notion'], dict(linked=False))
        self.assertEqual(self.status()['page'], self.team_page)
        self.assertTrue(self.link(user='Bob', team='B', page=b_page, token=OTHER_TOKEN)[1]['ok'])
        with authorized(self.api_dsn, self.tokens['Alice'], self.teams['A']) as (c, user):
            seen = c.execute('SELECT team_id::text FROM syncup.team_notion_links').fetchall()
            self.assertEqual([row['team_id'] for row in seen], [self.teams['A']])
            for query, args in [('INSERT INTO syncup.team_notion_links(team_id,page_id,token,actor) VALUES(%s,%s,%s,%s)',
                                 (self.teams['B'], self.team_page, 'synthetic-forged-token-000000', user)),
                                ('UPDATE syncup.team_notion_links SET token=%s, actor=%s',
                                 ('synthetic-forged-token-000000', self.users['Bob'])),
                                ('DELETE FROM syncup.team_notion_links', ())]:
                with self.subTest(query=query), self.assertRaises(psycopg.errors.InsufficientPrivilege), c.transaction():
                    c.execute(query, args)
        self.assertEqual(sorted((r[0], r[1]) for r in self.rows()),
                         sorted([(self.teams['A'], self.team_page), (self.teams['B'], b_page)]))
        self.assert_token_stays_out()

    def test_the_token_stays_out_of_answers_logs_and_diagnostics(self):
        self.assertTrue(self.link(page=self.team_page, token=LINK_TOKEN)[1]['ok'])
        self.settled()
        self.fake.fail_next = ('PATCH', '/children', 400)
        with self.assertLogs('syncup', 'WARNING') as logs, redirect_stderr(io.StringIO()) as err:
            self.share('d1', 'DB = PostgreSQL')
            self.assertEqual(self.settled()['state'], 'failed')
            self.link('verify', page=self.team_page, token='synthetic-unknown-token-0000')
        self.assertNotIn(LINK_TOKEN, '\n'.join(logs.output) + err.getvalue())
        sent = [r for r in self.fake.requests if r[3] == 'Bearer ' + LINK_TOKEN]
        self.assertTrue(sent)  # the token went to Notion, in its header, and nowhere else
        self.assertTrue(all(LINK_TOKEN not in r[1] + r[2] for r in sent))
        self.assert_private_and_token_stay_out()


def load_tests(loader, tests, pattern):
    plain_cases = [loader.loadTestsFromTestCase(case)
                   for case in (PageBlocks, NotionSave, Settings, SaveScheduling, PageAddress, NotionRelay)]
    return unittest.TestSuite([*plain_cases, own_tests(NotionSyncTeam, NotionLinkTeam)])


if __name__ == '__main__':
    unittest.main(verbosity=2)
