"""Account sync intake (docs/sync-contract.md 3장): accountSync settings, sync windows, turns.append for origin 'sync'.

Real SQLite with the shared pipeline fixture and fake AI; no external calls.
"""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
from datetime import datetime, timezone
import json
import math
import time

from ai.syncup_ai.batch import group_turns
from batch_queue import unbatched_turns
from collection_settings import configure, read_options, sync_windows, write_options
from collection_status import collection_status
from local_fixtures import PipelineFixture
from local_rpc import dispatch
from storage import connect
import turn_intake

ACCOUNT = '0123456789abcdef' * 4
OTHER_ACCOUNT = 'f' * 64
COUNTS = ('outsideWindow', 'skippedTurns', 'newTurns', 'teamRecordSkipped', 'elsewhereDuplicates')
# Keys a screen-path message is stored with, before and after this change.
SCREEN_KEYS = set(turn_intake.MESSAGE_FIELDS) | {'roleGuessed', 'session', 'masked'}


def iso(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat()


def iso_ms(seconds):
    """As the extension writes times: new Date(ms).toISOString()."""
    return datetime.fromtimestamp(seconds, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def seconds(text):
    return datetime.fromisoformat(text).timestamp()


class SyncFixture(PipelineFixture):
    """The pipeline fixture with the session started an hour ago at a whole second (self.base)."""
    def setUp(self):
        super().setUp()
        self.base = math.floor(time.time()) - 3600
        with connect(self.db) as c:
            c.execute('UPDATE settings SET start=?', (self.base,))

    def turn_on(self, since):
        """Account sync on since the given time, as collection.configure stores it."""
        with connect(self.db) as c:
            options = read_options(c)
            options['accountSync'] = dict(enabled=True, account=ACCOUNT, since=since)
            write_options(c, options)

    def pause(self, start, end=None):
        with connect(self.db) as c:
            c.execute('INSERT INTO pauses(start,end) VALUES(?,?)', (start, end))

    def sync(self, identifier, role, at, turn, conversation='conv', text=None):
        """An account sync message as the extension sends it (collectedAt = createdAt)."""
        return dict(id='chatgpt:' + identifier, site='chatgpt', conversationId=conversation, role=role,
                    roleGuessed=False, text=text or f'{identifier} 동기화 원문', origin='sync',
                    createdAt=iso_ms(at), collectedAt=iso_ms(at), turnId=turn)

    def sync_turn(self, turn, at, answer_at=None, conversation='conv', answer_text=None):
        """Question chatgpt:<turn> and one answer chatgpt:<turn>-a."""
        return [self.sync(turn, 'user', at, turn, conversation),
                self.sync(turn + '-a', 'assistant', at + 1 if answer_at is None else answer_at, turn, conversation,
                          answer_text)]

    def screen(self, identifier, role, conversation='conv', text=None, **fields):
        """A screen-path message as the extension sends it today (no origin, createdAt or turnId)."""
        return dict(id='chatgpt:' + identifier, site='chatgpt', conversationId=conversation, role=role,
                    roleGuessed=False, text=text or f'{identifier} 화면 본문',
                    collectedAt=datetime.now(timezone.utc).isoformat(), **fields)

    def stored(self):
        """{message id: (stored message, job)} of every intake row."""
        with connect(self.db) as c:
            rows = c.execute('SELECT message,job FROM intake ORDER BY rowid').fetchall()
        return {json.loads(r['message'])['id']: (json.loads(r['message']), r['job']) for r in rows}

    def count(self, sql):
        with connect(self.db) as c:
            return c.execute(sql).fetchone()[0]


class ScreenPath(SyncFixture):
    """The screen path keeps its old behaviour, also while account sync is on."""
    def test_screen_call_answers_and_stores_as_before(self):
        self.turn_on(self.base + 600)
        response = turn_intake.append(self.pipeline, [self.screen('q', 'user'),
                                                      self.screen('a', 'assistant', conversationTitle='제목')])
        self.assertEqual(set(response), {'newMessages', 'queued', 'intakeIssues', *COUNTS})
        self.assertEqual((response['newMessages'], response['queued'], response['intakeIssues']), (2, True, []))
        self.assertEqual([response[k] for k in COUNTS], [0, 0, 0, 0, 0])
        stored = self.stored()
        for message, job in stored.values():
            self.assertEqual(set(message), SCREEN_KEYS, 'no origin, createdAt, turnId or other extra field')
            self.assertIsNotNone(job, 'the answered turn is batched as before')

    def test_changed_screen_resend_is_still_quarantined(self):
        turn_intake.append(self.pipeline, [self.screen('q', 'user')])
        changed = turn_intake.append(self.pipeline, [self.screen('q', 'user', text='다른 본문')])
        self.assertEqual([i['reason'] for i in changed['intakeIssues']], ['message_changed'])
        explicit = turn_intake.append(self.pipeline, [self.screen('q', 'user', text='또 다른 본문', origin='screen')])
        self.assertEqual([i['reason'] for i in explicit['intakeIssues']], ['message_changed'],
                         "no origin and 'screen' are the same origin")


class OptionalFields(SyncFixture):
    def test_bad_optional_fields_are_quarantined(self):
        self.turn_on(self.base)
        good = self.sync('ok', 'user', self.base + 900, 'ok')
        cases = {
            'unknown origin': dict(good, origin='web'),
            'null origin': dict(good, origin=None),
            'createdAt without time zone': dict(good, createdAt='2026-11-13T10:00:00'),
            'createdAt not a string': dict(good, createdAt=1700000000),
            'createdAt not a time': dict(good, createdAt='어제'),
            'empty turnId': dict(good, turnId=''),
            'long turnId': dict(good, turnId='t' * 1201),
            'turnId not a string': dict(good, turnId=7),
            'sync without createdAt': {k: v for k, v in good.items() if k != 'createdAt'},
            'sync without turnId': {k: v for k, v in good.items() if k != 'turnId'},
            'sync from manual input': dict(good, site='manual'),
            'sync from an export file': dict(good, site='chatgpt-export'),
            'screen with a bad createdAt': self.screen('s', 'user', createdAt='2026-11-13 10:00'),
        }
        for name, message in cases.items():
            with self.subTest(name):
                response = turn_intake.append(self.pipeline, [dict(message, id='chatgpt:' + name)])
                self.assertEqual([i['reason'] for i in response['intakeIssues']], ['invalid_message'])
                self.assertEqual(response['newMessages'], 0)
        self.assertEqual(self.count('SELECT count(*) FROM intake'), 0)

    def test_valid_optional_fields_are_kept_only_when_sent(self):
        message = self.screen('s', 'user', origin='screen', createdAt='2026-11-13T19:00:00+09:00', turnId='t' * 1200)
        self.assertEqual(turn_intake.append(self.pipeline, [message])['intakeIssues'], [])
        saved = self.stored()['chatgpt:s'][0]
        self.assertEqual((saved['origin'], saved['createdAt'], saved['turnId']), ('screen', message['createdAt'], 't' * 1200))


class AccountSyncSettings(SyncFixture):
    def configure_sync(self, **value):
        return dispatch(self.pipeline, 'collection.configure', dict(accountSync=value))

    def test_never_turned_on(self):
        status = collection_status(self.pipeline)
        self.assertIsNone(status['accountSync'])
        self.assertEqual(status['syncWindows'], [])
        self.assertIsNone(self.configure_sync(enabled=False)['accountSync'], 'turning off stays never turned on')

    def test_turn_on_again_off_and_on(self):
        before = time.time()
        status = self.configure_sync(enabled=True, account=ACCOUNT)
        state = status['accountSync']
        self.assertEqual((state['enabled'], state['account']), (True, ACCOUNT))
        since = seconds(state['since'])
        self.assertTrue(before <= since <= time.time())
        self.assertEqual(len(status['syncWindows']), 1)
        self.assertTrue(0 <= seconds(status['syncWindows'][0]['start']) - since < .001)

        again = self.configure_sync(enabled=True, account=OTHER_ACCOUNT)['accountSync']
        self.assertEqual(again, dict(enabled=True, account=OTHER_ACCOUNT, since=state['since']),
                         'already on: the account changes, the consent time stays')

        off = self.configure_sync(enabled=False)
        self.assertEqual(off['accountSync'], dict(enabled=False, account=OTHER_ACCOUNT, since=None))
        self.assertEqual(off['syncWindows'], [])

        before_again = time.time()
        on_again = self.configure_sync(enabled=True, account=ACCOUNT)['accountSync']
        self.assertGreaterEqual(seconds(on_again['since']), before_again, 'turned on again: a new consent time')

    def test_bad_values_change_nothing(self):
        accounts = {'upper case': 'ABCDEF' + 'a' * 58, 'too short': 'a' * 63, 'too long': 'a' * 65,
                    'not hex': 'g' * 64, 'not a string': 123, 'missing': None}
        shapes = {'not an object': 'on', 'empty': {}, 'enabled not bool': dict(enabled=1, account=ACCOUNT),
                  'extra field': dict(enabled=True, account=ACCOUNT, since=0)}
        cases = [(name, dict(enabled=True, **({} if value is None else dict(account=value))), '동기화 계정 오류')
                 for name, value in accounts.items()]
        cases += [(name, value, '동기화 설정 오류') for name, value in shapes.items()]
        for name, value, error in cases:
            with self.subTest(name), self.assertRaisesRegex(ValueError, error):
                configure(self.pipeline, dict(projectTopic='바뀐 주제', accountSync=value))
        status = collection_status(self.pipeline)
        self.assertIsNone(status['accountSync'])
        self.assertEqual(status['projectTopic'], 'SyncUp', 'a rejected patch changes no other setting')


class Windows(SyncFixture):
    """sync_windows on fixed session times T .. T+1000."""
    T = 1_800_000_000

    def windows(self, start=T, end=T + 1000):
        with connect(self.db) as c:
            c.execute('UPDATE settings SET start=?,end=?', (start, end))
            return sync_windows(c, c.execute('SELECT * FROM settings').fetchone())

    def test_off_is_empty(self):
        self.assertEqual(self.windows(), [])
        self.turn_on(self.T)
        configure(self.pipeline, dict(accountSync=dict(enabled=False)))
        self.assertEqual(self.windows(), [])

    def test_turned_on_after_or_before_the_session_start(self):
        self.turn_on(self.T + 100)
        self.assertEqual(self.windows(), [(self.T + 100, self.T + 1000)])
        self.turn_on(self.T - 500)
        self.assertEqual(self.windows(), [(self.T, self.T + 1000)])
        self.turn_on(self.T + 2000)
        self.assertEqual(self.windows(), [], 'turned on after the end')

    def test_closed_and_open_pauses(self):
        self.turn_on(self.T + 100)
        self.pause(self.T + 200, self.T + 300)
        self.assertEqual(self.windows(), [(self.T + 100, self.T + 200), (self.T + 300, self.T + 1000)])
        self.pause(self.T + 400)
        self.assertEqual(self.windows(), [(self.T + 100, self.T + 200), (self.T + 300, self.T + 400)],
                         'a pause without an end runs on')

    def test_pauses_before_consent_and_empty_pieces(self):
        self.turn_on(self.T + 100)
        self.pause(self.T + 50, self.T + 100)
        self.pause(self.T + 100, self.T + 150)
        self.pause(self.T + 500, self.T + 600)
        self.pause(self.T + 600, self.T + 700)
        self.assertEqual(self.windows(), [(self.T + 150, self.T + 500), (self.T + 700, self.T + 1000)])

    def test_bounds_move_inward_to_whole_milliseconds(self):
        self.turn_on(self.T - 1)
        self.assertEqual(self.windows(self.T + .0004, self.T + 999.9996), [(self.T + .001, self.T + 999.999)])

    def test_extended_end_leaves_the_gap_out(self):
        now = math.floor(time.time())
        with connect(self.db) as c:
            c.execute('UPDATE settings SET start=?,end=?', (now - 100, now - 50))
        self.turn_on(now - 100)
        configure(self.pipeline, dict(endsAt=iso(now + 600)))
        with connect(self.db) as c:
            gap_end = c.execute('SELECT end FROM pauses').fetchone()[0]
            first, second = sync_windows(c, c.execute('SELECT * FROM settings').fetchone())
        self.assertEqual(first, (now - 100, now - 50))
        self.assertTrue(0 <= second[0] - gap_end < .001)
        self.assertEqual(second[1], now + 600)

    def test_status_reports_iso_windows(self):
        self.turn_on(self.T + 100)
        self.pause(self.T + 200, self.T + 300)
        self.windows()
        self.assertEqual(collection_status(self.pipeline)['syncWindows'],
                         [dict(start=iso(self.T + 100), end=iso(self.T + 200)),
                          dict(start=iso(self.T + 300), end=iso(self.T + 1000))])


class WindowBoundaries(SyncFixture):
    """turns.append with windows [base+600, base+1200) and [base+1800, end): consent at +600, a pause +1200..+1800."""
    def setUp(self):
        super().setUp()
        self.turn_on(self.base + 600)
        self.pause(self.base + 1200, self.base + 1800)

    def append(self, *turns):
        return turn_intake.append(self.pipeline, [m for t in turns for m in t])

    def assert_counts(self, response, outside, new):
        self.assertEqual((response['outsideWindow'], response['newTurns'], response['skippedTurns']), (outside, new, 0))
        self.assertEqual(response['intakeIssues'], [], 'outside turns are not quarantined')

    def test_start_is_inside_and_end_is_outside(self):
        b = self.base
        response = self.append(self.sync_turn('at-start', b + 600), self.sync_turn('at-end', b + 1199, b + 1200),
                               self.sync_turn('second-start', b + 1800))
        self.assert_counts(response, 1, 2)
        self.assertEqual(set(self.stored()), {'chatgpt:at-start', 'chatgpt:at-start-a',
                                              'chatgpt:second-start', 'chatgpt:second-start-a'})

    def test_before_consent_and_during_a_pause_are_outside(self):
        response = self.append(self.sync_turn('before', self.base + 100), self.sync_turn('paused', self.base + 1300))
        self.assert_counts(response, 2, 0)
        self.assertEqual(response['newMessages'], 0)
        self.assertEqual(self.count('SELECT count(*) FROM intake'), 0)

    def test_a_turn_across_two_windows_is_outside(self):
        self.assert_counts(self.append(self.sync_turn('across', self.base + 1100, self.base + 1900)), 1, 0)

    def test_the_earliest_and_latest_message_decide(self):
        late_question = self.sync_turn('late-question', self.base + 700, self.base + 699)
        self.assert_counts(self.append(late_question), 0, 1)
        self.assert_counts(self.append(self.sync_turn('early-answer', self.base + 601, self.base + 599)), 1, 0)

    def test_sync_off_keeps_every_turn_out(self):
        configure(self.pipeline, dict(accountSync=dict(enabled=False)))
        self.assert_counts(self.append(self.sync_turn('off', self.base + 700)), 1, 0)


class ScreenOverlap(SyncFixture):
    """C4-b: a sync turn the screen path may already have."""
    def setUp(self):
        super().setUp()
        self.turn_on(self.base)
        self.at = self.base + 900

    def skipped(self, response):
        return response['skippedTurns'], response['newMessages'], response['newTurns']

    def test_screen_turn_with_an_answer_is_skipped(self):
        configure(self.pipeline, dict(turnsPerBatch=10))
        turn_intake.append(self.pipeline, [self.screen('X', 'user'), self.screen('first-node', 'assistant')])
        response = turn_intake.append(self.pipeline, self.sync_turn('X', self.at))
        self.assertEqual(self.skipped(response), (1, 0, 0))
        self.assertEqual(set(self.stored()), {'chatgpt:X', 'chatgpt:first-node'},
                         'skipped even when the screen answer has another id')

    def test_an_answer_before_the_next_screen_question_counts(self):
        configure(self.pipeline, dict(turnsPerBatch=10))
        turn_intake.append(self.pipeline, [self.screen('X', 'user'), self.screen('first-node', 'assistant'),
                                           self.screen('Y', 'user')])
        self.assertEqual(self.skipped(turn_intake.append(self.pipeline, self.sync_turn('X', self.at))), (1, 0, 0))

    def test_a_later_turns_answer_is_not_this_turns(self):
        # The screen answer A1 was too long and went to quarantine; only the next turn Q2/A2 has a screen answer.
        configure(self.pipeline, dict(turnsPerBatch=10))
        screen = turn_intake.append(self.pipeline, [
            self.screen('Q1', 'user'), self.screen('A1', 'assistant', text='코' * 20001),
            self.screen('Q2', 'user'), self.screen('A2', 'assistant')])
        self.assertEqual([i['reason'] for i in screen['intakeIssues']], ['invalid_message'])
        response = turn_intake.append(self.pipeline, [self.sync('Q1', 'user', self.at, 'Q1'),
                                                      self.sync('A1', 'assistant', self.at + 1, 'Q1', text='코' * 19999 + '…')])
        self.assertEqual(self.skipped(response), (0, 1, 1), 'A1 is taken from sync, not lost')
        stored = self.stored()
        self.assertEqual(stored['chatgpt:A1'][0]['origin'], 'sync')
        self.assertEqual(stored['chatgpt:Q1'][0]['turnId'], 'Q1')

    def test_batched_screen_answer_without_its_question_is_skipped(self):
        # The screen path named the question by a text hash, so no question chatgpt:X is stored; its answer is batched.
        turn_intake.append(self.pipeline, [self.screen('conv:hash', 'user'), self.screen('X-a', 'assistant', text='렌더된 답')])
        self.assertIsNotNone(self.stored()['chatgpt:X-a'][1])
        response = turn_intake.append(self.pipeline, self.sync_turn('X', self.at, answer_text='**마크다운** 답'))
        self.assertEqual(self.skipped(response), (1, 0, 0), 'its answer was classified; no question without it')
        self.assertEqual(set(self.stored()), {'chatgpt:conv:hash', 'chatgpt:X-a'})
        self.assertEqual(response['intakeIssues'], [])

    def test_waiting_screen_answer_without_its_question_gets_the_turn_id(self):
        # The screen path stored the answer but no question before it. Each case in its own conversation.
        configure(self.pipeline, dict(turnsPerBatch=10))
        cases = ('question asked on another device, left in the screen baseline', 'question quarantined as too long')
        for n, name in enumerate(cases):
            with self.subTest(name):
                conversation, turn = f'c{n}', f'T{n}'
                question = [[], [self.screen(turn, 'user', conversation, text='질' * 20001)]][n]
                turn_intake.append(self.pipeline,
                                   question + [self.screen(turn + '-a', 'assistant', conversation, text='화면 답')])
                response = turn_intake.append(self.pipeline, self.sync_turn(turn, self.at, conversation=conversation))
                self.assertEqual(self.skipped(response), (0, 1, 1), 'the question is taken from sync')
                self.assertEqual(response['intakeIssues'], [], 'the answer is a duplicate, not a change')
                stored = self.stored()
                answer, question_row = stored[f'chatgpt:{turn}-a'][0], stored[f'chatgpt:{turn}'][0]
                self.assertEqual((answer['turnId'], answer['text']), (turn, '화면 답'), 'turnId added, text unchanged')
                self.assertNotIn('origin', answer)
                self.assertEqual(question_row['origin'], 'sync')
                with connect(self.db) as c:
                    waiting = unbatched_turns(c, 'a', self.base)['chatgpt:' + conversation]
                self.assertEqual([m['id'] for m in group_turns(waiting)[-1]], [f'chatgpt:{turn}-a', f'chatgpt:{turn}'],
                                 'one turn, answer first (arrival order; time order is C5)')

    def test_hash_named_screen_question_pairs_with_its_screen_answer(self):
        # The screen path named the question by a text hash; the screen rows become the turn, sync stores nothing.
        configure(self.pipeline, dict(turnsPerBatch=10))
        turn_intake.append(self.pipeline, [self.screen('conv:hash', 'user'), self.screen('X-a', 'assistant')])
        response = turn_intake.append(self.pipeline, self.sync_turn('X', self.at))
        self.assertEqual(self.skipped(response), (0, 0, 0), 'not stored and not counted as skipped')
        self.assertEqual(response['intakeIssues'], [])
        stored = self.stored()
        self.assertEqual(set(stored), {'chatgpt:conv:hash', 'chatgpt:X-a'}, 'the question is stored once')
        self.assertEqual([stored[i][0]['turnId'] for i in ('chatgpt:conv:hash', 'chatgpt:X-a')], ['X', 'X'])
        turn_intake.append(self.pipeline, [self.screen('next', 'user'), self.screen('next-a', 'assistant')], True)
        with connect(self.db) as c:
            batch = json.loads(c.execute('SELECT messages FROM job_context').fetchone()[0])
        self.assertEqual([[m['id'] for m in t] for t in group_turns(batch)],
                         [['chatgpt:conv:hash', 'chatgpt:X-a'], ['chatgpt:next', 'chatgpt:next-a']], 'one turn')

    def test_no_pair_across_another_screen_answer_or_a_taken_question(self):
        configure(self.pipeline, dict(turnsPerBatch=10))
        cases = {'another screen answer between': lambda conv: [self.screen(conv + ':hash', 'user', conv),
                                                                self.screen(conv + '-other', 'assistant', conv)],
                 'question with a turnId': lambda conv: [self.screen(conv + ':hash', 'user', conv, turnId='Y')]}
        for n, (name, before) in enumerate(cases.items()):
            with self.subTest(name):
                conversation, turn = f'c{n}', f'T{n}'
                turn_intake.append(self.pipeline, before(conversation) + [self.screen(turn + '-a', 'assistant', conversation)])
                response = turn_intake.append(self.pipeline, self.sync_turn(turn, self.at, conversation=conversation))
                self.assertEqual(self.skipped(response), (0, 1, 1), 'the sync question is stored, as with no pair')
                self.assertNotEqual(self.stored()[f'chatgpt:{conversation}:hash'][0].get('turnId'), turn)

    def test_a_batched_question_is_no_pair(self):
        # Flushed while the answer was still being generated: the hash question was classified alone.
        configure(self.pipeline, dict(turnsPerBatch=10))
        turn_intake.append(self.pipeline, [self.screen('conv:hash', 'user')], True)
        turn_intake.append(self.pipeline, [self.screen('X-a', 'assistant')])
        response = turn_intake.append(self.pipeline, self.sync_turn('X', self.at))
        self.assertEqual(self.skipped(response), (0, 1, 1))
        self.assertNotIn('turnId', self.stored()['chatgpt:conv:hash'][0])

    def test_only_the_turns_own_answer_ids_stop_it_without_a_question(self):
        turn_intake.append(self.pipeline, [self.screen('conv:hash', 'user'), self.screen('other-node', 'assistant')])
        self.assertEqual(self.skipped(turn_intake.append(self.pipeline, self.sync_turn('X', self.at))), (0, 2, 1))

    def test_screen_question_waiting_for_its_answer_gets_the_turn_id(self):
        turn_intake.append(self.pipeline, [self.screen('X', 'user', text='화면 질문')])
        self.assertIsNone(self.stored()['chatgpt:X'][1], 'an unanswered question waits for its answer')
        response = turn_intake.append(self.pipeline, self.sync_turn('X', self.at))
        self.assertEqual((response['skippedTurns'], response['newMessages'], response['newTurns']), (0, 1, 1))
        self.assertEqual(response['intakeIssues'], [], 'the question is a duplicate, not a change')
        stored = self.stored()
        question, question_job = stored['chatgpt:X']
        self.assertEqual((question['turnId'], question['text']), ('X', '화면 질문'), 'turnId added, text unchanged')
        self.assertNotIn('origin', question)
        self.assertEqual(stored['chatgpt:X-a'][1], question_job)
        with connect(self.db) as c:
            batch = json.loads(c.execute('SELECT messages FROM job_context WHERE job=?', (question_job,)).fetchone()[0])
        self.assertEqual([m['id'] for m in batch], ['chatgpt:X', 'chatgpt:X-a'])
        self.assertEqual(len(group_turns(batch)), 1, 'question and sync answer are one turn')

    def test_batched_screen_question_is_skipped(self):
        turn_intake.append(self.pipeline, [self.screen('X', 'user')], True)
        self.assertIsNotNone(self.stored()['chatgpt:X'][1])
        response = turn_intake.append(self.pipeline, self.sync_turn('X', self.at))
        self.assertEqual((response['skippedTurns'], response['newMessages'], response['newTurns']), (1, 0, 0))
        self.assertEqual(set(self.stored()), {'chatgpt:X'})

    def test_sync_turn_sent_again_after_its_batch_adds_nothing(self):
        first = turn_intake.append(self.pipeline, self.sync_turn('X', self.at))
        self.assertEqual((first['newMessages'], first['newTurns']), (2, 1))
        again = turn_intake.append(self.pipeline, self.sync_turn('X', self.at))
        self.assertEqual((again['skippedTurns'], again['newMessages'], again['newTurns']), (1, 0, 0))


class DifferentOrigin(SyncFixture):
    """C4-a: one message id stored by both paths."""
    def setUp(self):
        super().setUp()
        self.turn_on(self.base)
        self.at = self.base + 900

    def test_screen_then_sync_is_a_duplicate(self):
        # A screen question still waiting for its answer: C4-b lets the turn through and C4-a meets the question.
        turn_intake.append(self.pipeline, [self.screen('X', 'user', text='렌더된 질문')])
        response = turn_intake.append(self.pipeline, [self.sync('X', 'user', self.at, 'X', text='**마크다운** 질문'),
                                                      self.sync('X-a', 'assistant', self.at + 1, 'X')])
        self.assertEqual((response['newMessages'], response['newTurns'], response['intakeIssues']), (1, 1, []))
        question = self.stored()['chatgpt:X'][0]
        self.assertEqual(question['text'], '렌더된 질문', 'the row stored first stays')
        self.assertNotIn('origin', question)

    def test_sync_then_screen_is_a_duplicate(self):
        turn_intake.append(self.pipeline, self.sync_turn('X', self.at, answer_text='**마크다운** 답'))
        response = turn_intake.append(self.pipeline, [self.screen('X-a', 'assistant', text='렌더된 답')])
        self.assertEqual((response['newMessages'], response['intakeIssues']), (0, []))
        self.assertEqual(self.stored()['chatgpt:X-a'][0]['text'], '**마크다운** 답')

    def test_same_origin_with_another_text_is_quarantined(self):
        configure(self.pipeline, dict(turnsPerBatch=10))
        turn_intake.append(self.pipeline, self.sync_turn('X', self.at))
        same = turn_intake.append(self.pipeline, self.sync_turn('X', self.at))
        self.assertEqual((same['newMessages'], same['newTurns'], same['intakeIssues']), (0, 0, []))
        changed = turn_intake.append(self.pipeline, self.sync_turn('X', self.at, answer_text='바뀐 답'))
        self.assertEqual([i['reason'] for i in changed['intakeIssues']], ['message_changed'])
        self.assertEqual((changed['skippedTurns'], changed['newTurns']), (0, 0))


class TeamRecords(SyncFixture):
    """'팀 기록 불러오기' pasted into a question leaves the user's text before it is stored."""
    RECORD = '# 싱크업 팀 기록 (2026. 11. 13.)\n\n아래는 우리 팀이 지금까지 합의한 내용입니다.\n\n## 작업·결과물\n- [결정] DB: DB = SQLite'
    END = '<!-- 싱크업 팀 기록 끝 -->'

    def stored_text(self, text, site='chatgpt'):
        """(stored text or None, teamRecordSkipped) of one screen-path question with this text."""
        response = turn_intake.append(self.pipeline, [dict(self.screen('q', 'user', text=text), site=site)])
        stored = self.stored().get('chatgpt:q')
        return (stored[0]['text'] if stored else None), response['teamRecordSkipped']

    def test_a_record_is_cut_through_its_end_line(self):
        self.assertEqual(self.stored_text(f'{self.RECORD}\n\n{self.END}\n\n이 기준으로 발표 순서를 정해 줘'),
                         ('이 기준으로 발표 순서를 정해 줘', 0))

    def test_without_an_end_line_the_record_runs_to_the_end(self):
        self.assertEqual(self.stored_text(f'발표 순서를 정해 줘\n\n{self.RECORD}'), ('발표 순서를 정해 줘', 0))

    def test_every_record_is_cut(self):
        self.assertEqual(self.stored_text(f'앞\n{self.RECORD}\n{self.END}\n가운데\n{self.RECORD}'), ('앞\n가운데', 0))

    def test_a_question_that_is_only_a_record_is_not_stored(self):
        cases = {'with the end line': (f'{self.RECORD}\n\n{self.END}\n', 'chatgpt'),
                 'without it (web copy)': (self.RECORD, 'chatgpt'), 'pasted into the web': (self.RECORD, 'manual')}
        for name, (text, site) in cases.items():
            with self.subTest(name):
                self.assertEqual(self.stored_text(text, site), (None, 1))
        self.assertEqual(self.count('SELECT count(*) FROM intake'), 0)
        self.assertEqual(self.count('SELECT count(*) FROM intake_issues'), 0, 'not quarantined either')

    def test_answers_and_other_headings_are_kept(self):
        answer = self.screen('a', 'assistant', text=self.RECORD)
        own_heading = self.screen('h', 'user', text='## 싱크업 팀 기록 정리 방법')
        response = turn_intake.append(self.pipeline, [own_heading, answer])
        self.assertEqual((response['newMessages'], response['teamRecordSkipped']), (2, 0))
        self.assertEqual(self.stored()['chatgpt:a'][0]['text'], self.RECORD)

    def test_sync_question_that_is_only_a_record(self):
        self.turn_on(self.base)
        turn = [self.sync('X', 'user', self.base + 900, 'X', text=f'{self.RECORD}\n{self.END}'),
                self.sync('X-a', 'assistant', self.base + 901, 'X')]
        response = turn_intake.append(self.pipeline, turn)
        self.assertEqual((response['teamRecordSkipped'], response['newMessages'], response['newTurns']), (1, 1, 1))
        self.assertEqual(set(self.stored()), {'chatgpt:X-a'})

    def test_the_change_check_compares_the_cut_text(self):
        self.assertEqual(self.stored_text(f'{self.RECORD}\n{self.END}\n질문'), ('질문', 0))
        same = turn_intake.append(self.pipeline, [self.screen('q', 'user', text='질문')])
        self.assertEqual(same['intakeIssues'], [], 'the same words without the record are no change')
        changed = turn_intake.append(self.pipeline, [self.screen('q', 'user', text=f'{self.RECORD}\n{self.END}\n다른 질문')])
        self.assertEqual([i['reason'] for i in changed['intakeIssues']], ['message_changed'])


class ElsewhereDuplicates(SyncFixture):
    """8-1 R2: a ChatGPT message id (chatgpt:<uuid>) stored in one conversation is not stored in another."""
    M = '0e5c2f9a-1b2c-4d3e-8f90-0123456789ab'
    N = '7a1d0c3b-5e6f-4a8b-9c0d-fedcba987654'

    def setUp(self):
        super().setUp()
        configure(self.pipeline, dict(turnsPerBatch=10))
        turn_intake.append(self.pipeline, [self.screen(self.M, 'user', 'A')])

    def conversations(self, identifier):
        with connect(self.db) as c:
            return sorted(r[0] for r in c.execute("SELECT conversation FROM intake WHERE json_extract(message,'$.id')=?",
                                                  ('chatgpt:' + identifier,)))

    def test_screen_path_under_another_conversation(self):
        # A hidden message of conversation A sent with conversation B's id, next to B's own message.
        response = turn_intake.append(self.pipeline, [self.screen(self.M, 'user', 'B', text='다른 대화로 붙은 본문'),
                                                      self.screen(self.N, 'user', 'B')])
        self.assertEqual((response['newMessages'], response['elsewhereDuplicates'], response['intakeIssues']), (1, 1, []))
        self.assertEqual(self.conversations(self.M), ['chatgpt:A'])
        self.assertEqual(self.conversations(self.N), ['chatgpt:B'])

    def test_sync_under_another_conversation(self):
        self.turn_on(self.base)
        turn = [self.sync(self.N, 'user', self.base + 900, self.N, 'B'),
                self.sync(self.M, 'assistant', self.base + 901, self.N, 'B')]
        response = turn_intake.append(self.pipeline, turn)
        self.assertEqual((response['newMessages'], response['elsewhereDuplicates'], response['newTurns']), (1, 1, 1))
        self.assertEqual(self.conversations(self.M), ['chatgpt:A'], 'whatever the origin, the row stored first stays')

    def test_one_call_with_the_message_in_two_conversations(self):
        response = turn_intake.append(self.pipeline, [self.screen(self.N, 'user', 'B'), self.screen(self.N, 'user', 'C')])
        self.assertEqual((response['newMessages'], response['elsewhereDuplicates']), (1, 1))
        self.assertEqual(self.conversations(self.N), ['chatgpt:B'])

    def test_the_same_conversation_is_left_to_the_change_check(self):
        same = turn_intake.append(self.pipeline, [self.screen(self.M, 'user', 'A')])
        self.assertEqual((same['newMessages'], same['elsewhereDuplicates'], same['intakeIssues']), (0, 0, []))
        changed = turn_intake.append(self.pipeline, [self.screen(self.M, 'user', 'A', text='바뀐 본문')])
        self.assertEqual(changed['elsewhereDuplicates'], 0)
        self.assertEqual([i['reason'] for i in changed['intakeIssues']], ['message_changed'])

    def test_hash_ids_and_other_ids_are_per_conversation(self):
        hashed, other = 'A:5f3a9c', 'not-a-uuid'
        turn_intake.append(self.pipeline, [self.screen(hashed, 'user', 'A'), self.screen(other, 'user', 'A')])
        response = turn_intake.append(self.pipeline, [self.screen(hashed, 'user', 'B'), self.screen(other, 'user', 'B')])
        self.assertEqual((response['newMessages'], response['elsewhereDuplicates']), (2, 0))
        self.assertEqual(self.conversations(hashed), ['chatgpt:A', 'chatgpt:B'])


class Response(SyncFixture):
    def test_counts_of_one_mixed_call(self):
        configure(self.pipeline, dict(turnsPerBatch=10))
        self.turn_on(self.base + 600)
        turn_intake.append(self.pipeline, [self.screen('seen', 'user'), self.screen('seen-a', 'assistant')])
        bad = dict(self.sync('bad', 'user', self.base + 900, 'bad'), turnId='')
        messages = (self.sync_turn('seen', self.base + 700) + self.sync_turn('old', self.base + 100)
                    + self.sync_turn('new1', self.base + 800) + self.sync_turn('new2', self.base + 900, conversation='c2')
                    + [bad])
        response = dispatch(self.pipeline, 'turns.append', dict(messages=messages))
        self.assertEqual({k: v for k, v in response.items() if k != 'intakeIssues'},
                         dict(newMessages=4, queued=True, outsideWindow=1, skippedTurns=1, newTurns=2, teamRecordSkipped=0,
                              elsewhereDuplicates=0))
        self.assertEqual([i['reason'] for i in response['intakeIssues']], ['invalid_message'])

    def test_every_turn_outside_still_answers_queued(self):
        self.turn_on(self.base + 600)
        response = turn_intake.append(self.pipeline, self.sync_turn('old', self.base + 100))
        self.assertEqual((response['queued'], response['newMessages'], response['outsideWindow']), (True, 0, 1))


if __name__ == '__main__':
    import unittest
    unittest.main(verbosity=2)
