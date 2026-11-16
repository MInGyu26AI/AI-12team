"""Pre-approval alert (미리 알림): the team's current decisions go into the classification prompt, and a candidate
decision that the classifier marks as a change on a topic the team already decided is flagged for its owner.

Only the owner sees the flag: it stays in the private candidate and in collection.status, never in an approval
packet (delivery sends PUBLIC_FIELDS only). The team server stays the judge: after approval it runs its own
conflict check and alerts the whole team as before.
"""
import re
import unicodedata

from stable_ids import digest
from team_client import TEAM_ERRORS

# Team decisions sent with each batch (the latest approvals), and the length of each content line.
MAX_DECISIONS = 30
MAX_CONTENT = 200
# Private key in candidate_details.body: {key, decisions} saved when the candidate was classified (stored_alert).
STORED_KEY = 'preAlertStored'
_NOT_WORD = re.compile(r'[\W_]+')


def normalized(text):
    """Text compared for the alert: NFKC, case-folded, without spaces or punctuation ('MVP 범위' == 'mvp범위')."""
    return _NOT_WORD.sub('', unicodedata.normalize('NFKC', str(text)).casefold())


def _clip(text):
    text = ' '.join(text.split())
    return text if len(text) <= MAX_CONTENT else text[:MAX_CONTENT - 1] + '…'


def _decision(item):
    """{id, topic_key, content} of a board decision with a topic, else None."""
    if not isinstance(item, dict) or item.get('tag') != 'decision' or not isinstance(item.get('id'), str):
        return None
    topic, content = item.get('topic_key'), item.get('content')
    if not isinstance(topic, str) or not isinstance(content, str) or not normalized(topic) or not content.strip():
        return None
    return dict(id=item['id'], topic_key=_clip(topic), content=_clip(content))


def current_decisions(pipeline, team_id):
    """The team's current decisions (teams/{id}/board: active and in review), the latest MAX_DECISIONS, newest first.

    [] when the team server cannot be read or answers in another shape, so classification goes on as before."""
    try:
        result = pipeline.client.request(f'teams/{team_id}/board')
    except TEAM_ERRORS:  # unreachable, HTTP error, a cut-off answer, or not JSON
        return []
    if not isinstance(result, dict) or result.get('team_id') != team_id or not isinstance(result.get('items'), list):
        return []
    decisions = [d for d in map(_decision, result['items']) if d]
    return decisions[::-1][:MAX_DECISIONS]


def changed_decisions(card, decisions):
    """The team decisions this candidate changes: the classifier marked the decision as a change (is_change), its
    topic_key is a team decision's topic and its content differs. The classifier compares meaning; the topic match
    keeps the alert to the same subject."""
    if card.get('tag') != 'decision' or card.get('is_change') is not True or not isinstance(card.get('topic_key'), str):
        return []
    topic, content = normalized(card['topic_key']), normalized(card.get('content', ''))
    if not topic:
        return []
    return [d for d in decisions if normalized(d['topic_key']) == topic and normalized(d['content']) != content]


def stored_alert(card, decisions):
    """What a classified candidate keeps under STORED_KEY, or None when it changes no team decision.

    key is fixed here, from the topic and content as classified and the team decisions: two conversations that produce
    the same decision share it and are announced once, and editing the wording in review does not announce it again."""
    changed = changed_decisions(card, decisions)
    if not changed:
        return None
    key = digest([normalized(card['topic_key']), normalized(card['content']), sorted(d['id'] for d in changed)])
    return dict(key=key, decisions=changed)


def pre_alert(card, stored):
    """The alert shown for a candidate now, or None. stored = its STORED_KEY value.

    Checked again against the card as it is now, so an edited topic or content that no longer differs clears it."""
    decisions = changed_decisions(card, stored['decisions']) if stored else []
    if not decisions:
        return None
    return dict(key=stored['key'], topicKey=decisions[0]['topic_key'], decisions=decisions)


def summaries(alerts):
    """collection.status preAlerts: one entry per key with the number of candidates, in first-seen order."""
    grouped = {}
    for alert in alerts:
        entry = grouped.setdefault(alert['key'], dict(alert, candidates=0))
        entry['candidates'] += 1
    return list(grouped.values())
