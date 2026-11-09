"""One background worker per team that keeps running due conflict checks until none remain.

There is no always-on worker: any successful team request schedules one with the caller's token,
which is also how checks interrupted by a restart are picked up again.
"""
import threading
import time

import psycopg

from conflict_checks import process_checks
from diagnostics import failure
from team_access import authorized

DB_RETRY_SECONDS = 5
POLL_MIN_SECONDS, POLL_MAX_SECONDS = .05, 1  # wait for the next due pair, but recheck at least once a second

_running = {}  # (server, team) -> wake event of the worker for that team
_lock = threading.Lock()


def schedule(server, token, team_id):
    """Start the team's worker, or wake the running one so it looks for new work once more."""
    if getattr(server, 'disable_checks', False) or server.checks_stop.is_set():
        return
    key = (id(server), str(team_id))
    with _lock:
        if key in _running:
            _running[key].set()
            return
        wake = threading.Event()
        _running[key] = wake
    threading.Thread(target=_work, args=(server, token, team_id, key, wake), daemon=True).start()


def _work(server, token, team_id, key, wake):
    try:
        while not server.checks_stop.is_set():
            wake.clear()
            try:
                process_checks(server, token, team_id)
                due = _next_due(server.dsn, token, team_id)
            except (psycopg.OperationalError, psycopg.InterfaceError) as error:
                failure('conflict_database', error, team_id)
                server.checks_stop.wait(DB_RETRY_SECONDS)
                continue
            if due is None:
                with _lock:
                    # A wake-up during this pass may have brought new work: look once more before stopping.
                    if wake.is_set():
                        continue
                    _running.pop(key, None)
                    return
            # Credentials stay in memory; every slice rechecks membership and token expiry.
            wake.wait(min(POLL_MAX_SECONDS, max(POLL_MIN_SECONDS, due.timestamp() - time.time())))
    except Exception as error:
        failure('conflict_worker', error, team_id)
    finally:
        with _lock:
            if _running.get(key) is wake:
                _running.pop(key, None)


def _next_due(dsn, token, team_id):
    with authorized(dsn, token, team_id) as (c, _user):
        return c.execute("""SELECT min(next_attempt) AS due FROM syncup.conflict_checks
            WHERE team_id=%s AND state IN ('pending','running')""", (team_id,)).fetchone()['due']
