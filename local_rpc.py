"""Local RPC for the extension and the local web bridge: the request envelope and method dispatch to pipeline stages."""
import batch_classification
import batch_queue
import candidate_review
import collection_settings
from collection_status import collection_status
import privacy_holds
import team_relay
import turn_intake


def read_envelope(request):
    """(method, params) of a {version: 1, method, params} request; anything else is a ValueError."""
    if not isinstance(request, dict) or set(request) != {'version', 'method', 'params'}:
        raise ValueError('요청 버전 오류')
    if type(request['version']) is not int or request['version'] != 1 or not isinstance(request['method'], str):
        raise ValueError('요청 버전 오류')
    return request['method'], request['params']


def _check_retry(params):
    if not isinstance(params.get('id'), str) or not params['id']:
        raise ValueError('재시도할 항목을 확인하세요.')
    if 'teamId' in params and (not isinstance(params['teamId'], str) or not params['teamId']):
        raise ValueError('대상 팀을 확인하세요.')


def _configure(pipeline, params):
    collection_settings.configure(pipeline, params)
    return collection_status(pipeline)


def _retry_job(pipeline, params):
    _check_retry(params)
    return batch_classification.retry_failed(pipeline, params)


def _retry_delivery(pipeline, params):
    _check_retry(params)
    return candidate_review.retry_delivery(pipeline, params)


METHODS = {
    'collection.status': lambda pipeline, params: collection_status(pipeline),
    'collection.configure': _configure,
    'collection.pause': lambda pipeline, params: _configure(pipeline, dict(autoCollect=False)),
    'collection.flush': lambda pipeline, params: batch_queue.flush(pipeline),
    'turns.append': lambda pipeline, params: turn_intake.append(pipeline, params.get('messages'), params.get('flush') is True),
    'intake.issues': lambda pipeline, params: turn_intake.intake_issues(pipeline),
    'intake.retry': lambda pipeline, params: turn_intake.resolve_intake(pipeline, params, 'retry'),
    'intake.dismiss': lambda pipeline, params: turn_intake.resolve_intake(pipeline, params, 'dismiss'),
    'privacy.list': lambda pipeline, params: privacy_holds.privacy_list(pipeline),
    'privacy.exclude': lambda pipeline, params: privacy_holds.request_review(pipeline, 'privacy.exclude', params),
    'privacy.recheck': lambda pipeline, params: privacy_holds.request_review(pipeline, 'privacy.recheck', params),
    'candidates.list': lambda pipeline, params: dict(cards=candidate_review.list_candidates(pipeline),
                                                     status=collection_status(pipeline)),
    'candidates.update': lambda pipeline, params: candidate_review.update_candidate(pipeline, params.get('id'), params.get('patch')),
    'candidates.dismiss': candidate_review.dismiss_candidate,
    'candidates.approve': candidate_review.approve_candidates,
    'jobs.retry': _retry_job,
    'delivery.retry': _retry_delivery,
}


def dispatch(pipeline, method, params):
    if not isinstance(params, dict):
        raise ValueError('요청 형식 오류')
    handler = METHODS.get(method)
    if handler:
        return handler(pipeline, params)
    if method.startswith('team.'):
        return team_relay.relay(pipeline, method, params)
    raise ValueError('지원하지 않는 로컬 요청입니다.')
