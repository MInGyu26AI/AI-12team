"""Connector framework (collector/connectors/), its RPC and local page, and the local OCR (files.ocr).

A fake provider, a fake Ollama on loopback and real temporary SQLite; no network, no model. Covers: message ids and
chunking, other authors skipped, dedupe across runs and teams, flush of only the imported document, token files
(mode 0600, never in a response, an error, a log, the database or the page), connectors.* validation, the background
runner and paused collection, the /connectors page (csrf, host), and files.ocr (ok, empty, too_large, bad_image,
model_unavailable, loopback only).
"""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import base64
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import http.client
import http.server
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import urllib.error

from ai.syncup_ai.batch import group_turns
from ai.syncup_ai.classify import source_of
import app
import batch_queue
from collection_settings import configure
from connectors import base, vision
from local_fixtures import (FAKE_TEAM, HEALTH, HIDDEN, KEEP, SECRETS, PipelineFixture, PrivacyFixture, Scripted, fake_team_api,
                            first_line, get_page, leaked, post, server, wait_until)
from local_privacy import Gate
from local_rpc import dispatch
from review_page import Review
from runtime import child_environment
from storage import connect
import turn_intake

base.load_providers()  # a real provider module registers itself on its first import: before the tests replace PROVIDERS
KST = timezone(timedelta(hours=9))
CANARY = 'ntn_CanaryTokenValue0123456789AbCdEf'  # a synthetic token: it must be found nowhere but its own file
MODIFIED = datetime(2026, 11, 14, 21, 10, tzinfo=KST)


def section(text, heading='', me=True):
    return dict(heading=heading, text=text, author_is_me=me)


def document(source='page-1', sections=None, modified=MODIFIED):
    return dict(source_id=source, title='회의록', url='https://example.test/page-1', modified=modified,
                sections=sections if sections is not None else [section('SQLite로 결정했다.', '결정'), section('금요일까지 공유한다.', '일정')])


class FakeProvider(base.Provider):
    """What the Notion and Google agents build: a token file, a setup form and fetch."""
    site = 'notion'
    label = '가짜 노션'

    def __init__(self):
        self.documents, self.calls, self.fail, self.leak = [], [], None, False

    def status(self, pipeline):
        status = super().status(pipeline)
        if self.leak:
            status['needs'] = '토큰 ' + base.load_token(base.state_dir(pipeline), self.site)['token']
        return status

    def setup_html(self, pipeline):
        value = base.load_token(base.state_dir(pipeline), self.site)['token'] if self.leak else ''
        return f'<label>토큰<input name="token" type="password" value="{value}"></label>'

    def handle_setup(self, pipeline, form):
        if not form.get('token'):
            raise ValueError('토큰을 입력하세요.')
        base.save_token(base.state_dir(pipeline), self.site, dict(token=form['token']))
        return '토큰을 저장했습니다.'

    def fetch(self, pipeline, scope):
        self.calls.append(dict(scope))
        if self.fail:
            raise self.fail
        return self.documents, f'cursor-{len(self.calls)}'

    def handle_callback(self, pipeline, query):
        return '로그인을 마쳤습니다: ' + query.get('state', '')


