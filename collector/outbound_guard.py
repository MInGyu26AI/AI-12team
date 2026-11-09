"""Outbound check: refuse an external AI request whose payload still carries a secret or a blocked fragment."""
from __future__ import annotations

import json
import re

from privacy_rules import secret_values


class PrivacyBlocked(RuntimeError):
    """An outgoing AI request still carried something the gate did not allow."""


# Hold reasons of a request the outbound check refused.
BLOCK_REASONS = ('secret_in_payload', 'blocked_fragment')


def blocked_reason(text: str, fragments: list[str]) -> str | None:
    """'secret_in_payload' or 'blocked_fragment' when text must not leave the device, else None."""
    if secret_values(text):
        return 'secret_in_payload'
    if any(f in text for f in fragments):
        return 'blocked_fragment'
    return None


def assert_clean(fragments: list[str], *texts: str) -> None:
    """Raise before sending when a payload still carries a secret or a blocked fragment."""
    for text in texts:
        reason = blocked_reason(text, fragments)
        if reason:
            raise PrivacyBlocked(reason)


def message_fragments(text: str) -> list[str]:
    """Pieces of a blocked message long enough to recognise if they reappear in a payload."""
    pieces = [text.strip()] + [line.strip() for line in text.splitlines()]
    pieces += [p.strip() for p in re.split(r'(?<=[.!?。])\s+|[,，]\s*', text)]
    return [p for p in pieces if len(p) >= 8]


class OutboundGuard:
    """Wraps one external AI client for one job. Refuses before sending if a payload slipped past the gate.

    Only the request methods the classifier uses are exposed, so a new one cannot pass unchecked.
    """

    def __init__(self, inner, fragments: list[str]):
        self.inner, self.fragments, self.blocked = inner, fragments, None

    def _check(self, *texts: str) -> None:
        try:
            assert_clean(self.fragments, *texts)
        except PrivacyBlocked as error:
            self.blocked = str(error)
            raise

    def chat_json(self, system: str, user: str) -> dict:
        self._check(system, user)
        return self.inner.chat_json(system, user)

    def decide(self, input_text: str, questions: list[dict]) -> dict:
        self._check(input_text, json.dumps(questions, ensure_ascii=False))
        return self.inner.decide(input_text, questions)
