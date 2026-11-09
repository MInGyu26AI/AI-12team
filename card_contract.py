"""Public card validation shared by local approval and the team trust boundary, and the card label table."""
import math
from datetime import date

from ai.syncup_ai.schema import RELATED_FIELDS, SUBTOPICS

# Card text and quote limit; storage.py's SQL CHECKs and web/src/components/review/candidate-card.tsx repeat it.
MAX_TEXT = 1200
LABELS = {'decision': '결정', 'todo': '할 일', 'research': '조사'}
# The local cards table names the todo tag 'task'.
KIND_OF_TAG = {'decision': 'decision', 'todo': 'task', 'research': 'research'}
KIND_LABELS = {KIND_OF_TAG[tag]: label for tag, label in LABELS.items()}
# Legacy (version 1) decisions whose adoption was not confirmed; storage.py's board CHECK repeats it.
UNADOPTED_LABEL = '결정 · 채택 미확인'
TAG_OF_LABEL = {label: tag for tag, label in LABELS.items()} | {UNADOPTED_LABEL: 'decision'}
PUBLIC_FIELDS = set(RELATED_FIELDS) | {'classificationMethod'}


def card_label(kind, adopted):
    """Board label of a local card kind ('decision', 'task', 'research')."""
    return UNADOPTED_LABEL if kind == 'decision' and not adopted else KIND_LABELS[kind]


def validate_card(card):
    if not isinstance(card, dict) or set(card) != PUBLIC_FIELDS:
        raise ValueError('공유 카드 필드를 확인하세요.')
    if card['relevance'] != 'related' or card['tag'] not in LABELS or card['subtopic'] not in SUBTOPICS:
        raise ValueError('공유할 수 없는 카드입니다.')
    for key in ('sentence', 'topic_key', 'content', 'source'):
        if not isinstance(card[key], str) or not 0 < len(card[key].strip()) <= MAX_TEXT:
            raise ValueError('카드 내용과 근거를 확인하세요.')
    for key in ('owner', 'reason'):
        if card[key] is not None and (not isinstance(card[key], str) or len(card[key]) > MAX_TEXT):
            raise ValueError('담당자 또는 이유 형식 오류')
    for key in ('is_new_topic', 'is_change', 'masked'):
        if type(card[key]) is not bool:
            raise ValueError('카드 상태 형식 오류')
    value = card['confidence']
    if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
        raise ValueError('확신도 형식 오류')
    if card['due'] is not None:
        if not isinstance(card['due'], str) or date.fromisoformat(card['due']).isoformat() != card['due']:
            raise ValueError('기한 형식 오류')
    # The classifier's two methods; board_card's 'manual' is display only and never validated here.
    if card['classificationMethod'] not in ('chat', 'decisions'):
        raise ValueError('분류 방식 오류')


def validate_v2(packet):
    if set(packet) != {'id', 'label', 'text', 'quote', 'speaker', 'version', 'card'} or type(packet['version']) is not int or packet['version'] != 2:
        raise ValueError('승인 형식 오류')
    card = packet['card']
    validate_card(card)
    if (packet['text'] != card['content'] or packet['quote'] != card['sentence']
            or packet['label'] != LABELS[card['tag']]):
        raise ValueError('승인 문구와 카드가 다릅니다.')
    if card['tag'] in ('decision', 'todo') and packet['speaker'] != '사용자':
        raise ValueError('AI 제안은 결정이나 할 일로 승인할 수 없습니다.')


def board_card(row):
    """Legacy approved content remains visible; no owner/topic is invented."""
    p = row['packet']
    if p.get('version') == 2:
        card = dict(p['card'])
    else:
        card = dict(relevance='related', tag=TAG_OF_LABEL[p['label']], subtopic='기타', topic_key=None,
                    sentence=p['quote'], content=p['text'], source='기존 로컬 승인',
                    owner=None, due=None, reason=None, is_change=False, is_new_topic=False,
                    masked=False, confidence=0, classificationMethod='manual')
    return dict(card, id=p['id'], status='approved', approvedBy=row['approved_by'],
                approvedAt=row['approved_at'])
