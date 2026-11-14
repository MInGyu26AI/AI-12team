"""The project topic shared by the team: collection.configure sends a changed topic to the team first,
sync_team_topic follows the team's topic, and the relay changes the team settings (server/team_settings.py)."""
import repo_paths  # noqa: F401
from datetime import datetime, timezone
import tempfile
import unittest

import collection_loop
from collection_settings import configure, read_options, sync_team_topic
from local_fixtures import AI, PipelineFixture, make_pipeline, private_db, work_gate
from storage import connect
import team_relay


def now():
    return datetime.now(timezone.utc).isoformat()


class TeamTopic(PipelineFixture):
    def setUp(self):
        super().setUp()  # make_pipeline sets 'SyncUp' while the stand-in answers like an older team server (404)
        self.client = self.pipeline.client
        self.client.team_settings = {}

    def topic(self):
        with connect(self.db) as c:
            return read_options(c)['projectTopic']

    def test_older_team_server_keeps_the_topic_local(self):
        self.client.team_settings = None
        configure(self.pipeline, dict(projectTopic='혼자 쓰는 주제'))
        self.assertEqual(self.topic(), '혼자 쓰는 주제')
        self.assertIsNone(sync_team_topic(self.pipeline))
        self.assertEqual(self.topic(), '혼자 쓰는 주제')

    def test_a_changed_topic_goes_to_the_team_before_it_is_saved(self):
        configure(self.pipeline, dict(projectTopic='  팀 AI 메모리  '))
        self.assertEqual(self.client.settings_posts, [('a', {'topic': '팀 AI 메모리'})])
        self.assertEqual(self.topic(), '  팀 AI 메모리  ')
        configure(self.pipeline, dict(projectTopic='팀 AI 메모리'))  # same topic: nothing new is sent
        self.assertEqual(len(self.client.settings_posts), 1)

    def test_a_refused_topic_is_not_saved_locally(self):
        def refuse(path, data=None):
            raise OSError('팀 서버 없음')
        self.client.request = refuse
        with self.assertRaisesRegex(ValueError, '팀 서버에 프로젝트 주제를 저장하지 못했습니다'):
            configure(self.pipeline, dict(projectTopic='바뀐 주제'))
        self.assertEqual(self.topic(), 'SyncUp')

    def test_other_settings_do_not_touch_the_team(self):
        configure(self.pipeline, dict(turnsPerBatch=2))
        self.assertEqual(self.client.settings_posts, [])

    def test_collector_follows_the_team_topic(self):
        self.client.team_settings['a'] = dict(topic='다른 팀원이 정한 주제', goal='', scope='', rules=[], updatedAt=now())
        self.assertEqual(sync_team_topic(self.pipeline), '다른 팀원이 정한 주제')
        self.assertEqual(self.topic(), '다른 팀원이 정한 주제')
        self.assertEqual(self.client.settings_posts, [])

    def test_first_topic_seeds_a_team_without_settings(self):
        self.assertEqual(sync_team_topic(self.pipeline), 'SyncUp')
        self.assertEqual(self.client.settings_posts, [('a', {'topic': 'SyncUp'})])
        self.assertEqual(sync_team_topic(self.pipeline), 'SyncUp')  # seeded once; the team now has a topic
        self.assertEqual(len(self.client.settings_posts), 1)

    def test_a_topic_the_team_cleared_stays_cleared(self):
        self.client.team_settings['a'] = dict(topic='', goal='', scope='', rules=[], updatedAt=now())
        self.assertEqual(sync_team_topic(self.pipeline), '')
        self.assertEqual(self.topic(), '')
        self.assertEqual(self.client.settings_posts, [])

    def test_no_bound_team_follows_nothing(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        pipeline = make_pipeline(private_db(temp.name, bound=False), lambda: AI(), work_gate())
        pipeline.client.team_settings = {}
        self.assertIsNone(sync_team_topic(pipeline))
        self.assertEqual(pipeline.client.settings_posts, [])

    def test_a_reply_for_another_team_is_refused(self):
        self.client.request = lambda path, data=None: dict(team_id='b', settings=dict(topic='남의 팀', updatedAt=now()))
        with self.assertRaisesRegex(ValueError, '팀 설정 응답 오류'):
            sync_team_topic(self.pipeline)
        self.assertEqual(self.topic(), 'SyncUp')

    def test_loop_skips_an_unreachable_team_server_quietly(self):
        def offline(path, data=None):
            raise OSError('연결 안 됨')
        self.client.request = offline
        collection_loop.follow_team_topic(self.pipeline)  # no exception, no change
        self.assertEqual(self.topic(), 'SyncUp')

    def test_relay_reads_and_changes_team_settings(self):
        self.client.team_settings['a'] = dict(topic='주제', goal='', scope='', rules=[], updatedAt=now())
        self.assertEqual(team_relay.relay(self.pipeline, 'team.settings', {})['settings']['topic'], '주제')
        result = team_relay.relay(self.pipeline, 'team.updateSettings', dict(goal='11/16 제출', rules=['개인 일정 금지']))
        self.assertEqual((result['settings']['goal'], result['settings']['rules']), ('11/16 제출', ['개인 일정 금지']))
        self.assertEqual(self.client.settings_posts[-1], ('a', dict(goal='11/16 제출', rules=['개인 일정 금지'])))
        for bad in ({}, dict(goal='x', id='card'), dict(teamName='x')):
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, '팀 설정 필드 오류'):
                team_relay.relay(self.pipeline, 'team.updateSettings', bad)


if __name__ == '__main__':
    unittest.main()
