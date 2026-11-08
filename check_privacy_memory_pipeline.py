"""Opt-in actual default model -> privacy gate -> local approval; synthetic inputs, external AI intercepted."""
import json
from check_local_privacy import Base, offline, responses, MIXED, SECRETS
from local_privacy import Gate, OllamaClassifier, DEFAULT_MODEL, POLICY_VERSION
from storage import connect


def main():
    classifier=OllamaClassifier(DEFAULT_MODEL)
    summary=dict(model=DEFAULT_MODEL,policy=POLICY_VERSION,cases=[])
    for kind,text,forbidden in [
        ('work','SQLite 사용을 결정했다.',[]),
        ('mixed',MIXED,['병원']),
        ('personal','요즘 불면증 때문에 약을 먹기 시작했어',['불면증']),
        ('secret','API 명세를 오늘 정리할게. '+SECRETS['openai_project'],[SECRETS['openai_project'].split('=',1)[1]])]:
        test=Base();test.setUp()
        try:
            test.pipeline.privacy=Gate(classifier)
            test.pipeline.append([test.message(kind,text)],True)
            def reply(body):
                return responses(dict(cards=[] if kind!='mixed' else [dict(msg=1,relevance='related',tag='todo',
                    subtopic='작업·결과물',sentence='발표자료는 금요일에 공유할게',content='발표자료 금요일 공유',
                    topic_key='발표자료',confidence=.9,owner='테스트')]))
            with offline(test.requests,reply,loopback=True): test.pipeline.process()
            assert len(test.requests)==(0 if kind=='personal' else 1),kind
            assert all(value not in r['body']['input'] for value in forbidden for r in test.requests),kind
            approved=0
            if kind=='mixed':
                card=test.pipeline.rpc('candidates.list',{})['cards'][0]
                test.pipeline.rpc('candidates.approve',dict(ids=[card['id']],teamId='a'))
                with connect(test.db) as c:
                    assert '병원' not in c.execute('SELECT payload FROM outbox').fetchone()[0]
                    assert c.execute('SELECT team_id FROM outbox_destinations').fetchone()[0]=='a'
                approved=1
            summary['cases'].append(dict(kind=kind,intercepted_external_requests=len(test.requests),local_approved=approved))
        finally:
            test.doCleanups()
    test=Base();test.setUp()
    try:
        test.pipeline.privacy=Gate(OllamaClassifier('syncup-missing-memory-check:never-installed'))
        test.pipeline.append([test.message('missing','SQLite 사용을 결정했다.')],True)
        with offline(test.requests,loopback=True):test.pipeline.process()
        assert not test.requests and test.pipeline.status()['counts']['privacyHeld']==1
        summary['missing_model_holds_without_external_request']=True
    finally:
        test.doCleanups()
        classifier._call('POST','/api/generate',dict(model=DEFAULT_MODEL,keep_alive=0),60)
    summary['status']='PASS'
    print(json.dumps(summary,ensure_ascii=False))


if __name__=='__main__': main()
