"""Local RPC for the extension and the local web bridge: the request envelope and method dispatch to pipeline stages."""
import batch_classification
import batch_queue
import candidate_review
import collection_settings
from collection_status import collection_status
from connectors import base as connector_base
from connectors import vision
import privacy_holds
import team_relay
import turn_intake

RPC_VERSION = 1  # shared/collector.ts LOCAL_RPC_VERSION


def read_envelope(request):
    """(method, params) of a {version: RPC_VERSION, method, params} request; anything else is a ValueError."""
    if not isinstance(request, dict) or set(request) != {'version', 'method', 'params'}:
        raise ValueError('요청 버전 오류')
    if type(request['version']) is not int or request['version'] != RPC_VERSION or not isinstance(request['method'], str):
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


def _check_connector_fields(params, allowed):
    if set(params) - allowed:
        raise ValueError('연결 요청 필드 오류')


def _connectors_list(pipeline, params):
    """Every provider with its status (connected, tokenSet, needs: never a token) and the scopes of the current team."""
    _check_connector_fields(params, set())
    connector_base.load_providers()
    scopes = {}
    for row in connector_base.list_scopes(pipeline):
        scopes.setdefault(row['site'], []).append(connector_base.scope_info(row))
    return dict(providers=[dict(site=p.site, label=p.label, status=connector_base.provider_status(pipeline, p),
                                scopes=scopes.get(p.site, [])) for p in connector_base.PROVIDERS.values()])


def _connectors_set_scope(pipeline, params):
    _check_connector_fields(params, {'site', 'scopeId', 'title', 'enabled'})
    if type(params.get('enabled')) is not bool:
        raise ValueError('사용 여부를 확인하세요.')
    return connector_base.set_scope(pipeline, params.get('site'), params.get('scopeId'), params.get('title'), params['enabled'])


def _connectors_sync(pipeline, params):
    """Read now: one scope, every enabled scope of one service, or of all. A failing service is an `error` kind in its
    result and in the scope's lastError; a ValueError is only for a request that cannot run (paused, unknown scope)."""
    _check_connector_fields(params, {'site', 'scopeId'})
    for key in params:
        if not isinstance(params[key], str) or not params[key].strip():
            raise ValueError('연결할 서비스와 범위를 확인하세요.')
    return dict(results=connector_base.run_selected(pipeline, params.get('site'), params.get('scopeId')))


def _connectors_disconnect(pipeline, params):
    """Forget the connection (connector_base.disconnect): the token file goes, the scopes stay."""
    _check_connector_fields(params, {'site'})
    provider = connector_base.disconnect(pipeline, params.get('site'))
    return dict(site=provider.site, status=connector_base.provider_status(pipeline, provider))


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
    'privacy.exclude': privacy_holds.exclude_messages,
    'privacy.recheck': privacy_holds.recheck_batch,
    'candidates.list': lambda pipeline, params: dict(cards=candidate_review.list_candidates(pipeline),
                                                     status=collection_status(pipeline)),
    'candidates.update': lambda pipeline, params: candidate_review.update_candidate(pipeline, params.get('id'), params.get('patch')),
    'candidates.dismiss': candidate_review.dismiss_candidate,
    'candidates.approve': candidate_review.approve_candidates,
    'jobs.retry': _retry_job,
    'delivery.retry': _retry_delivery,
    'connectors.list': _connectors_list,
    'connectors.setScope': _connectors_set_scope,
    'connectors.sync': _connectors_sync,
    'connectors.disconnect': _connectors_disconnect,
    'files.ocr': lambda pipeline, params: vision.ocr(params),
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
