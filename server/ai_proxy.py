"""Authenticated transient AI relay. Never persist prompts, responses or provider credentials."""
import hashlib
import json
import os

from ai.syncup_ai.llm import (OpenAIResponses, DecisionsClient, OPENAI_API,
                            DEFAULT_CHAT_MODEL, DEFAULT_DECISIONS_MODEL)
from collector.privacy_rules import secret_values
from diagnostics import failure
from team_access import authorized, DatabaseSetupError

SIGNATURE = 'syncup.reserve_ai_call(text,uuid,integer,integer,integer,integer)'


def verify_enabled(dsn):
    enabled = os.environ.get('SYNCUP_AI_PROXY_ENABLED', 'false')
    if enabled not in ('true', 'false'):
        raise ValueError('Invalid AI proxy configuration')
    if enabled == 'true':
        import psycopg
        from psycopg.rows import dict_row
        limits()
        with psycopg.connect(dsn, row_factory=dict_row, connect_timeout=5) as c:
            verify(c)


class ProxyError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message


def limits():
    specs = [('USER_MINUTE',3,60), ('USER_DAY',30,1000), ('TOTAL_MINUTE',20,300), ('TOTAL_DAY',200,10000)]
    result = []
    for name, default, maximum in specs:
        value = int(os.environ.get('SYNCUP_AI_' + name, default))
        if not 1 <= value <= maximum:
            raise ValueError('Invalid AI quota configuration')
        result.append(value)
    return result


def verify(c):
    row = c.execute('''SELECT p.prosecdef,p.proconfig,o.rolsuper OR o.rolbypassrls AS bypass,
        has_function_privilege(current_user,p.oid,'EXECUTE') AS callable
        FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE p.oid=to_regprocedure(%s)''', (SIGNATURE,)).fetchone()
    table = c.execute('''SELECT relrowsecurity AND relforcerowsecurity AS rls,
        has_table_privilege(current_user,oid,'SELECT,INSERT,UPDATE,DELETE') AS direct
        FROM pg_class WHERE oid=to_regclass('syncup.ai_calls')''').fetchone()
    if not (row and row['prosecdef'] and row['bypass'] and row['callable']
            and 'search_path=pg_catalog, pg_temp' in (row['proconfig'] or [])
            and table and table['rls'] and not table['direct']):
        raise DatabaseSetupError('server/team_admin.py migrate-ai로 AI 사용량 제한을 준비하세요.')


def _text(value, maximum):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError('Invalid AI text')


def validate(operation, data):
    if not isinstance(data, dict):
        raise ValueError('Invalid AI request')
    if operation == 'chat':
        if set(data) != {'system','user'}:
            raise ValueError('Invalid chat fields')
        _text(data['system'], 12000)
        _text(data['user'], 32000)
    elif operation == 'decide':
        if set(data) != {'input','questions'}:
            raise ValueError('Invalid decision fields')
        _text(data['input'], 40000)
        questions, names = data['questions'], set()
        if not isinstance(questions, list) or not 1 <= len(questions) <= 128:
            raise ValueError('Invalid question count')
        for q in questions:
            if not isinstance(q, dict) or q.get('type') not in ('choice','predicate'):
                raise ValueError('Invalid question')
            if set(q) != ({'type','name','instructions','choices'} if q['type']=='choice' else {'type','name','instructions'}):
                raise ValueError('Invalid question fields')
            _text(q['name'],100)
            _text(q['instructions'],2000)
            if q['name'] in names:
                raise ValueError('Duplicate question')
            names.add(q['name'])
            if q['type'] == 'choice':
                choices, values = q['choices'], set()
                if not isinstance(choices,list) or not 2 <= len(choices) <= 12:
                    raise ValueError('Invalid choices')
                for choice in choices:
                    if not isinstance(choice,dict) or set(choice) != {'value','description'}:
                        raise ValueError('Invalid choice')
                    _text(choice['value'],100)
                    _text(choice['description'],1000)
                    if choice['value'] in values:
                        raise ValueError('Duplicate choice')
                    values.add(choice['value'])
    else:
        raise ProxyError(404,'지원하지 않는 AI 작업입니다.')
    raw = json.dumps(data, ensure_ascii=False)
    if len(raw.encode()) > 192 * 1024:
        raise ValueError('AI request too large')
    if secret_values(raw):
        raise ProxyError(400,'요청에 비밀정보가 감지되어 AI에 보내지 않았습니다.')


def provider(operation, data):
    key = os.environ.get('OPENAI_API_KEY','').strip()
    if not key:
        raise ProxyError(503,'서버 AI가 아직 준비되지 않았습니다.')
    if operation == 'chat':
        return OpenAIResponses(key, DEFAULT_CHAT_MODEL, max_output_tokens=4096).chat_json(data['system'],data['user'])
    return DecisionsClient(OPENAI_API,key,DEFAULT_DECISIONS_MODEL).decide(data['input'],data['questions'])


def handle(server, token, team_id, method, tail, data):
    with authorized(server.dsn,token,team_id):
        pass
    if method != 'POST' or len(tail) != 1:
        raise ProxyError(405,'허용되지 않은 AI 요청입니다.')
    if os.environ.get('SYNCUP_AI_PROXY_ENABLED') != 'true':
        raise ProxyError(503,'서버 AI가 아직 준비되지 않았습니다.')
    validate(tail[0],data)
    if not os.environ.get('OPENAI_API_KEY','').strip():
        raise ProxyError(503,'서버 AI가 아직 준비되지 않았습니다.')
    if not server.ai_slots.acquire(blocking=False):
        raise ProxyError(429,'AI 요청이 많습니다. 잠시 후 다시 시도해 주세요.')
    try:
        with authorized(server.dsn,token,team_id) as (c,_user):
            granted = c.execute('SELECT syncup.reserve_ai_call(%s,%s,%s,%s,%s,%s) AS ok',
                (hashlib.sha256(token.encode()).hexdigest(),team_id,*limits())).fetchone()['ok']
        # Commit the reservation before outbound I/O. Failed attempts still count.
        if not granted:
            raise ProxyError(429,'AI 사용 한도에 도달했습니다. 잠시 후 또는 다음 날 다시 시도해 주세요.')
        try:
            result = provider(tail[0],data)
        except ProxyError:
            raise
        except Exception as error:
            failure('ai_proxy',error,None)
            raise ProxyError(502,'서버 AI 요청을 완료하지 못했습니다.') from None
        if not isinstance(result,dict) or len(json.dumps(result).encode()) > 512 * 1024:
            raise ProxyError(502,'서버 AI 응답 형식을 확인할 수 없습니다.')
        return dict(team_id=str(team_id),result=result)
    finally:
        server.ai_slots.release()
