"""collection_loop.watch paths, one loop iteration each, on a temp SQLite: no network, no Rust scanner.

Integrated: standard path (capture_scanned_jobs, then classify_queued) and then the legacy-compat drain
process(db, drafts_only=True, gate=pipeline.privacy). Non-integrated: process(db) only.
"""
import repo_paths  # noqa: F401  collector/·server/·contract/·ai 경로
import tempfile
import unittest
from unittest.mock import patch

import collection_loop
from local_fixtures import private_db
from storage import connect


class _StopLoop(Exception):
    """Raised by the patched time.sleep so watch ends after one iteration."""


class FakePipeline:
    """watch only hands the pipeline to the stage functions and gives its privacy gate to the legacy drain."""
    def __init__(self):
        self.privacy = object()  # bare object: equality in call assertions means identity


class WatchPaths(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.db = private_db(temp.name, bound=False)
        self.calls = []

    def recorder(self, name, error=None):
        def call(*args, **kwargs):
            self.calls.append(name)
            if error:
                raise error
        return call

    def run_once(self, pipeline=None, scan_error=None, capture_error=None, classify_error=None):
        """Runs one watch iteration and returns the patched collector process."""
        with patch('collection_loop.scan', side_effect=scan_error), \
             patch('collection_loop.process', side_effect=self.recorder('process')) as process, \
             patch('collection_loop.turn_intake.capture_scanned_jobs',
                   side_effect=self.recorder('capture_scanned_jobs', capture_error)), \
             patch('collection_loop.batch_classification.classify_queued',
                   side_effect=self.recorder('classify_queued', classify_error)), \
             patch('collection_loop.retention.sweep'), patch('collection_loop.time.sleep', side_effect=_StopLoop):
            with self.assertRaises(_StopLoop):
                collection_loop.watch(self.db, None, pipeline=pipeline)
        return process

    def status(self):
        with connect(self.db) as c:
            return c.execute('SELECT status FROM settings').fetchone()[0]

    def test_integrated_runs_standard_path_then_legacy_drain(self):
        pipeline = FakePipeline()
        process = self.run_once(pipeline)
        self.assertEqual(self.calls, ['capture_scanned_jobs', 'classify_queued', 'process'])
        process.assert_called_once_with(self.db, drafts_only=True, gate=pipeline.privacy)
        self.assertEqual(self.status(), '')

    def test_non_integrated_calls_process_with_db_only(self):
        process = self.run_once()
        process.assert_called_once_with(self.db)
        self.assertEqual(self.status(), '')

    def test_capture_failure_status_is_written_and_processing_continues(self):
        pipeline = FakePipeline()
        with self.assertLogs('syncup', level='WARNING') as logs:
            process = self.run_once(pipeline, capture_error=ValueError('PRIVATE_INPUT'))
        self.assertIn('local_intake', logs.output[0])
        self.assertEqual(self.calls, ['capture_scanned_jobs', 'classify_queued', 'process'])
        process.assert_called_once_with(self.db, drafts_only=True, gate=pipeline.privacy)
        self.assertEqual(self.status(), '로컬 발췌 변환 실패 · 원본 작업 보존')

    def test_scan_failure_status_is_kept_unless_capture_fails(self):
        with self.assertLogs('syncup', level='WARNING'):
            self.run_once(FakePipeline(), scan_error=OSError('source'))
        self.assertEqual(self.status(), '대화 기록 확인 실패 · OSError')
        with self.assertLogs('syncup', level='WARNING'):
            self.run_once(FakePipeline(), scan_error=OSError('source'), capture_error=ValueError('input'))
        self.assertEqual(self.status(), '로컬 발췌 변환 실패 · 원본 작업 보존')

    def test_pipeline_process_error_reaches_worker_handler(self):
        with self.assertLogs('syncup', level='WARNING') as logs:
            process = self.run_once(FakePipeline(), classify_error=RuntimeError('boom'))
        process.assert_not_called()
        self.assertIn('collection_worker', logs.output[-1])
        self.assertEqual(self.status(), '대화 처리 실패 · RuntimeError')


if __name__ == '__main__':
    unittest.main(verbosity=2)
