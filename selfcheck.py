"""Run with --live to also check research classification against both APIs."""
import json
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

import collector
from check_local_privacy import work_gate

# --live uses the real on-device gate; offline checks use the test classifier.
GATE = None if "--live" in sys.argv else work_gate()


def check(db):
    collector.initialize(db)
    with collector.connect(db) as c:
        c.execute("INSERT INTO settings VALUES(1,'/demo',?,?,0,'')",(time.time()-10,time.time()+300))
        evidence=json.dumps([{"n":1,"role":"user","text":"실험 결과를 공유해. 같은 샘플 100개에서 캐시 적용 시 평균 응답 시간이 300ms에서 180ms로 줄었어."}],ensure_ascii=False)
        c.execute("INSERT INTO jobs VALUES('test',?,'new','')",(evidence,))
    if "--live" in sys.argv:
        api=collector.call_api
        def observed(*args):
            result=api(*args)
            print([(a.get("name"),a.get("probability")) for a in result.get("answers",[])])
            return result
        with patch.object(collector,"call_api",side_effect=observed):
            collector.process(db, gate=GATE)
        collector.process(db, gate=GATE)
        with collector.connect(db) as c:
            row=c.execute("SELECT kind,status,quote FROM cards WHERE kind='research'").fetchone()
            print("Research check:", [tuple(j) for j in c.execute("SELECT state,detail FROM jobs")], [tuple(j) for j in c.execute("SELECT kind,status FROM cards")], flush=True)
            assert row and row["status"]=="ready" and row["quote"] in json.loads(evidence)[0]["text"]
            print("PASS research · Decisions + Terra · exact quotation")
        sensitive=json.dumps([{"n":1,"role":"user","text":"[CONFIDENTIAL] 가상 테스트 결정: 예시 버튼 색상은 파랑으로 확정. 이 문장은 팀에 공유하지 마."}],ensure_ascii=False)
        with collector.connect(db) as c:
            c.execute("INSERT INTO jobs VALUES('sensitive',?,'new','')",(sensitive,))
        collector.process(db, gate=GATE)
        with collector.connect(db) as c:
            assert c.execute("SELECT state FROM jobs WHERE id='sensitive'").fetchone()[0]=="done"
            assert not c.execute("SELECT 1 FROM cards WHERE job='sensitive'").fetchone()
            print("PASS private sample produces zero cards")
    with collector.connect(db) as c:
        c.execute("INSERT INTO jobs VALUES('fallback',?,'draft','')",(evidence,))
        c.execute("INSERT INTO cards VALUES('fallback-card','fallback','task',0,NULL,NULL,NULL,'drafting')")
    with patch.object(collector,"call_api",side_effect=ValueError("test service unavailable")):
        collector.process(db, gate=GATE)
    with collector.connect(db) as c:
        assert c.execute("SELECT status FROM cards WHERE id='fallback-card'").fetchone()[0]=="manual"
        assert c.execute("SELECT evidence FROM jobs WHERE id='fallback'").fetchone()[0]==evidence
        c.execute("UPDATE settings SET end=start")
    with patch("urllib.request.urlopen",side_effect=AssertionError("unexpected network access")):
        try: collector.call_api(db,"decisions",{})
        except ValueError: pass
        else: raise AssertionError("expired window allowed an API call")
        collector.scan(db,Path("/missing-index"))
    print("PASS Terra failure preserves evidence · expired window skips input and API")


if __name__=="__main__":
    with tempfile.TemporaryDirectory() as tmp:
        check(Path(tmp)/"test.sqlite")
