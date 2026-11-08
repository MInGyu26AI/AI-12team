"""가림은 명시된 원문 구간만 치환한다. 자리표시자를 임의 문자열 와일드카드로 쓰지 않는다."""
from .mask import MASK_TOKENS, mask_text


def render_evidence(text: str, evidence: dict) -> str:
    start, end = evidence.get('sourceStart'), evidence.get('sourceEnd')
    if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(text):
        raise ValueError('근거 범위 오류')
    quote = text[start:end]
    cursor, parts = 0, []
    for span in evidence.get('redactions', []):
        a, b, token = span.get('start'), span.get('end'), span.get('token')
        if (type(a) is not int or type(b) is not int or not cursor <= a < b <= len(quote)
                or token not in MASK_TOKENS):
            raise ValueError('가림 범위 오류')
        parts.extend((quote[cursor:a], token))
        cursor = b
    return ''.join(parts) + quote[cursor:]


def locate_evidence(sentence: str, text: str, raw: dict) -> dict:
    if sentence in text:
        return {}
    original = raw.get('source_sentence')
    edits = raw.get('redactions')
    if not isinstance(original, str) or not original or not isinstance(edits, list) or not edits:
        raise ValueError('분류 결과의 가림 근거가 없습니다.')
    original = mask_text(original)
    if original not in text:
        raise ValueError('분류 결과의 근거가 입력 발화에 없습니다.')
    spans, cursor = [], 0
    for edit in edits:
        if not isinstance(edit, dict) or not isinstance(edit.get('text'), str) or not edit['text']:
            raise ValueError('가림 내용 오류')
        value = mask_text(edit['text'])
        start = original.find(value, cursor)
        if start < 0 or edit.get('token') not in MASK_TOKENS:
            raise ValueError('가림 내용이 원문과 다릅니다.')
        cursor = start + len(value)
        spans.append(dict(start=start, end=cursor, token=edit['token']))
    start = text.index(original)
    evidence = dict(sourceStart=start, sourceEnd=start + len(original), redactions=spans)
    if render_evidence(text, evidence) != sentence:
        raise ValueError('가림 외에 근거 문장을 변경할 수 없습니다.')
    return evidence
