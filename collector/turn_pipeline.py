"""Shared state of the turn pipeline (integrated mode): extension turns -> batches -> private candidates -> approval.

Each stage is its own module and takes a TurnPipeline:
turn_intake (receive and quarantine turns), batch_queue (group them into jobs), batch_classification (privacy gate,
then external AI), candidate_review (edit and approve), privacy_holds (held and excluded messages),
collection_settings and collection_status, team_relay (team requests); local_rpc dispatches RPC methods to them.
"""
from contextlib import contextmanager
import threading

from ai.syncup_ai.config import load_env
from ai.syncup_ai.llm import decider_from_env, from_env
from collection_settings import cache_profile
import local_privacy
from pipeline_schema import ensure_pipeline_schema
from privacy_model import classifier_from_env
from storage import connect


class TurnPipeline:
    def __init__(self, db, client, profile=None):
        self.db, self.client = db, client
        # Serialises the pipeline's own writes (see write()); other local writers rely on SQLite's write lock only.
        self.lock = threading.RLock()
        # One classification run at a time; it does not hold self.lock during AI calls.
        self.process_lock = threading.Lock()
        self.llm_factory = from_env
        self.decider_factory = decider_from_env
        ensure_pipeline_schema(db)
        if profile is not None:
            with connect(db) as c:
                cache_profile(c, profile)
        load_env()
        # Every external AI request passes this on-device gate first; tests replace the classifier.
        self.privacy = local_privacy.Gate(classifier_from_env())

    @contextmanager
    def write(self):
        """The write transaction of a pipeline RPC method or worker step: self.lock, then BEGIN IMMEDIATE; rolled back on
        error. Make network calls (the team client) before entering it.

        Writers that take BEGIN IMMEDIATE (or an implicit transaction) without self.lock, unchanged from before the split:
        the classification run's writes (batch_classification, so configure() can run during an AI call), the review
        page's form actions, approval delivery, retention and the legacy collector drain.
        """
        with self.lock, connect(self.db) as c:
            c.execute('BEGIN IMMEDIATE')
            yield c