class ConnectorFixture(PipelineFixture):
    """The pipeline fixture (fake AI, always-work gate, ten turns per batch) with the fake provider as the only provider."""
    def setUp(self):
        super().setUp()
        configure(self.pipeline, dict(turnsPerBatch=10))
        self.provider = FakeProvider()
        patcher = patch.dict(base.PROVIDERS, {FakeProvider.site: self.provider}, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.state = base.state_dir(self.pipeline)
        self.logs = []

    def connect(self, token=CANARY):
        base.save_token(self.state, 'notion', dict(token=token))

    def add_scope(self, scope='root', enabled=True):
        return dispatch(self.pipeline, 'connectors.setScope', dict(site='notion', scopeId=scope, title='팀 페이지', enabled=enabled))

    def count(self, sql, *args):
        with connect(self.db) as c:
            return c.execute(sql, args).fetchone()[0]

    def scope_row(self, scope='root'):
        with connect(self.db) as c:
            return dict(c.execute('SELECT * FROM connector_scopes WHERE scope_id=?', (scope,)).fetchone())

    def quietly(self):
        """Provider failures are logged by kind; keep the output of a passing run clean."""
        return self.assertLogs('syncup', 'WARNING')


class MessageBuilder(unittest.TestCase):
    def test_ids_turns_time_and_chunk_size(self):
        long_section = '\n\n'.join(f'문단 {i} ' + '가' * 880 for i in range(5))
        doc = document(sections=[section('첫 절 본문', '## 개요'), section(long_section, '세부'), section('남의 글', '댓글', False),
                                 section('작성자 모름', '담당 문서', None)])
        messages = base.build_messages('notion', doc)
        self.assertEqual(len(messages), 1 + 3 + 1, 'one, three chunks of the long section, the unknown author kept')
        for message in messages:
            turn_intake.clean_message(message)  # exactly what turns.append accepts
            self.assertEqual((message['site'], message['role'], message['conversationId']), ('notion', 'user', 'notion:page-1'))
            self.assertEqual(message['collectedAt'], '2026-11-14T21:10:00+09:00')
            self.assertLessEqual(len(message['text']), 2000, 'heading line included: nothing is cut by the 2000 character check')
            self.assertRegex(message['id'], r'^notion:page-1:[0-9a-f]{12}:\d+$')
        self.assertEqual([m['turnId'] for m in messages],
                         ['notion:page-1:0', 'notion:page-1:1', 'notion:page-1:1', 'notion:page-1:1', 'notion:page-1:3'])
        self.assertEqual([m['id'].rsplit(':', 1)[1] for m in messages], ['0', '0', '1', '2', '0'])
        self.assertTrue(messages[0]['text'].startswith('## 개요\n'))
        self.assertTrue(all(m['text'].startswith('세부\n') for m in messages[1:4]))
        for message in messages:
            self.assertEqual(message['id'].split(':')[2], base.fingerprint(message['text'])[:12])
        self.assertIn('작성자 모름', messages[4]['text'])
        self.assertNotIn('남의 글', ' '.join(m['text'] for m in messages))

    def test_chunks_break_at_paragraph_boundaries_first(self):
        paragraphs = [f'문단{i} ' + '나' * 700 for i in range(6)]
        chunks = base.split_text('\n\n'.join(paragraphs), 2000)
        self.assertEqual(len(chunks), 3)
        self.assertEqual(['\n\n'.join(paragraphs[i:i + 2]) for i in (0, 2, 4)], chunks, 'whole paragraphs, never a half one')

    def test_an_overlong_paragraph_is_cut_at_lines_then_sentences_then_anywhere(self):
        lines = '\n'.join('줄 ' + '다' * 300 for _ in range(15))
        self.assertTrue(all(len(c) <= 2000 for c in base.split_text(lines, 2000)))
        sentences = ' '.join('문장입니다 ' + '라' * 90 + '.' for _ in range(60))
        pieces = base.split_text(sentences, 2000)
        self.assertTrue(all(len(c) <= 2000 and c.endswith('.') for c in pieces))
        solid = '마' * 5000
        self.assertEqual([len(c) for c in base.split_text(solid, 2000)], [2000, 2000, 1000])
        self.assertEqual(''.join(base.split_text(solid, 2000)), solid)

    def test_blank_sections_make_no_message_and_a_heading_alone_is_not_text(self):
        self.assertEqual(base.build_messages('notion', document(sections=[section('  \n\n '), section('', '제목만')])), [])

    def test_whitespace_only_edits_keep_the_id_and_real_edits_change_it(self):
        first = base.build_messages('notion', document(sections=[section('SQLite로  결정했다.\n', '결정')]))[0]
        spaced = base.build_messages('notion', document(sections=[section('SQLite로 결정했다.', '결정 ')]))[0]
        edited = base.build_messages('notion', document(sections=[section('PostgreSQL로 결정했다.', '결정')]))[0]
        self.assertEqual(first['id'], spaced['id'])
        self.assertNotEqual(first['id'], edited['id'])
        self.assertEqual(base.fingerprint('ＡＢＣ​ 가'), base.fingerprint('ABC 가'), 'width variants and zero-width characters')

    def test_same_body_under_two_headings_does_not_collide(self):
        a, b = base.build_messages('notion', document(sections=[section('미정', '결정 A'), section('미정', '결정 B')]))
        self.assertNotEqual(a['id'], b['id'], 'one id with two texts would be quarantined as message_changed')

    def test_long_source_ids_are_hashed_and_bad_documents_refused(self):
        long_id = 'x' * 400
        message = base.build_messages('notion', document(source=long_id))[0]
        self.assertLessEqual(len(message['conversationId']), 60)
        for bad in (dict(document(), modified=datetime(2026, 11, 14)), dict(document(), source_id=' '),
                    dict(document(), sections='text'), dict(document(), sections=[dict(heading='x')])):
            with self.subTest(bad=bad.get('source_id'), modified=str(bad.get('modified'))), self.assertRaises(ValueError):
                base.build_messages('notion', bad)

    def test_the_author_must_be_stated_for_every_section(self):
        # "false" as text, 0, or no key at all must never pass as "mine": the provider has to say True, False or None
        for author in ('false', 'False', 0, 1, 'me'):
            with self.subTest(author=author), self.assertRaisesRegex(ValueError, 'author_is_me'):
                base.build_messages('notion', document(sections=[dict(heading='x', text='본문', author_is_me=author)]))
        with self.assertRaisesRegex(ValueError, 'author_is_me'):
            base.build_messages('notion', document(sections=[dict(heading='x', text='본문')]))
        self.assertEqual(len(base.build_messages('notion', document(sections=[section('본문', 'x', True), section('본문2', 'x', None)]))), 2)

    def test_the_card_source_name_comes_from_the_site(self):
        message = base.build_messages('notion', document())[0]
        self.assertEqual(source_of(message), '노션, 2026-11-14 21:10')
        self.assertEqual(source_of(dict(message, site='google-docs')), '구글 문서, 2026-11-14 21:10')
        self.assertEqual(source_of(dict(message, site='file-upload')), '파일 올리기, 2026-11-14 21:10')

    def test_new_sites_are_accepted_by_intake_and_unknown_ones_are_not(self):
        for site in ('file-upload', 'notion', 'google-docs'):
            self.assertIn(site, turn_intake.INTAKE_SITES)
        with self.assertRaises(ValueError):
            turn_intake.clean_message(dict(base.build_messages('notion', document())[0], site='slack'))


class Ingest(ConnectorFixture):
    def test_other_authors_never_reach_the_collector(self):
        doc = document(sections=[section('내가 쓴 결정', '내 글'), section('OTHER_AUTHOR_CANARY 남이 쓴 결정', '남의 글', False),
                                 section('작성자 모르는 본문', '문서 담당', None)])
        counts = base.ingest(self.pipeline, 'notion', 'root', [doc])
        self.assertEqual(counts, dict(documents=1, sent=2, skipped=0))
        with connect(self.db) as c:
            stored = json.dumps([r[0] for r in c.execute('SELECT message FROM intake')], ensure_ascii=False)
            roles = {json.loads(r[0])['role'] for r in c.execute('SELECT message FROM intake')}
        self.assertNotIn('OTHER_AUTHOR_CANARY', stored)
        self.assertEqual(roles, {'user'}, 'an unknown author is imported as the user, the provider having decided')
        self.assertEqual(self.count('SELECT count(*) FROM connector_items'), 2)

    def test_dedupe_across_runs_edits_and_moved_sections(self):
        first = document(sections=[section('A 결정', '가'), section('B 결정', '나')])
        self.assertEqual(base.ingest(self.pipeline, 'notion', 'root', [first]), dict(documents=1, sent=2, skipped=0))
        self.assertEqual(base.ingest(self.pipeline, 'notion', 'root', [first]), dict(documents=1, sent=0, skipped=2))
        edited = document(sections=[section('A 결정', '가'), section('B 결정을 바꿨다', '나')])
        self.assertEqual(base.ingest(self.pipeline, 'notion', 'root', [edited]), dict(documents=1, sent=1, skipped=1))
        moved = document(sections=[section('새 절', '다'), section('A 결정', '가'), section('B 결정을 바꿨다', '나')])
        self.assertEqual(base.ingest(self.pipeline, 'notion', 'root', [moved]), dict(documents=1, sent=1, skipped=2),
                         'an inserted section does not resend the ones that only moved')
        self.assertEqual(self.count('SELECT count(*) FROM intake'), 4)
        self.assertEqual(self.count('SELECT count(*) FROM intake_issues'), 0, 'no message_changed quarantine from re-sends')
        again = document(sections=[section('A 결정', '가'), section('A 결정', '가')])
        self.assertEqual(base.ingest(self.pipeline, 'notion', 'root', [again])['sent'], 0)
        twins = document(source='page-2', sections=[section('같은 글', '제목'), section('같은 글', '제목')])
        self.assertEqual(base.ingest(self.pipeline, 'notion', 'root', [twins]), dict(documents=1, sent=1, skipped=1))

    def test_dedupe_is_per_team(self):
        doc = document()
        self.assertEqual(base.ingest(self.pipeline, 'notion', 'root', [doc])['sent'], 2)
        configure(self.pipeline, dict(teamId='b'))
        self.assertEqual(base.ingest(self.pipeline, 'notion', 'root', [doc])['sent'], 2, 'another team has not got them')
        configure(self.pipeline, dict(teamId='a'))
        self.assertEqual(base.ingest(self.pipeline, 'notion', 'root', [doc])['sent'], 0)
        self.assertEqual(self.count("SELECT count(DISTINCT team_id) FROM connector_items"), 2)
        self.assertEqual(self.count("SELECT count(*) FROM connector_items WHERE content_hash NOT GLOB '[0-9a-f]*'"), 0,
                         'a hash is stored, not text')

    def test_appends_go_in_slices_of_200(self):
        doc = document(sections=[section(f'결정 {i}', f'절 {i}') for i in range(450)])
        with patch('connectors.base.turn_intake.append', wraps=turn_intake.append) as append:
            counts = base.ingest(self.pipeline, 'notion', 'root', [doc])
        self.assertEqual(counts, dict(documents=1, sent=450, skipped=0))
        self.assertEqual([len(call.args[1]) for call in append.call_args_list], [200, 200, 50])
        self.assertEqual(self.count('SELECT count(*) FROM intake'), 450)

    def test_a_section_is_one_turn_and_its_chunks_share_it(self):
        long_section = '\n\n'.join('문단 ' + '가' * 900 for _ in range(5))
        messages = base.build_messages('notion', document(sections=[section('짧은 절', '하나'), section(long_section, '둘'), section('끝', '셋')]))
        turn_intake.append(self.pipeline, messages)
        with connect(self.db) as c:
            start = c.execute('SELECT start FROM settings').fetchone()[0]
            # the intake key is <site>:<conversationId>, and the connector's conversationId is itself <site>:<source id>
            turns = group_turns(batch_queue.unbatched_turns(c, 'a', start)['notion:notion:page-1'])
        self.assertEqual([len(t) for t in turns], [1, 3, 1])

    def test_only_the_imported_document_is_flushed(self):
        turn_intake.append(self.pipeline, [self.message('open-question')])  # a chat's unanswered question stays open
        base.ingest(self.pipeline, 'notion', 'root', [document()])
        with connect(self.db) as c:
            jobs = {r['conversation']: set() for r in c.execute('SELECT conversation FROM intake')}
            for r in c.execute('SELECT conversation,job FROM intake'):
                jobs[r['conversation']].add(r['job'])
        self.assertEqual(jobs['manual:conv'], {None}, "another conversation's open batch is not cut short")
        self.assertEqual(len(jobs['notion:notion:page-1']), 1)
        self.assertNotIn(None, jobs['notion:notion:page-1'], 'the two sections went out as one flushed batch')
        dispatch(self.pipeline, 'collection.flush', {})
        self.assertEqual(self.count('SELECT count(*) FROM intake WHERE job IS NULL'), 0, 'collection.flush still flushes everything')
        self.assertEqual(self.count("SELECT count(*) FROM job_context WHERE json_extract(context,'$.trigger')='flush'"), 2)

    def test_nothing_is_recorded_when_it_cannot_run(self):
        doc = document()
        with self.assertRaises(ValueError):
            base.ingest(self.pipeline, 'notion', 'root', [doc, dict(doc, modified=datetime(2026, 1, 1))])
        with self.assertRaises(ValueError):
            base.ingest(self.pipeline, 'slack', 'root', [doc])
        with self.assertRaises(ValueError):
            base.ingest(self.pipeline, 'notion', 'root', 'not a list')
        configure(self.pipeline, dict(autoCollect=False))
        with self.assertRaisesRegex(ValueError, '일시중지'):
            base.ingest(self.pipeline, 'notion', 'root', [doc])
        self.assertEqual((self.count('SELECT count(*) FROM intake'), self.count('SELECT count(*) FROM connector_items')), (0, 0))

    def test_the_connector_tables_exist_on_every_database(self):
        with connect(self.db) as c:
            columns = {t: [r['name'] for r in c.execute(f'PRAGMA table_info({t})')] for t in ('connector_scopes', 'connector_items')}
        self.assertEqual(columns['connector_scopes'], ['team_id', 'site', 'scope_id', 'title', 'enabled', 'cursor', 'last_run',
                                                       'last_error', 'imported'])
        self.assertEqual(columns['connector_items'], ['team_id', 'site', 'item_key', 'content_hash', 'first_sent'])


class Privacy(PrivacyFixture):
    def test_document_text_takes_the_chat_route_through_masking_and_the_privacy_gate(self):
        self.pipeline.privacy = Gate(Scripted({HEALTH: dict(label='personal', personal=[HEALTH])}))
        doc = document(sections=[section(KEEP + '\n' + SECRETS['openai_project'], '결정'), section(HEALTH, '개인'),
                                 section('OTHER_AUTHOR_CANARY', '남의 글', False)])
        base.ingest(self.pipeline, 'notion', 'root', [doc])
        self.run_offline()
        self.assertTrue(self.requests, 'no external request captured; cannot claim the gate held')
        self.assertTrue(leaked(self.requests, 'PRIVACY_CANARY_KEEP'), 'the work text did reach the classifier')
        self.assertFalse(leaked(self.requests, HIDDEN['openai_project']), 'masked before it was stored')
        self.assertFalse(leaked(self.requests, HEALTH), 'held back by the on-device check')
        self.assertFalse(leaked(self.requests, 'OTHER_AUTHOR_CANARY'))
        with connect(self.db) as c:
            stored = json.dumps([r[0] for r in c.execute('SELECT message FROM intake')], ensure_ascii=False)
        self.assertNotIn(HIDDEN['openai_project'], stored)


class TokenStore(ConnectorFixture):
    def test_files_are_private_and_round_trip(self):
        self.assertIsNone(base.load_token(self.state, 'notion'))
        base.save_token(self.state, 'notion', dict(token=CANARY, owner='나'))
        path = self.state / 'connectors' / 'notion.json'
        self.assertEqual(base.load_token(self.state, 'notion'), dict(token=CANARY, owner='나'))
        base.save_token(self.state, 'notion', dict(token=CANARY + '2'))
        self.assertEqual(base.load_token(self.state, 'notion')['token'], CANARY + '2')
        self.assertEqual([p.name for p in path.parent.iterdir()], ['notion.json'], 'no temporary file is left')
        if sys.platform != 'win32':
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        base.delete_token(self.state, 'notion')
        base.delete_token(self.state, 'notion')
        self.assertIsNone(base.load_token(self.state, 'notion'))

    @unittest.skipIf(sys.platform == 'win32', 'POSIX file modes')
    def test_a_readable_by_others_file_is_refused_without_showing_it(self):
        self.connect()
        path = self.state / 'connectors' / 'notion.json'
        path.chmod(0o644)
        with self.assertRaises(ValueError) as refused:
            base.load_token(self.state, 'notion')
        self.assertNotIn(CANARY, str(refused.exception))
        with self.quietly():
            self.assertEqual(base.provider_status(self.pipeline, self.provider)['connected'], False)
        path.write_text('[1, 2]')
        path.chmod(0o600)
        with self.assertRaisesRegex(ValueError, '올바르지'):
            base.load_token(self.state, 'notion')

    def test_bad_names_and_data_are_refused(self):
        for site in ('../notion', 'Notion', '', 'a/b', None, 'x' * 41):
            with self.subTest(site=site), self.assertRaises(ValueError):
                base.save_token(self.state, site, dict(token='t'))
        for data in ({}, 'text', None, dict(token=object()), dict(token='x' * 70000)):
            with self.subTest(data=str(data)[:20]), self.assertRaises(ValueError):
                base.save_token(self.state, 'notion', data)
        self.assertFalse((self.state / 'connectors').exists() and list((self.state / 'connectors').iterdir()))


class TokensStayOnThePC(ConnectorFixture):
    """The canary token is typed into the page and used by the provider; it must be in its own file and nowhere else."""

    def setUp(self):
        super().setUp()
        self.srv = self.enterContext(server(Review, self.db))
        self.srv.pipeline, self.srv.team_client, self.srv.rpc_secret = self.pipeline, self.pipeline.client, 'rpc-secret-for-tests'
        self.seen = []

    def rpc(self, method, params=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.srv.server_port, timeout=10)
        try:
            body = json.dumps(dict(version=1, method=method, params=params or {}))
            connection.request('POST', '/rpc', body, {'Authorization': 'Bearer rpc-secret-for-tests'})
            response = connection.getresponse()
            text = response.read().decode()
        finally:
            connection.close()
        self.seen.append(text)
        return response.status, json.loads(text)

    def test_the_token_is_in_one_file_and_in_no_answer(self):
        status, body = post(self.srv, '/connectors/setup', dict(site='notion', token=CANARY))
        self.assertEqual(status, 200)
        self.seen.append(body.decode())
        self.assertIn('토큰을 저장했습니다.', body.decode())
        self.assertEqual(base.load_token(self.state, 'notion'), dict(token=CANARY))
        self.provider.fail = RuntimeError('boom ' + CANARY)  # an error text that carries the token
        self.provider.documents = [document()]
        self.assertEqual(self.rpc('connectors.setScope', dict(site='notion', scopeId='root', title='페이지', enabled=True))[0], 200)
        with self.quietly() as logs:
            status, body = self.rpc('connectors.sync', dict(site='notion', scopeId='root'))
        self.assertEqual((status, body['result']['results'][0]['error']), (200, 'RuntimeError'), 'the kind only')
        self.provider.fail = urllib.error.HTTPError('https://api.example.test/?token=' + CANARY, 401, 'Unauthorized ' + CANARY, {}, None)
        self.addCleanup(self.provider.fail.close)
        with self.quietly() as logs2:
            status, body = self.rpc('connectors.sync', {})
        self.assertEqual(body['result']['results'][0]['error'], 'HTTPError 401')
        self.provider.fail = None
        self.assertEqual(self.rpc('connectors.sync', {})[1]['result']['results'][0]['sent'], 2)
        listed = self.rpc('connectors.list')[1]['result']['providers'][0]
        self.assertEqual(listed['status'], dict(connected=True, tokenSet=True, needs=None))
        self.assertEqual(self.rpc('collection.status')[0], 200)
        self.assertEqual(self.rpc('connectors.sync', dict(site='nowhere'))[0], 400)
        self.assertEqual(self.rpc('connectors.disconnect', dict(site='notion'))[0], 200)
        self.seen.append(get_page(self.srv, '/connectors')[1])
        self.seen.append(get_page(self.srv, '/')[1])
        self.seen.append('\n'.join(logs.output + logs2.output))
        for text in self.seen:
            self.assertNotIn(CANARY, text)
            self.assertNotIn(CANARY[:20], text)
        self.assertNotIn(CANARY.encode(), self.db.read_bytes(), 'not in the private database either')
        self.assertIsNone(base.load_token(self.state, 'notion'), 'disconnect deleted the file')

    def test_a_provider_that_echoes_its_token_is_scrubbed(self):
        self.connect()
        self.provider.leak = True
        self.add_scope()
        listed = dispatch(self.pipeline, 'connectors.list', {})['providers'][0]
        self.assertNotIn(CANARY, json.dumps(listed, ensure_ascii=False))
        self.assertIn('토큰 …', listed['status']['needs'])
        html = get_page(self.srv, '/connectors')[1]
        self.assertNotIn(CANARY, html)
        self.assertIn('name="token"', html)

    def test_an_unreadable_provider_status_hides_what_went_wrong(self):
        self.provider.status = lambda pipeline: (_ for _ in ()).throw(RuntimeError(CANARY))
        with self.quietly() as logs:
            status = dispatch(self.pipeline, 'connectors.list', {})['providers'][0]['status']
        self.assertEqual((status['connected'], status['tokenSet']), (False, False))
        self.assertNotIn(CANARY, json.dumps(status) + ''.join(logs.output))

    def test_a_provider_cannot_widen_the_status_it_reports(self):
        self.provider.status = lambda pipeline: dict(connected=True, tokenSet=True, needs=None, token=CANARY, extra='x')
        status = dispatch(self.pipeline, 'connectors.list', {})['providers'][0]['status']
        self.assertEqual(status, dict(connected=True, tokenSet=True, needs=None))


class Runs(ConnectorFixture):
    def test_run_scope_imports_and_moves_the_cursor_only_on_success(self):
        self.connect()
        self.add_scope()
        self.provider.documents = [document()]
        self.assertEqual(base.run_scope(self.pipeline, 'notion', 'root'), dict(documents=1, sent=2, skipped=0))
        row = self.scope_row()
        self.assertEqual((row['cursor'], row['imported'], row['last_error']), ('cursor-1', 2, None))
        self.assertIsNotNone(row['last_run'])
        self.assertEqual(self.provider.calls[0]['team_id'], 'a')
        self.assertEqual(self.provider.calls[0]['scope_id'], 'root')
        self.provider.fail = base.ConnectorError('rate_limit', 429)
        with self.quietly():
            failed = base.run_scope(self.pipeline, 'notion', 'root')
        self.assertEqual(failed, dict(documents=0, sent=0, skipped=0, error='rate_limit 429'))
        row = self.scope_row()
        self.assertEqual((row['cursor'], row['imported'], row['last_error']), ('cursor-1', 2, 'rate_limit 429'))
        self.assertEqual(self.provider.calls[1]['cursor'], 'cursor-1', 'the provider is handed the stored cursor')
        self.provider.fail = None
        self.assertEqual(base.run_scope(self.pipeline, 'notion', 'root'), dict(documents=1, sent=0, skipped=2))
        self.assertEqual((self.scope_row()['last_error'], self.scope_row()['cursor']), (None, 'cursor-3'))

    def test_a_malformed_document_is_an_error_of_the_scope_not_a_crash(self):
        self.connect()
        self.add_scope()
        self.provider.documents = [dict(document(), modified='yesterday')]
        with self.quietly():
            result = base.run_scope(self.pipeline, 'notion', 'root')
        self.assertEqual(result['error'], 'ValueError')
        self.assertEqual(self.count('SELECT count(*) FROM intake'), 0)

    def test_error_kinds_carry_no_text(self):
        self.assertEqual(base.error_kind(base.ConnectorError('auth', 401)), 'auth 401')
        self.assertEqual(base.error_kind(base.ConnectorError('network')), 'network')
        self.assertEqual(base.error_kind(base.ConnectorError('a b/c<script>')), 'abcscript')
        self.assertEqual(base.error_kind(KeyError('secret')), 'KeyError')
        error = urllib.error.HTTPError('http://x', 503, 'secret', {}, None)
        self.addCleanup(error.close)
        self.assertEqual(base.error_kind(error), 'HTTPError 503')

    def test_run_all_reads_only_enabled_scopes_of_connected_services(self):
        self.provider.documents = [document()]
        self.add_scope('root')
        self.add_scope('off', enabled=False)
        self.assertEqual(base.run_all(self.pipeline), [], 'not connected: nothing runs and nothing is an error')
        self.assertEqual(self.provider.calls, [])
        self.assertIsNone(self.scope_row()['last_error'])
        self.connect()
        results = base.run_all(self.pipeline)
        self.assertEqual([(r['site'], r['scopeId'], r['sent']) for r in results], [('notion', 'root', 2)])
        self.assertEqual([c['scope_id'] for c in self.provider.calls], ['root'])

    def test_run_all_does_nothing_while_collection_is_paused_or_ended(self):
        self.connect()
        self.add_scope()
        self.provider.documents = [document()]
        configure(self.pipeline, dict(autoCollect=False))
        self.assertEqual(base.run_all(self.pipeline), [])
        self.assertEqual(self.provider.calls, [])
        configure(self.pipeline, dict(autoCollect=True))
        with connect(self.db) as c:
            c.execute('UPDATE settings SET end=?', (time.time() - 1,))
        self.assertEqual(base.run_all(self.pipeline), [])
        self.assertEqual(self.provider.calls, [])
        with self.assertRaisesRegex(ValueError, '일시중지되었거나 종료'):
            base.run_scope(self.pipeline, 'notion', 'root')

    def test_pausing_during_a_read_is_not_recorded_as_a_failure(self):
        self.connect()
        self.add_scope()

        def fetch(pipeline, scope):
            configure(pipeline, dict(autoCollect=False))
            return [document()], 'c'
        self.provider.fetch = fetch
        with self.assertRaisesRegex(ValueError, '일시중지'):
            base.run_scope(self.pipeline, 'notion', 'root')
        self.assertIsNone(self.scope_row()['last_error'])

    def test_the_connector_thread_follows_the_collection_state(self):
        self.connect()
        self.add_scope()
        self.provider.documents = [document()]
        configure(self.pipeline, dict(autoCollect=False))
        stop = threading.Event()
        thread = threading.Thread(target=base.watch, args=(self.pipeline, .02, stop), daemon=True)
        thread.start()
        self.addCleanup(stop.set)
        time.sleep(.3)
        self.assertEqual(self.provider.calls, [], 'paused: the thread reads nothing')
        configure(self.pipeline, dict(autoCollect=True))
        self.assertTrue(wait_until(lambda: self.provider.calls), 'resumed: it reads')
        configure(self.pipeline, dict(autoCollect=False))
        time.sleep(.1)
        seen = len(self.provider.calls)
        time.sleep(.3)
        self.assertEqual(len(self.provider.calls), seen, 'paused again: it stops reading')
        stop.set()
        thread.join(2)
        self.assertFalse(thread.is_alive())

    def test_the_connector_thread_is_quiet_when_a_run_fails(self):
        calls = []

        def broken(pipeline):
            calls.append(1)
            raise RuntimeError('no database')
        stop = threading.Event()
        with patch('connectors.base.run_all', broken), self.quietly():
            thread = threading.Thread(target=base.watch, args=(self.pipeline, .01, stop), daemon=True)
            thread.start()
            self.assertTrue(wait_until(lambda: len(calls) >= 3), 'it keeps going after a failure')
            stop.set()
            thread.join(2)
        self.assertFalse(thread.is_alive())

    def test_the_collector_starts_the_thread_beside_delivery_and_only_with_a_pipeline(self):
        started = []

        class Recorder:
            def __init__(self, target=None, args=(), daemon=None):
                self.target, self.args = target, args

            def start(self):
                started.append((self.target, self.args))
        args = type('Args', (), dict(codex_dir=None, claude_dir=None, codex_sqlite_dir=None, claude_project_name=None))
        for pipeline, expected in ((self.pipeline, 1), (None, 0)):
            started.clear()
            srv = type('Srv', (), dict(db=self.db, pipeline=pipeline, team_client=None))
            with patch.object(app.threading, 'Thread', Recorder):
                app.start_workers(srv, args)
            ours = [s for s in started if s[0] is base.watch]
            self.assertEqual(len(ours), expected)
            if expected:
                self.assertEqual(ours[0][1], (self.pipeline,))
        self.assertEqual(base.local_page_url(self.pipeline, '/x'), None, 'no page port before the server listens')
        self.pipeline.page_port = 8876
        self.assertEqual(base.local_page_url(self.pipeline, '/connectors/callback/google-docs'),
                         'http://127.0.0.1:8876/connectors/callback/google-docs')


class RpcValidation(ConnectorFixture):
    def refused(self, method, params, pattern):
        with self.subTest(method=method, params=str(params)[:60]), self.assertRaisesRegex(ValueError, pattern):
            dispatch(self.pipeline, method, params)

    def test_list_shape(self):
        listed = dispatch(self.pipeline, 'connectors.list', {})
        self.assertEqual(set(listed), {'providers'})
        provider, = listed['providers']
        self.assertEqual((provider['site'], provider['label'], provider['scopes']), ('notion', '가짜 노션', []))
        self.assertEqual(provider['status'], dict(connected=False, tokenSet=False, needs='연결 정보를 입력하세요.'))
        self.connect()
        self.add_scope()
        provider, = dispatch(self.pipeline, 'connectors.list', {})['providers']
        self.assertEqual(provider['status'], dict(connected=True, tokenSet=True, needs=None))
        self.assertEqual(provider['scopes'], [dict(site='notion', scopeId='root', title='팀 페이지', enabled=True, lastRun=None,
                                                   lastError=None, imported=0)])
        self.refused('connectors.list', dict(extra=1), '필드')

    def test_scopes_belong_to_the_team(self):
        self.add_scope()
        configure(self.pipeline, dict(teamId='b'))
        self.assertEqual(dispatch(self.pipeline, 'connectors.list', {})['providers'][0]['scopes'], [])
        self.add_scope('other')
        configure(self.pipeline, dict(teamId='a'))
        self.assertEqual([s['scopeId'] for s in dispatch(self.pipeline, 'connectors.list', {})['providers'][0]['scopes']], ['root'])

    def test_set_scope_validation_and_update(self):
        good = dict(site='notion', scopeId='root', title='팀 페이지', enabled=True)
        self.refused('connectors.setScope', dict(good, site='slack'), '서비스')
        self.refused('connectors.setScope', dict(good, site=None), '서비스')
        self.refused('connectors.setScope', {k: v for k, v in good.items() if k != 'site'}, '서비스')
        for scope in ('', '  ', None, 7, 'x' * 301):
            self.refused('connectors.setScope', dict(good, scopeId=scope), '범위 id')
        for title in (5, 'x' * 201, ['a']):
            self.refused('connectors.setScope', dict(good, title=title), '범위 이름')
        for enabled in ('true', 1, None):
            self.refused('connectors.setScope', dict(good, enabled=enabled), '사용 여부')
        self.refused('connectors.setScope', {k: v for k, v in good.items() if k != 'enabled'}, '사용 여부')
        self.refused('connectors.setScope', dict(good, token='x'), '필드')
        self.assertEqual(self.count('SELECT count(*) FROM connector_scopes'), 0)
        info = dispatch(self.pipeline, 'connectors.setScope', good)
        self.assertEqual(info, dict(site='notion', scopeId='root', title='팀 페이지', enabled=True, lastRun=None, lastError=None, imported=0))
        off = dispatch(self.pipeline, 'connectors.setScope', dict(site='notion', scopeId=' root ', enabled=False))
        self.assertEqual((off['title'], off['enabled']), ('팀 페이지', False), 'no title keeps the title; the id is trimmed')
        renamed = dispatch(self.pipeline, 'connectors.setScope', dict(site='notion', scopeId='root', title='새 이름', enabled=False))
        self.assertEqual(renamed['title'], '새 이름')
        self.assertEqual(self.count('SELECT count(*) FROM connector_scopes'), 1)

    def test_sync_validation(self):
        self.connect()
        self.add_scope()
        self.add_scope('off', enabled=False)
        self.refused('connectors.sync', dict(site='slack'), '서비스')
        self.refused('connectors.sync', dict(site=''), '서비스')
        self.refused('connectors.sync', dict(site=5), '서비스')
        self.refused('connectors.sync', dict(scopeId='root'), '서비스를 함께')
        self.refused('connectors.sync', dict(site='notion', scopeId='missing'), '찾을 수 없습니다')
        self.refused('connectors.sync', dict(site='notion', scopeId='off'), '켜세요')
        self.refused('connectors.sync', dict(site='notion', other=1), '필드')
        self.assertEqual(self.provider.calls, [])
        self.provider.documents = [document()]
        results = dispatch(self.pipeline, 'connectors.sync', {})['results']
        self.assertEqual([(r['scopeId'], r['sent']) for r in results], [('root', 2)])
        one = dispatch(self.pipeline, 'connectors.sync', dict(site='notion', scopeId='root'))['results']
        self.assertEqual((one[0]['sent'], one[0]['skipped']), (0, 2))
        self.assertEqual(len(dispatch(self.pipeline, 'connectors.sync', dict(site='notion'))['results']), 1)

    def test_sync_needs_a_connection_and_running_collection(self):
        self.add_scope()
        self.refused('connectors.sync', dict(site='notion', scopeId='root'), '연결하세요')
        self.assertEqual(dispatch(self.pipeline, 'connectors.sync', {})['results'], [], 'a service nobody connected is skipped')
        self.connect()
        configure(self.pipeline, dict(autoCollect=False))
        self.refused('connectors.sync', {}, '일시중지')
        self.refused('connectors.sync', dict(site='notion', scopeId='root'), '일시중지')

    def test_disconnect(self):
        self.refused('connectors.disconnect', dict(site='slack'), '서비스')
        self.refused('connectors.disconnect', {}, '서비스')
        self.refused('connectors.disconnect', dict(site='notion', x=1), '필드')
        self.connect()
        self.add_scope()
        done = dispatch(self.pipeline, 'connectors.disconnect', dict(site='notion'))
        self.assertEqual(done, dict(site='notion', status=dict(connected=False, tokenSet=False, needs='연결 정보를 입력하세요.')))
        self.assertFalse((self.state / 'connectors' / 'notion.json').exists())
        self.assertEqual(len(dispatch(self.pipeline, 'connectors.list', {})['providers'][0]['scopes']), 1, 'the scopes stay')
        dispatch(self.pipeline, 'connectors.disconnect', dict(site='notion'))  # again: nothing to delete, no error

    def test_a_failing_provider_disconnect_still_deletes_the_token(self):
        self.connect()

        def revoke(pipeline):
            raise OSError('revoke endpoint down')
        self.provider.disconnect = revoke
        with self.quietly():
            dispatch(self.pipeline, 'connectors.disconnect', dict(site='notion'))
        self.assertFalse((self.state / 'connectors' / 'notion.json').exists())

    def test_params_must_be_an_object(self):
        with self.assertRaisesRegex(ValueError, '요청 형식'):
            dispatch(self.pipeline, 'connectors.list', [])


class LocalPage(ConnectorFixture):
    def setUp(self):
        super().setUp()
        self.srv = self.enterContext(server(Review, self.db))
        self.srv.pipeline, self.srv.team_client = self.pipeline, self.pipeline.client

    def raw(self, method, path, host=None, origin=None, body=None):
        connection = http.client.HTTPConnection('127.0.0.1', self.srv.server_port, timeout=5)
        try:
            connection.putrequest(method, path, skip_host=True)
            connection.putheader('Host', host or f'127.0.0.1:{self.srv.server_port}')
            if origin:
                connection.putheader('Origin', origin)
            if body is not None:
                connection.putheader('Content-Length', str(len(body)))
            connection.endheaders(body)
            response = connection.getresponse()
            return response.status, response.read().decode()
        finally:
            connection.close()

    def test_page_lists_the_service_its_form_and_its_scopes(self):
        status, html = get_page(self.srv, '/connectors')
        self.assertEqual(status, 200)
        for text in ('가짜 노션', '연결 필요', 'name="token"', 'action="/connectors/setup"', '범위 추가',
                     f'name="csrf" value="{self.srv.csrf}"', 'href="/"'):
            self.assertIn(text, html)
        self.assertNotIn('연결 끊기', html, 'nothing to disconnect yet')
        self.assertIn('href="/connectors"', get_page(self.srv, '/')[1], 'the review page links to it')
        self.connect()
        self.add_scope()
        html = get_page(self.srv, '/connectors?x=1')[1]
        for text in ('연결됨', '팀 페이지', '지금 가져오기', '연결 끊기', '아직 안 함', 'action="/connectors/sync"', 'action="/connectors/scope"'):
            self.assertIn(text, html)

    def test_forms_connect_choose_read_and_disconnect(self):
        status, html = post(self.srv, '/connectors/setup', dict(site='notion', token=''))
        self.assertEqual((status, '토큰을 입력하세요.' in html.decode()), (400, True), 'the provider asks for a fix in Korean')
        self.assertEqual(post(self.srv, '/connectors/setup', dict(site='notion', token=CANARY))[0], 200)
        self.assertEqual(base.load_token(self.state, 'notion'), dict(token=CANARY))
        status, html = post(self.srv, '/connectors/scope', dict(site='notion', scope_id='doc-1', title='회의록', enabled='1'))
        self.assertEqual((status, '범위를 켰습니다: 회의록' in html.decode()), (200, True))
        self.provider.documents = [document()]
        status, html = post(self.srv, '/connectors/sync', dict(site='notion', scope_id='doc-1'))
        self.assertEqual(status, 200)
        self.assertIn('새 글 2개', html.decode())
        self.assertEqual(self.scope_row('doc-1')['imported'], 2)
        self.assertIn('이미 가져온 글 2개', post(self.srv, '/connectors/sync', dict(site='notion'))[1].decode())
        post(self.srv, '/connectors/scope', dict(site='notion', scope_id='doc-1', enabled='0'))
        self.assertIn('켜세요', post(self.srv, '/connectors/sync', dict(site='notion', scope_id='doc-1'))[1].decode())
        self.provider.fail = RuntimeError(CANARY)
        post(self.srv, '/connectors/scope', dict(site='notion', scope_id='doc-1', enabled='1'))
        with self.quietly():
            text = post(self.srv, '/connectors/sync', dict(site='notion'))[1].decode()
        self.assertIn('오류 doc-1: RuntimeError', text)
        self.assertNotIn(CANARY, text)
        self.assertEqual(post(self.srv, '/connectors/scope', dict(site='notion', scope_id='doc-1', enabled='maybe'))[0], 400)
        self.assertEqual(post(self.srv, '/connectors/scope', dict(site='slack', scope_id='x', enabled='1'))[0], 400)
        self.assertEqual(post(self.srv, '/connectors/disconnect', dict(site='notion'))[0], 200)
        self.assertIsNone(base.load_token(self.state, 'notion'))
        self.assertEqual(post(self.srv, '/connectors/nothing', dict(site='notion'))[0], 404)

    def test_pausing_collection_shows_why_nothing_was_read(self):
        self.connect()
        self.add_scope()
        configure(self.pipeline, dict(autoCollect=False))
        status, html = post(self.srv, '/connectors/sync', dict(site='notion', scope_id='root'))
        self.assertEqual((status, '일시중지' in html.decode()), (400, True))
        self.assertEqual(self.provider.calls, [])

    def test_csrf_origin_and_host_are_checked_like_every_form(self):
        before = self.count('SELECT count(*) FROM connector_scopes')
        self.assertEqual(post(self.srv, '/connectors/setup', dict(csrf='wrong', site='notion', token=CANARY))[0], 403)
        self.assertEqual(post(self.srv, '/connectors/setup', dict(site='notion', token=CANARY), origin='http://evil.example')[0], 403)
        self.assertEqual(post(self.srv, '/connectors/scope', dict(csrf='wrong', site='notion', scope_id='x', enabled='1'))[0], 403)
        form = f'csrf={self.srv.csrf}&site=notion&token={CANARY}'.encode()
        self.assertEqual(self.raw('POST', '/connectors/setup', host='evil.example', body=form)[0], 403)
        self.assertEqual(self.raw('GET', '/connectors', host='evil.example')[0], 404)
        self.assertEqual(self.raw('GET', '/connectors/callback/notion?state=x', host='evil.example')[0], 404)
        self.assertIsNone(base.load_token(self.state, 'notion'))
        self.assertEqual(self.count('SELECT count(*) FROM connector_scopes'), before)
        self.assertEqual(self.provider.calls, [])

    def test_callback_reaches_the_provider(self):
        status, html = get_page(self.srv, '/connectors/callback/notion?code=abc&state=xyz')
        self.assertEqual((status, '로그인을 마쳤습니다: xyz' in html), (200, True))
        status, html = get_page(self.srv, '/connectors/callback/nowhere?state=xyz')
        self.assertEqual((status, '서비스를 확인하세요' in html), (400, True))
        self.provider.handle_callback = base.Provider.handle_callback.__get__(self.provider)
        self.assertEqual(get_page(self.srv, '/connectors/callback/notion?state=x')[0], 400)
        self.assertEqual(get_page(self.srv, '/connectors/other')[0], 404)

    def test_without_a_pipeline_the_page_does_not_exist(self):
        self.srv.pipeline = None
        self.assertEqual(get_page(self.srv, '/connectors')[0], 404)
        self.assertEqual(post(self.srv, '/connectors/setup', dict(site='notion', token=CANARY))[0], 404)
        self.assertIsNone(base.load_token(self.state, 'notion'))
        self.assertNotIn('/connectors', get_page(self.srv, '/')[1])

    def test_a_page_with_no_service_says_so(self):
        with patch.dict(base.PROVIDERS, clear=True):
            self.assertIn('아직 없습니다', get_page(self.srv, '/connectors')[1])


class FakeOllama(http.server.BaseHTTPRequestHandler):
    """The two Ollama routes files.ocr uses. server.models: /api/tags; server.chat(body) -> (status, payload)."""
    def log_message(self, *args):
        pass

    def answer(self, status, payload):
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/api/tags':
            return self.answer(200, dict(models=self.server.models))
        self.answer(404, {})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.chats.append(dict(body, path=self.path))
        self.answer(*self.server.chat(body))


def model(name, **extra):
    return dict(name=name, model=name, digest='0' * 64, **extra)


@contextmanager
def fake_ollama(models, chat=None, **env):
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), FakeOllama)
    srv.models, srv.chats = models, []
    srv.chat = chat or (lambda body: (200, dict(message=dict(role='assistant', content='페이지 본문'))))
    thread = threading.Thread(target=srv.serve_forever, args=(.05,), daemon=True)
    thread.start()
    try:
        with patch.dict(os.environ, {'OLLAMA_HOST': f'127.0.0.1:{srv.server_port}', **env}):
            os.environ.pop('SYNCUP_VISION_MODEL', None) if 'SYNCUP_VISION_MODEL' not in env else None
            yield srv
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join()


