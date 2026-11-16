"""Server-mode dispatch keeps the existing local hold, secret and session boundaries."""
import repo_paths
import unittest
import uuid
from unittest.mock import Mock, patch
from ai.syncup_ai.llm import from_env, decider_from_env
from batch_classification import classify_queued, _guarded_clients
from collection_settings import configure
from local_fixtures import PrivacyFixture, KEEP, Scripted
from local_privacy import Gate
from team_ai import TeamAI
import turn_intake


class LocalRelayTests(PrivacyFixture):
    def setUp(self):
        super().setUp()
        self.pipeline.llm_factory = from_env
        self.pipeline.decider_factory = decider_from_env
        self.pipeline.server_ai = True

    def test_hold_and_pause_never_construct_remote_client(self):
        self.pipeline.privacy = Gate(Scripted(mode='timeout'))
        turn_intake.append(self.pipeline,[self.message('one',KEEP)],True)
        with patch('team_ai.TeamAI') as remote:
            classify_queued(self.pipeline)
            remote.assert_not_called()
            configure(self.pipeline,dict(autoCollect=False))
            self.pipeline.privacy = Gate(Scripted())
            classify_queued(self.pipeline)
            remote.assert_not_called()

    def test_guard_masks_blocked_fragment_and_rechecks_session(self):
        team = str(uuid.uuid4())
        self.pipeline.client = Mock()
        self.pipeline.client.request.return_value = dict(team_id=team,result={'cards':[]})
        review = Mock(fragments=['PRIVATE_FRAGMENT_CANARY'])
        with patch('batch_classification.require_active') as active:
            llm,decider = _guarded_clients(self.pipeline,{'team_id':team},{'collectionStart':1},review)
            self.assertEqual(llm.chat_json('Return JSON','synthetic work'),{'cards':[]})
            self.assertEqual(self.pipeline.client.request.call_count,1)
            active.assert_called_once_with(self.pipeline.db,team,1)
            from outbound_guard import PrivacyBlocked
            with self.assertRaises(PrivacyBlocked):
                llm.chat_json('Return JSON','PRIVATE_FRAGMENT_CANARY')
            self.assertTrue(llm.blocked)
            self.assertEqual(self.pipeline.client.request.call_count,1)
            active.side_effect = ValueError('paused')
            with self.assertRaises(ValueError):
                decider.decide('synthetic work',[])
            self.assertEqual(self.pipeline.client.request.call_count,1)

    def test_response_team_mismatch_is_rejected(self):
        client = Mock()
        client.request.return_value = dict(team_id=str(uuid.uuid4()),result={})
        from ai.syncup_ai.llm import LLMError
        with self.assertRaises(LLMError):
            TeamAI(client,str(uuid.uuid4())).chat_json('system','user')


if __name__ == '__main__':
    unittest.main()
