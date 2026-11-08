"""Synthetic UI fixture: real local/team services, deterministic test AI; no user logs."""
import json
from pathlib import Path
import secrets
import signal
import sys
import time
from check_team_integration import TeamIntegration
from check_teams import running_server
from check_pipeline import AI
from check_local_privacy import work_gate
from integration import Pipeline
from storage import connect
import app
import delivery


def main():
    test=TeamIntegration('test_native_http_approval_delivery')
    test.setUpClass()
    try:
        test.setUp()
        with connect(test.db) as c: c.execute('UPDATE settings SET end=?',(time.time()+3600,))
        pipeline=Pipeline(test.db,test.client)
        pipeline.llm_factory=AI; pipeline.decider_factory=lambda:None; pipeline.privacy=work_gate()
        pipeline.configure(dict(projectTopic='가상 UI 검사',turnsPerBatch=1))
        test.publish_card('old','SQLite로 결정했다.'); test.publish_card('new','PostgreSQL로 변경했다.'); test.check_pair()
        test.publish_card('todo','발표 자료를 정리한다.','todo')
        pipeline.append([dict(id='ui-message',conversationId='ui',site='manual',role='user',text='SQLite로 결정했다.',collectedAt='2026-11-08T00:00:00+09:00')],True)
        pipeline.process()
        with running_server(app.Review) as srv:
            srv.db=test.db; srv.pipeline=pipeline; srv.rpc_secret=secrets.token_urlsafe(32)
            connection=test.state/'connection.json'
            connection.write_text(json.dumps(dict(url=f'http://127.0.0.1:{srv.server_port}/rpc',token=srv.rpc_secret))); connection.chmod(0o600)
            marker=Path(sys.argv[1]); marker.write_text(str(connection))
            print('가상 UI 검사 준비됨 · 연결 파일 경로만 기록, 실제 대화·외부 AI 사용 없음',flush=True)
            while True:
                pipeline.process(); delivery.deliver(test.db,'','',test.client); time.sleep(1)
    finally:
        test.doCleanups(); test.doClassCleanups()


if __name__=='__main__':
    signal.signal(signal.SIGTERM,lambda *_:sys.exit(0))
    main()