PNG = b'\x89PNG\r\n\x1a\n' + b'\x00' * 40
JPEG = b'\xff\xd8\xff\xe0' + b'\x00' * 40


def b64(raw):
    return base64.b64encode(raw).decode()


def page_of(number, raw=PNG):
    return dict(page=number, image=b64(raw))


class Ocr(PipelineFixture):
    def test_pages_are_read_in_order_by_the_first_installed_model(self):
        replies = iter(['첫 쪽 본문', '```\n둘째 쪽 | 표\n```'])
        with fake_ollama([model('qwen3.5:9b'), model('gemma4:12b'), model('gemma4:e4b-it-qat')],
                         lambda body: (200, dict(message=dict(content=next(replies))))) as ollama:
            result = dispatch(self.pipeline, 'files.ocr', dict(pages=[page_of(1), page_of(2, JPEG)], name='회의록.pdf'))
        self.assertEqual(result, dict(model='gemma4:12b', pages=[dict(page=1, ok=True, text='첫 쪽 본문'),
                                                                 dict(page=2, ok=True, text='둘째 쪽 | 표')]))
        self.assertEqual([c['path'] for c in ollama.chats], ['/api/chat', '/api/chat'])
        first = ollama.chats[0]
        self.assertEqual((first['model'], first['stream']), ('gemma4:12b', False))
        self.assertEqual(first['messages'][0]['images'], [b64(PNG)], 'the image goes to the model, as base64')
        self.assertIn('reading order', first['messages'][0]['content'])
        self.assertEqual(ollama.chats[1]['messages'][0]['images'], [b64(JPEG)])

    def test_model_choice_follows_the_order_and_the_environment(self):
        with fake_ollama([model('gemma4:e4b-it-qat'), model('gemma4:e4b'), model('gemma4:12b')]):
            self.assertEqual(vision.ocr(dict(pages=[page_of(1)]))['model'], 'gemma4:e4b')
        with fake_ollama([model('gemma4:e4b-it-qat'), model('qwen3.5:9b')], SYNCUP_VISION_MODEL='qwen3.5:9b'):
            self.assertEqual(vision.ocr(dict(pages=[page_of(1)]))['model'], 'qwen3.5:9b')
        with fake_ollama([model('gemma4:e4b')], SYNCUP_VISION_MODEL='qwen3.5:9b'):
            self.assertEqual(vision.ocr(dict(pages=[page_of(1)]))['model'], None, 'a chosen model that is not installed')
        with fake_ollama([model('gemma4:e4b'), model('x-cloud')], SYNCUP_VISION_MODEL='x-cloud'):
            self.assertEqual(vision.ocr(dict(pages=[page_of(1)]))['model'], None, 'cloud models are refused')

    def test_a_remotely_served_model_is_not_used(self):
        with fake_ollama([model('gemma4:e4b', remote_host='https://ollama.com'), model('gemma4:12b')]) as ollama:
            self.assertEqual(vision.ocr(dict(pages=[page_of(1)]))['model'], 'gemma4:12b')
        with fake_ollama([model('gemma4:e4b', remote_host='https://ollama.com')], lambda body: (200, dict(
                message=dict(content='x'), remote_host='https://ollama.com'))):
            self.assertEqual(vision.ocr(dict(pages=[page_of(1)]))['model'], None)
        with fake_ollama([model('gemma4:e4b')], lambda body: (200, dict(message=dict(content='x'), remote_model='cloud'))):
            self.assertEqual(vision.ocr(dict(pages=[page_of(1)]))['pages'][0], dict(page=1, ok=False, reason='model_unavailable'))

    def test_empty_answers(self):
        for content in ('', '   \n', '``` \n```', None):
            with self.subTest(content=content), fake_ollama([model('gemma4:e4b')], lambda body, c=content: (200, dict(message=dict(content=c)))):
                self.assertEqual(vision.ocr(dict(pages=[page_of(3)]))['pages'], [dict(page=3, ok=False, reason='empty')])

    def test_model_unavailable(self):
        with fake_ollama([model('qwen3.5:9b')]) as ollama:  # no vision model installed
            result = vision.ocr(dict(pages=[page_of(1), dict(page=2, image='%%%')]))
        self.assertEqual(result, dict(model=None, pages=[dict(page=1, ok=False, reason='model_unavailable'),
                                                         dict(page=2, ok=False, reason='bad_image')]))
        self.assertEqual(ollama.chats, [], 'no request goes out without a model')
        with patch.dict(os.environ, {'OLLAMA_HOST': '127.0.0.1:1'}):  # nothing listens
            self.assertEqual(vision.ocr(dict(pages=[page_of(1)])), dict(model=None, pages=[dict(page=1, ok=False, reason='model_unavailable')]))
        for status in (500, 503, 404):
            with self.subTest(status=status), fake_ollama([model('gemma4:e4b')], lambda body, s=status: (s, dict(error='down'))):
                self.assertEqual(vision.ocr(dict(pages=[page_of(1)]))['pages'][0]['reason'], 'model_unavailable')
        with fake_ollama([model('gemma4:e4b')], lambda body: (200, 'not an object')):
            self.assertEqual(vision.ocr(dict(pages=[page_of(1)]))['pages'][0]['reason'], 'model_unavailable')

    def test_a_slow_model_is_model_unavailable_for_that_page_only(self):
        answers = iter([lambda: time.sleep(.6), lambda: None])

        def chat(body):
            next(answers)()
            return 200, dict(message=dict(content='두 번째'))
        with fake_ollama([model('gemma4:e4b')], chat), patch.object(vision, 'PAGE_TIMEOUT', .2):
            pages = vision.ocr(dict(pages=[page_of(1), page_of(2)]))['pages']
        self.assertEqual([p.get('reason') or p['text'] for p in pages], ['model_unavailable', '두 번째'])

    def test_too_large_bad_image_and_the_pages_around_them(self):
        exactly_8_mb = PNG + b'\x00' * (8 * 1024 * 1024 - len(PNG))
        too_big = exactly_8_mb + b'\x00'
        with fake_ollama([model('gemma4:e4b')]) as ollama:
            result = vision.ocr(dict(pages=[page_of(1), page_of(2, too_big), dict(page=3, image='not base64!'),
                                            page_of(4, b'GIF89a' + b'\x00' * 20), dict(page=5, image=''),
                                            dict(page=6, image='data:image/png;base64,' + b64(PNG)), page_of(7, exactly_8_mb)]))
        reasons = [p.get('reason') or 'ok' for p in result['pages']]
        self.assertEqual(reasons, ['ok', 'too_large', 'bad_image', 'bad_image', 'bad_image', 'ok', 'ok'])
        self.assertEqual([p['page'] for p in result['pages']], [1, 2, 3, 4, 5, 6, 7])
        self.assertEqual(len(ollama.chats), 3, 'the model saw only the usable pages')
        self.assertEqual(result['model'], 'gemma4:e4b')

    def test_an_image_the_model_cannot_decode_is_bad_image(self):
        with fake_ollama([model('gemma4:e4b')], lambda body: (500, dict(error='failed to decode image: unknown format'))):
            self.assertEqual(vision.ocr(dict(pages=[page_of(1)]))['pages'][0], dict(page=1, ok=False, reason='bad_image'))

    def test_only_this_machine_is_called(self):
        for host in ('http://192.0.2.7:11434', 'ollama.example.com:11434', 'https://127.0.0.1:11434', 'http://user:pw@127.0.0.1:11434',
                     'http://127.0.0.1:11434/api', 'http://[2001:db8::1]:11434', 'http://127.0.0.1.evil.example:11434'):
            with self.subTest(host=host), patch.dict(os.environ, {'OLLAMA_HOST': host}), \
                    patch('connectors.vision.http.client.HTTPConnection') as connection:
                result = vision.ocr(dict(pages=[page_of(1)]))
                connection.assert_not_called()
                self.assertEqual(result, dict(model=None, pages=[dict(page=1, ok=False, reason='model_unavailable')]))
        for host in ('127.0.0.1:11434', 'localhost:11434', 'http://[::1]:11434', '0.0.0.0:11434', ':11434', 'http://127.0.0.1'):
            with self.subTest(host=host), patch.dict(os.environ, {'OLLAMA_HOST': host}):
                address = vision._address()
                self.assertIn(address[0], ('127.0.0.1', '::1'))
        with patch.dict(os.environ):
            os.environ.pop('OLLAMA_HOST', None)
            self.assertEqual(vision._address(), ('127.0.0.1', 11434), 'the default is this machine')

    def test_a_request_that_is_not_shaped_right_is_refused(self):
        good = page_of(1)
        for params in (dict(), dict(pages=[]), dict(pages='x'), dict(pages=[good] * (vision.MAX_PAGES + 1)), dict(pages=[good], extra=1),
                       dict(pages=[good], name=5), dict(pages=[good], name='x' * 301), dict(pages=['x']),
                       dict(pages=[dict(page=1)]), dict(pages=[dict(page='1', image=b64(PNG))]), dict(pages=[dict(page=True, image=b64(PNG))]),
                       dict(pages=[dict(page=-1, image=b64(PNG))]), dict(pages=[dict(page=1, image=b64(PNG), extra=2)])):
            with self.subTest(params=str(params)[:60]), self.assertRaises(ValueError):
                dispatch(self.pipeline, 'files.ocr', params)

    def test_text_and_images_are_not_logged(self):
        with fake_ollama([model('gemma4:e4b')], lambda body: (200, dict(message=dict(content='SECRET_PAGE_TEXT')))):
            with self.assertLogs('syncup', 'WARNING') as logs, patch.object(vision, '_clean', side_effect=RuntimeError('SECRET_PAGE_TEXT')):
                result = vision.ocr(dict(pages=[page_of(1)]))
        self.assertEqual(result['pages'][0], dict(page=1, ok=False, reason='model_unavailable'))
        self.assertNotIn('SECRET_PAGE_TEXT', ''.join(logs.output))
        self.assertNotIn(b64(PNG), ''.join(logs.output))

    def test_the_prompt_asks_for_a_faithful_transcript(self):
        for needle in ('모든 글자', '읽는 순서', '표', '설명', 'Transcribe', 'reading order', 'No commentary'):
            self.assertIn(needle, vision.PROMPT)
        self.assertEqual(vision.DEFAULT_MODELS, ('gemma4:e4b', 'gemma4:12b', 'gemma4:e4b-it-qat'))
        self.assertEqual((vision.MAX_IMAGE_BYTES, vision.PAGE_TIMEOUT), (8 * 1024 * 1024, 120))


