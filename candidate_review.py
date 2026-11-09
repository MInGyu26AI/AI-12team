"""Private candidate review: list, edit, dismiss and approve candidates, and retry a blocked delivery."""
import json

from ai.syncup_ai.evidence import locate_evidence, render_evidence
from ai.syncup_ai.mask import has_mask_token, mask
from card_contract import PUBLIC_FIELDS, validate_card
from delivery import CURRENT_DESTINATION, approve, reset_blocked
from storage import connect

EDITABLE = {'content', 'sentence', 'owner', 'due', 'reason', 'topic_key', 'subtopic', 'confirmedRole'}
MAX_APPROVE = 100
CANDIDATES = '''SELECT d.body,c.id,c.status,o.state AS delivery,o.detail,o.attempts,o.next_attempt
    FROM candidate_details d JOIN cards c ON c.id=d.id LEFT JOIN outbox o ON o.id=c.id
    WHERE d.team_id=? AND NOT d.dismissed AND c.status!='shared' ORDER BY c.rowid'''
CURRENT_TEAM_CANDIDATE = '''SELECT d.*,c.job,c.status FROM candidate_details d JOIN cards c ON c.id=d.id
    JOIN sharing s ON s.team_id=d.team_id WHERE d.id=? AND NOT d.dismissed'''
APPROVABLE = '''SELECT c.* FROM cards c JOIN candidate_details d ON d.id=c.id
    WHERE c.id=? AND d.team_id=? AND NOT d.dismissed'''


def _candidate(row):
    return dict(json.loads(row['body']),
                id=row['id'],
                status='candidate',
                deliveryState=row['delivery'],
                reviewState='review' if row['status'] == 'ready' else 'delivery',
                deliveryDetail=row['detail'],
                deliveryAttempts=row['attempts'],
                nextDeliveryAttemptAt=row['next_attempt'])


def list_candidates(pipeline):
    """Candidates of the current team that are neither dismissed nor shared yet."""
    with connect(pipeline.db) as c:
        team_id = c.execute('SELECT team_id FROM sharing').fetchone()[0]
        rows = c.execute(CANDIDATES, (team_id,)).fetchall()
    return [_candidate(r) for r in rows]


def sanitized_text(c, job, message_id):
    """The text of one message as the local gate cleared it for the external AI, or ''."""
    row = c.execute("SELECT detail FROM privacy_jobs WHERE job=? AND decision='allow'", (job,)).fetchone()
    item = next((d for d in json.loads(row[0]) if d['id'] == message_id), None) if row else None
    return item['sanitized'] if item and isinstance(item.get('sanitized'), str) else ''


def _ground_sentence(c, job, card):
    """Check the edited sentence against the text the external AI saw (the gate's sanitized copy) and relocate it."""
    messages = json.loads(c.execute('SELECT messages FROM job_context WHERE job=?', (job,)).fetchone()[0])
    message_id = card['evidence']['messageId']
    source = next((m for m in messages if m['id'] == message_id), None)
    if not source or not isinstance(card['sentence'], str) or not card['sentence'].strip():
        raise ValueError('입력 발화에 있는 근거를 선택하세요.')
    source_text = sanitized_text(c, job, message_id) or mask(source['text'])[0]
    if card['sentence'] in source_text:
        card['evidence'].update(locate_evidence(card['sentence'], source_text, {}))
    elif render_evidence(source_text, card['evidence']) != card['sentence']:
        raise ValueError('입력 발화에 있는 근거를 선택하세요.')


def _confirm_role(card, role):
    if role not in ('user', 'assistant'):
        raise ValueError('화자를 확인하세요.')
    card['evidence'].update(role=role, roleGuessed=False)


def update_candidate(pipeline, identifier, patch):
    """candidates.update: edits are masked, must stay grounded in the batch, and keep the public card valid."""
    if not isinstance(patch, dict) or set(patch) - EDITABLE:
        raise ValueError('수정 필드 오류')
    with pipeline.lock, connect(pipeline.db) as c:
        c.execute('BEGIN IMMEDIATE')
        row = c.execute(CURRENT_TEAM_CANDIDATE, (identifier,)).fetchone()
        if not row or row['status'] != 'ready':
            raise ValueError('수정 가능한 후보가 아닙니다.')
        card = json.loads(row['body'])
        card.update({k: mask(v)[0] if isinstance(v, str) else v for k, v in patch.items() if k != 'confirmedRole'})
        _ground_sentence(c, row['job'], card)
        if 'confirmedRole' in patch:
            _confirm_role(card, patch['confirmedRole'])
        if card['tag'] in ('decision', 'todo') and card['evidence']['role'] == 'assistant':
            raise ValueError('AI 제안은 결정·할 일로 승인할 수 없습니다. 후보를 제외하세요.')
        card['evidence']['quote'] = card['sentence']
        card['masked'] = card['masked'] or any(has_mask_token(v) for k, v in card.items() if k in PUBLIC_FIELDS and isinstance(v, str))
        validate_card({k: card[k] for k in PUBLIC_FIELDS})
        c.execute('UPDATE candidate_details SET body=? WHERE id=?', (json.dumps(card, ensure_ascii=False), identifier))
        c.execute('UPDATE cards SET draft=?,quote=?,role=? WHERE id=?',
                  (card['content'], card['sentence'], card['evidence']['role'], identifier))
    return dict(ok=True)


def dismiss_candidate(pipeline, params):
    """candidates.dismiss"""
    with connect(pipeline.db) as c:
        c.execute('''UPDATE candidate_details SET dismissed=1 WHERE id=? AND team_id=(SELECT team_id FROM sharing)
                AND id IN (SELECT id FROM cards WHERE status='ready')''', (params.get('id'),))
    return dict(ok=True)


def approve_candidates(pipeline, params):
    """candidates.approve: one failure rolls back the call, so nothing from it is queued."""
    identifiers = params.get('ids')
    if (not isinstance(identifiers, list) or not 1 <= len(identifiers) <= MAX_APPROVE
            or any(not isinstance(i, str) for i in identifiers)):
        raise ValueError('승인 후보를 확인하세요.')
    # me() is a network call, so it runs before taking the lock.
    profile = pipeline.client.me()
    with pipeline.lock, connect(pipeline.db) as c:
        c.execute('BEGIN IMMEDIATE')
        binding = dict(c.execute('SELECT * FROM sharing').fetchone())
        if params.get('teamId') != binding['team_id'] or binding['team_id'] not in {t['id'] for t in profile['teams']}:
            raise ValueError('대상 팀이 변경되었습니다. 다시 확인하세요.')
        for identifier in identifiers:
            row = c.execute(APPROVABLE, (identifier, binding['team_id'])).fetchone()
            if not row:
                raise ValueError('승인 가능한 후보가 없습니다.')
            approve(c, dict(id=identifier, text=row['draft'], quote=row['quote']).__getitem__, binding)
    return dict(items=[dict(clientItemId=i, status='queued') for i in identifiers])


def retry_delivery(pipeline, params):
    """delivery.retry: resend a blocked approval unchanged, only to the destination the binding still matches.

    local_rpc has validated id and teamId.
    """
    with pipeline.lock, connect(pipeline.db) as c:
        c.execute('BEGIN IMMEDIATE')
        if 'teamId' in params and params['teamId'] != c.execute('SELECT team_id FROM sharing').fetchone()[0]:
            raise ValueError('대상 팀이 변경되었습니다.')
        if not reset_blocked(c, params['id'], CURRENT_DESTINATION):
            raise ValueError('현재 팀에 재시도할 전송이 없습니다.')
    return dict(queued=True)
