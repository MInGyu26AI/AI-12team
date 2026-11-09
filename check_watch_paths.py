"""app.watch collection paths, one loop iteration each, on a temp SQLite: no network, no Rust scanner.

Integrated: standard path (capture_local_jobs, then Pipeline.process) and then the legacy-compat drain
process(db, drafts_only=True, gate=pipeline.privacy). Non-integrated: process(db) only.
"""
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import app
from storage import connect, initialize


class _StopLoop(Exception):
    """Raised by the patched time.sleep so watch ends after one iteration."""


class FakePipeline:
    def __init__(self, calls, capture_error=None, process_error=None):
        self.calls = calls
        self.privacy = object()  # bare object: equality in call assertions means identity
        self.capture_error = capture_error
        self.process_error = process_error

    def capture_local_jobs(self):
        self.calls.append('capture_local_jobs')
        if self.capture_error:
            raise self.capture_error

    def process(self):
        self.calls.append('pipeline.process')
        if self.process_error:
            raise self.process_error


class WatchPaths(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / 'private.sqlite'; initialize(self.db)
        with connect(self.db) as c:
            c.execute("INSERT INTO settings VALUES(1,?,?,?,0,'')", (self.temp.name, time.time() - 10, time.time() + 600))
        self.calls = []

    def run_once(self, pipeline=None, scan_error=None):
        """Runs one watch iteration and returns the patched collector process."""
        def collector_process(*args, **kwargs):
            self.calls.append('process')
        with patch('app.scan', side_effect=scan_error), patch('app.process', side_effect=collector_process) as process, \
             patch('app.retention.sweep'), patch('app.time.sleep', side_effect=_StopLoop):
            with self.assertRaises(_StopLoop):
                app.watch(self.db, None, pipeline=pipeline)
        return process

    def status(self):
        with connect(self.db) as c:
            return c.execute('SELECT status FROM settings').fetchone()[0]

    def test_integrated_runs_standard_path_then_legacy_drain(self):
        pipeline = FakePipeline(self.calls)
        process = self.run_once(pipeline)
        self.assertEqual(self.calls, ['capture_local_jobs', 'pipeline.process', 'process'])
        process.assert_called_once_with(self.db, drafts_only=True, gate=pipeline.privacy)
        self.assertEqual(self.status(), '')

    def test_non_integrated_calls_process_with_db_only(self):
        process = self.run_once()
        process.assert_called_once_with(self.db)
        self.assertEqual(self.status(), '')

    def test_capture_failure_status_is_written_and_processing_continues(self):
        pipeline = FakePipeline(self.calls, capture_error=ValueError('PRIVATE_INPUT'))
        with self.assertLogs('syncup', level='WARNING') as logs:
            process = self.run_once(pipeline)
        self.assertIn('local_intake', logs.output[0])
        self.assertEqual(self.calls, ['capture_local_jobs', 'pipeline.process', 'process'])
        process.assert_called_once_with(self.db, drafts_only=True, gate=pipeline.privacy)
        self.assertEqual(self.status(), '로컬 발췌 변환 실패 · 원본 작업 보존')

    def test_scan_failure_status_is_kept_unless_capture_fails(self):
        with self.assertLogs('syncup', level='WARNING'):
            self.run_once(FakePipeline(self.calls), scan_error=OSError('source'))
        self.assertEqual(self.status(), '대화 기록 확인 실패 · OSError')
        with self.assertLogs('syncup', level='WARNING'):
            self.run_once(FakePipeline(self.calls, capture_error=ValueError('input')), scan_error=OSError('source'))
        self.assertEqual(self.status(), '로컬 발췌 변환 실패 · 원본 작업 보존')

    def test_pipeline_process_error_reaches_worker_handler(self):
        pipeline = FakePipeline(self.calls, process_error=RuntimeError('boom'))
        with self.assertLogs('syncup', level='WARNING') as logs:
            process = self.run_once(pipeline)
        process.assert_not_called()
        self.assertIn('collection_worker', logs.output[-1])
        self.assertEqual(self.status(), '대화 처리 실패 · RuntimeError')


if __name__ == '__main__':
    unittest.main(verbosity=2)
