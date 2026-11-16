"""No provider key on the PC. Wrapped by OutboundGuard after the local privacy review."""
import uuid
from ai.syncup_ai.llm import LLMError


class TeamAI:
    def __init__(self, client, team_id):
        self.client, self.team_id = client, str(uuid.UUID(str(team_id)))
        self.before_request = None

    def _call(self, operation, payload):
        if self.before_request:
            self.before_request()
        response = self.client.request(f'teams/{self.team_id}/ai/{operation}',payload,timeout=90)
        if response.get('team_id') != self.team_id or not isinstance(response.get('result'),dict):
            raise LLMError('서버 AI 응답의 팀 또는 형식이 다릅니다.')
        return response['result']

    def chat_json(self, system, user):
        return self._call('chat',dict(system=system,user=user))

    def decide(self, input_text, questions):
        return self._call('decide',dict(input=input_text,questions=questions))
