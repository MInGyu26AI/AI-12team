"""Opt-in actual default model -> privacy gate -> local approval; synthetic inputs, external AI intercepted."""
import json
from batch_classification import classify_queued
from collection_status import collection_status
from local_fixtures import MIXED, SECRETS, PrivacyFixture, offline, responses
from local_privacy import Gate, POLICY_VERSION
from local_rpc import dispatch
from privacy_model import DEFAULT_MODEL, OllamaClassifier
from storage import connect
import turn_intake


def main():
    classifier=OllamaClassifier(DEFAULT_MODEL)
    summary=dict(model=DEFAULT_MODEL,policy=POLICY_VERSION,cases=[])
    for kind,text,forbidden in [
        ('work','SQLite 사용을 결정했다.',[]),
        ('mixed',MIXED,['병원']),
        ('personal','요즘 불면증 때문에 약을 먹기 시작했어',['불면증']),
        ('secret','API 명세를 오늘 정리할게. '+SECRETS['openai_project'],[SECRETS['openai_project'].split('=',1)[1]])]:
        test=PrivacyFixture()
        test.setUp()
        try:
            test.pipeline.privacy=Gate(classifier)
            turn_intake.append(test.pipeline, [test.message(kind,text)],True)
            def reply(body):
                return responses(dict(cards=[] if kind!='mixed' else [dict(msg=1,relevance='related',tag='todo',
                    subtopic='작업·결과물',sentence='발표자료는 금요일에 공유할게',content='발표자료 금요일 공유',
                    topic_key='발표자료',confidence=.9,owner='테스트')]))
            with offline(test.requests,reply,loopback=True):
                classify_queued(test.pipeline)
            assert len(test.requests)==(0 if kind=='personal' else 1),kind
            assert all(value not in r['body']['input'] for value in forbidden for r in test.requests),kind
            approved=0
            if kind=='mixed':
                card=dispatch(test.pipeline, 'candidates.list',{})['cards'][0]
                dispatch(test.pipeline, 'candidates.approve',dict(ids=[card['id']],teamId='a'))
                with connect(test.db) as c:
                    assert '병원' not in c.execute('SELECT payload FROM outbox').fetchone()[0]
                    assert c.execute('SELECT team_id FROM outbox_destinations').fetchone()[0]=='a'
                approved=1
            summary['cases'].append(dict(kind=kind,intercepted_external_requests=len(test.requests),local_approved=approved))
        finally:
            test.doCleanups()
    test=PrivacyFixture()
    test.setUp()
    try:
        test.pipeline.privacy=Gate(OllamaClassifier('syncup-missing-memory-check:never-installed'))
        turn_intake.append(test.pipeline, [test.message('missing','SQLite 사용을 결정했다.')],True)
        with offline(test.requests,loopback=True):
            classify_queued(test.pipeline)
        assert not test.requests and collection_status(test.pipeline)['counts']['privacyHeld']==1
        summary['missing_model_holds_without_external_request']=True
    finally:
        test.doCleanups()
        classifier._call('POST','/api/generate',dict(model=DEFAULT_MODEL,keep_alive=0),60)
    summary['status']='PASS'
    print(json.dumps(summary,ensure_ascii=False))


if __name__=='__main__':
    main()
