"""Background workers of the review service: the collection loop (scan, classify, retention) and approval delivery."""
import subprocess
import time

import batch_classification
from collection_session import active, config
from collection_settings import sync_team_topic
from scanner_runner import scan
from standalone_classifier import process
from delivery import deliver
from diagnostics import failure
import retention
from storage import connect
import turn_intake

RETENTION_SECONDS = 3600
LOOP_SECONDS = 2
DELIVERY_SECONDS = 1
TEAM_SETTINGS_SECONDS = 30  # how soon a topic another member changed reaches this collector


def follow_team_topic(pipeline):
    """One sync_team_topic; an unreachable team server is skipped quietly (local recovery mode keeps working)."""
    try:
        sync_team_topic(pipeline)
    except OSError:
        pass
    except Exception as error:
        failure('team_settings', error)


def send_approved(srv):
    while True:
        try:
            deliver(srv.db, srv.team_client)
        except Exception as error:
            failure('delivery', error)
        time.sleep(DELIVERY_SECONDS)


def run_integrated(db, pipeline):
    """Integrated collection after a scan; returns the status to show instead of the scan's, or None.

    Standard path: capture_scanned_jobs moves new scanned jobs into the pipeline's intake, then
    classify_queued classifies its batches. Legacy drain: process(drafts_only=True) only finishes
    'draft' jobs left by the pre-integration collector. Integrated mode never classifies new jobs into 'draft', and
    its review page retries only integrated jobs, so 'failed_draft' jobs (from before integration or from this drain)
    are never retried (existing behavior).
    """
    status = None
    try:
        turn_intake.capture_scanned_jobs(pipeline)
    except Exception as error:
        failure('local_intake', error)
        status = '로컬 발췌 변환 실패 · 원본 작업 보존'
    batch_classification.classify_queued(pipeline)
    process(db, drafts_only=True, gate=pipeline.privacy)
    return status


def _set_status(db, status):
    with connect(db) as c:
        c.execute("UPDATE settings SET status=?", (status,))


def _collect_once(db, sources, pipeline):
    scan_status = ""
    try:
        scan(db, *sources)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        failure('collection_scan', error, detail=getattr(error, 'detail', None))
        scan_status = "대화 기록 확인 실패 · " + getattr(error, 'summary', type(error).__name__)
    if pipeline:
        scan_status = run_integrated(db, pipeline) or scan_status
    else:
        process(db)
    _set_status(db, scan_status)


def watch(db, codex, claude=None, codex_sqlite=None, claude_project=None, pipeline=None):
    """Collection loop. With a pipeline (--integrated) it runs run_integrated: the standard path, then
    the legacy-compat drain. Without one, process(db) classifies and drafts every job itself."""
    sources = (codex, claude, codex_sqlite, claude_project)
    last_retention = last_team_settings = 0
    while True:
        # The shared topic is followed even while collection is paused, so it is right when collection resumes.
        if pipeline and time.time() - last_team_settings >= TEAM_SETTINGS_SECONDS:
            last_team_settings = time.time()
            follow_team_topic(pipeline)
        # Retention runs even while collection is paused or ended: settled raw text still expires.
        if time.time() - last_retention >= RETENTION_SECONDS:
            last_retention = time.time()
            try:
                retention.sweep(db)
            except Exception as error:
                failure('retention', error)
        try:
            if active(config(db)):
                _collect_once(db, sources, pipeline)
        except Exception as e:
            failure('collection_worker', e)
            _set_status(db, "대화 처리 실패 · " + type(e).__name__)
        time.sleep(LOOP_SECONDS)
