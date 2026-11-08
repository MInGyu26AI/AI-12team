"""Bounded diagnostics: never serialize exception text, input, tokens or response bodies."""
# 판단이 어디서 보류·실패했는지 확인하되 원문 노출과 복잡도를 줄이려고 최신 시도의 요약만 남긴다.
import hashlib
import json
import logging
from pathlib import Path
import time


def failure(stage, error, trace=''):
    status = getattr(error, 'code', None)
    logging.getLogger('syncup').warning(json.dumps(dict(
        stage=stage, error=type(error).__name__,
        http_status=status if type(status) is int else None,
        trace=hashlib.sha256(str(trace).encode()).hexdigest()[:12] if trace else None)))


def model_fingerprint(client):
    # Configuration can contain secrets; persist only the requested model's hash.
    model = getattr(client, 'model', None)
    return hashlib.sha256(model.encode()).hexdigest() if isinstance(model, str) and model else None


def conflict_policy_fingerprint():
    from ai.syncup_ai import config
    root = Path(__file__).parent / 'ai'
    try:
        digest = hashlib.sha256()
        for name in ('syncup_ai/conflict.py', 'syncup_ai/decide.py', 'prompts/conflict_system.md'):
            digest.update(name.encode() + b'\0' + (root / name).read_bytes() + b'\0')
        limits = {name: getattr(config, name) for name in (
            'LOW_CONFIDENCE', 'CONFLICT_TOP_K', 'CONFLICT_MAX_CANDIDATES',
            'CONFLICT_MAX_INPUT_CHARS', 'CONFLICT_CHECK_SECONDS', 'CONFLICT_ON_CHANGE')}
        digest.update(json.dumps(limits, sort_keys=True).encode())
        return digest.hexdigest()
    except OSError:
        return None


def check_started(attempt, candidate_count):
    return dict(version=1, attempt=attempt, started_at=time.time(), finished_at=None,
                elapsed_ms=None, candidate_count=candidate_count, checked_count=None,
                outcome='running', policy_sha256=None,
                requested_models=dict(decisions=None, chat=None), methods=[])


def check_finished(start, result, card_id, candidate_ids, elapsed_ms, outcome):
    """Latest-attempt metadata only; unknown coverage is never reported as zero."""
    checked, methods = None, set()
    if result.get('ok') is True and result.get('checkStatus') == 'complete':
        rows = result.get('results')
        if isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict) and rows[0].get('cardId') == card_id:
            judgements = rows[0].get('judgements')
            if isinstance(judgements, list):
                ids = [j.get('id') for j in judgements if isinstance(j, dict)]
                if (len(ids) == len(judgements) and all(isinstance(i, str) for i in ids)
                        and len(set(ids)) == len(ids) and set(ids) <= candidate_ids):
                    checked = len(ids)
                    methods = {j.get('method') for j in judgements
                               if isinstance(j.get('method'), str) and j['method'] in ('decisions', 'chat', 'rule')}
    return dict(start, finished_at=time.time(), elapsed_ms=max(0, int(elapsed_ms)),
                checked_count=checked, methods=sorted(methods), outcome=outcome)