class RealCollector(unittest.TestCase):
    """`app.py run --integrated` as a process: the /connectors page, the RPC and files.ocr are wired in the real app."""

    def test_page_rpc_and_ocr_in_the_running_collector(self):
        root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        (root / 'empty').mkdir()
        api = self.enterContext(fake_team_api(root))
        with fake_ollama([model('gemma4:e4b')], lambda body: (200, dict(message=dict(content='인식한 글')))) as ollama:
            command = [sys.executable, str(repo_paths.REPO / 'collector' / 'app.py'), 'run', '--integrated', '--port', '0',
                       '--state', str(root / 'state'), '--project', str(root), '--team-api', api.url,
                       '--team-token-file', str(api.key_file), '--team-id', FAKE_TEAM,
                       '--codex-dir', str(root / 'empty'), '--codex-sqlite-dir', str(root / 'empty'), '--claude-dir', str(root / 'empty')]
            child = subprocess.Popen(command, env={**child_environment(), 'OLLAMA_HOST': os.environ['OLLAMA_HOST']},
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
            try:
                line = first_line(child)
                self.assertTrue(line and '검토함 http://' in line, 'the collector did not start')
                port = int(re.search(r'127\.0\.0\.1:(\d+)', line).group(1))
                connection = json.loads((root / 'state' / 'connection.json').read_text())

                def call(method, path='/rpc', body=None, get=False):
                    c = http.client.HTTPConnection('127.0.0.1', port, timeout=20)
                    try:
                        c.request('GET' if get else 'POST', path, None if get else json.dumps(body or dict(version=1, method=method, params={})),
                                  {} if get else {'Authorization': 'Bearer ' + connection['token']})
                        response = c.getresponse()
                        return response.status, response.read().decode()
                    finally:
                        c.close()
                status, html = call(None, '/connectors', get=True)
                self.assertEqual((status, '외부 서비스 연결' in html), (200, True))
                self.assertIn('href="/connectors"', call(None, '/', get=True)[1])
                status, body = call('connectors.list')
                self.assertEqual((status, isinstance(json.loads(body)['result']['providers'], list)), (200, True))
                status, body = call('connectors.sync')
                self.assertEqual((status, json.loads(body)['result']), (200, dict(results=[])))
                status, body = call('connectors.setScope', body=dict(version=1, method='connectors.setScope', params=dict(
                    site='slack', scopeId='x', enabled=True)))
                self.assertEqual((status, json.loads(body)['ok']), (400, False))
                status, body = call('files.ocr', body=dict(version=1, method='files.ocr', params=dict(pages=[page_of(1)], name='a.pdf')))
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body)['result'], dict(model='gemma4:e4b', pages=[dict(page=1, ok=True, text='인식한 글')]))
                self.assertEqual(len(ollama.chats), 1)
            finally:
                child.terminate()
                child.communicate(timeout=10)


