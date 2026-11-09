"""Synthetic UI fixture: real local/team services, deterministic test AI; no user logs.

    python check_ui_fixture.py MARKER_FILE   # writes the connection file path to MARKER_FILE once ready
"""
import json
from pathlib import Path
import secrets
import signal
import sys
import time

from batch_classification import classify_queued
from check_team_integration import TeamIntegration
from check_teams import running_server
from collection_settings import configure
import delivery
from local_fixtures import AI, work_gate
from review_page import Review
from storage import connect
import turn_intake
from turn_pipeline import TurnPipeline


def main(marker):
    test=TeamIntegration('test_native_http_approval_delivery')
    test.setUpClass()
    try:
        test.setUp()
        with connect(test.db) as c:
            c.execute('UPDATE settings SET end=?',(time.time()+3600,))
        pipeline=TurnPipeline(test.db,test.client)
        pipeline.llm_factory=AI
        pipeline.decider_factory=lambda:None
        pipeline.privacy=work_gate()
        configure(pipeline, dict(projectTopic='가상 UI 검사',turnsPerBatch=1))
        test.publish_card('old','SQLite로 결정했다.')
        test.publish_card('new','PostgreSQL로 변경했다.')
        test.check_pair()
        test.publish_card('todo','발표 자료를 정리한다.','todo')
        turn_intake.append(pipeline, [dict(id='ui-message',conversationId='ui',site='manual',role='user',text='SQLite로 결정했다.',collectedAt='2026-11-08T00:00:00+09:00')],True)
        classify_queued(pipeline)
        with running_server(Review) as srv:
            srv.db=test.db
            srv.pipeline=pipeline
            srv.rpc_secret=secrets.token_urlsafe(32)
            connection=test.state/'connection.json'
            connection.write_text(json.dumps(dict(url=f'http://127.0.0.1:{srv.server_port}/rpc',token=srv.rpc_secret)))
            connection.chmod(0o600)
            marker.write_text(str(connection))
            print('가상 UI 검사 준비됨 · 연결 파일 경로만 기록, 실제 대화·외부 AI 사용 없음',flush=True)
            while True:
                classify_queued(pipeline)
                delivery.deliver(test.db,'','',test.client)
                time.sleep(1)
    finally:
        test.doCleanups()
        test.doClassCleanups()


if __name__=='__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    signal.signal(signal.SIGTERM,lambda *_:sys.exit(0))
    main(Path(sys.argv[1]))