class SchemaAndLabels(unittest.TestCase):
    def test_fingerprint_is_sha256_of_the_normalized_text(self):
        self.assertEqual(base.fingerprint(' a \n b '), hashlib.sha256(b'a b').hexdigest())

    def test_register_only_takes_known_sites(self):
        class Odd(base.Provider):
            site, label = 'slack', 'Slack'
        with patch.dict(base.PROVIDERS), self.assertRaises(ValueError):
            base.register(Odd())
        with patch.dict(base.PROVIDERS):
            for site in ('notion', 'google-docs'):
                provider = type('P', (base.Provider,), dict(site=site, label='서비스'))()
                self.assertIs(base.register(provider), provider)
                self.assertIs(base.PROVIDERS[site], provider)
        self.assertTrue(re.fullmatch(r'[a-z][a-z0-9-]{0,39}', 'google-docs'))


class NativeHostTimeouts(unittest.TestCase):
    def test_only_ocr_and_connector_sync_wait_longer(self):
        import io
        import native_host
        seen = []

        class Opener:
            def open(self, request, timeout):
                seen.append(timeout)
                return io.BytesIO(b'{"ok": true, "result": {}}')

        with patch.object(native_host, 'read_connection', return_value=('http://127.0.0.1:1/rpc', 't')), \
                patch.object(native_host.urllib.request, 'build_opener', return_value=Opener()):
            for method in ('files.ocr', 'connectors.sync', 'collection.status', 'turns.append'):
                native_host.request(None, dict(version=1, method=method, params={}))
        self.assertEqual(seen, [180, 180, 20, 20])


if __name__ == '__main__':
    unittest.main(verbosity=2)
