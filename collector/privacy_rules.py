"""Format rules of the local privacy gate: secrets and contacts masked before anything else, plus the personal-word lexicon.

The rules here are policy (docs/privacy.md); change them only with the team's agreement.
"""
from __future__ import annotations

import re

from ai.syncup_ai.mask import mask as format_mask

PERSONAL_TOKEN = '[개인사정]'
SECRET_TOKEN = '[비밀키]'


# Format rules. Header and assignment forms run before bare provider tokens.
_NAME = r'[A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|client[_-]?secret|secret|token|password|passwd)'
_VALUE = r'(?!\[)[^\s"\',;{}]{4,}'
SECRET_RULES: list[tuple[str, re.Pattern, str]] = [
    ('private_key', re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|\Z)', re.S), SECRET_TOKEN),
    ('authorization', re.compile(r'(?i)(authorization\s*[:=]\s*(?:bearer|basic|token)?\s*)(?!\[)[A-Za-z0-9._~+/=-]{8,}'), r'\1' + SECRET_TOKEN),
    ('bearer', re.compile(r'(?i)(\bbearer\s+)(?!\[)[A-Za-z0-9._~+/=-]{16,}'), r'\1' + SECRET_TOKEN),
    ('url_password', re.compile(r'(?i)(\b[a-z][a-z0-9+.-]*://[^\s:/@]+:)(?!\[)[^\s@/]+(@)'), r'\1' + SECRET_TOKEN + r'\2'),
    ('assignment', re.compile(r'(?i)((?<![A-Za-z0-9])["\']?' + _NAME + r'["\']?\s*[:=]\s*["\']?)' + _VALUE), r'\1' + SECRET_TOKEN),
    # '카드 비밀번호 앞자리는 4321' style values; counts and units such as '128자', '24시간' stay readable.
    ('korean_credential', re.compile(r'((?:비밀\s*번호|비번|패스워드|PIN|핀\s*번호|인증\s*번호|OTP|카드\s*번호|보안\s*코드|CVC|CVV)[^\n\d]{0,8}?)'
                                     r'\d[\d -]{1,30}\d(?![\d자년월일시분초회개%])'), r'\1' + SECRET_TOKEN),
    ('provider_token', re.compile(r'\bsk-(?:proj-|ant-(?:api\d+-)?|live_|test_)?[A-Za-z0-9_-]{16,}'
                                  r'|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}'
                                  r'|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}'
                                  r'|\bxox[abprs]-[A-Za-z0-9-]{10,}'
                                  r'|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'), SECRET_TOKEN),
]
# Bare opaque strings: 32+ characters mixing upper, lower and digits. Lowercase hex (git SHAs)
# and UUIDs stay readable. Policy choice pending team agreement (see docs/privacy.md).
_OPAQUE = re.compile(r'(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])')


def _opaque(match: re.Match) -> str:
    value = match.group(0)
    mixed = re.search(r'[A-Z]', value) and re.search(r'[a-z]', value) and re.search(r'\d', value)
    return SECRET_TOKEN if mixed else value


def apply_rules(text: str) -> tuple[str, list[str]]:
    """Mask format-detectable secrets, then the shared format mask (contacts, keys, ids).

    Returns (text, rule names that fired); never values.
    """
    hits = []
    for name, pattern, replacement in SECRET_RULES:
        text, n = pattern.subn(replacement, text)
        if n:
            hits.append(name)
    before = text
    text = _OPAQUE.sub(_opaque, text)
    if text != before:
        hits.append('opaque')
    text, masked = format_mask(text)
    if masked:
        hits.append('format_mask')
    return text, hits


def secret_values(text: str) -> list[str]:
    """Raw secret strings the rules would mask. Used only in memory for the outbound check."""
    found = []
    for _, pattern, _ in SECRET_RULES:
        found += [m.group(0) for m in pattern.finditer(text)]
    found += [m.group(0) for m in _OPAQUE.finditer(text) if _opaque(m) == SECRET_TOKEN]
    return [f for f in found if len(f) >= 8]


# First parts of prayer compounds written without a space ('수요기도', '묵주기도'). A list, because the syllable before
# '기도' cannot tell '묵주기도' from '폴링 주기도' or '매일기도' from '일기도'. A compound whose first part is not here
# is missed unless it ends in 회·문·원.
_PRAYER_COMPOUNDS = ('께 밤'
                     ' 새벽 아침 저녁 심야 매일 주일 월요 화요 수요 목요 금요 토요 일요 백일 천일 구일 보름 정초 동지 백중'
                     ' 신년 송년 성탄 부활 사순 대림 고난 수능 입시'
                     ' 중보 감사 식사 식전 식후 취침 철야 대표 금식 통성 합심 회개 안수 방언 작정 특별 구역 연합 구국 산상'
                     ' 가정 가족 부부 개인 공동 태교 위해 묵주 화살 삼종 침묵 관상 묵상 성령 치유 축복 축사 봉헌 헌금'
                     ' 개회 폐회 마침 대적 선포 골방 무릎 눈물 서원 결단 영접 파송 임종 추모 위령 관음 지장 신중 산신 칠성'
                     ' 릴레이 수험생 초하루 다니엘').split()


def _after(words: list[str]) -> str:
    """Lookbehind for any of the words; Python takes one width per lookbehind, so one group per length."""
    return '|'.join('(?<=' + '|'.join(w for w in words if len(w) == n) + ')' for n in sorted({len(w) for w in words}))


# Personal-content lexicon: a safety net beside the model, never a reason to allow.
# Short words are bounded so common endings do not hold work sentences: '-기도' after a syllable or digit ('크기도',
# '하기도', '1기도'), the verb '빚다' ('갈등을 빚고', '차질을 빚을'), and Sino-Korean words after '우리 집' ('집계',
# '집중'). '기도' counts at the start of a word, after a listed first part or a day count ('40일기도'), and before
# 회·문·원. The match stays '기도' so a project topic such as '기도 앱' still exempts it. Other ambiguous forms such as
# '빚은'·'빚을' still match, and so do '빚고민', '빚고 뭐고', '우리 집계약', '우리 집적금', '우리 집약도'.
PERSONAL_TERMS: dict[str, re.Pattern] = {
    'health': re.compile(r'병원|진료|수술|입원|퇴원|처방|복용|약\s*먹|우울|공황|정신과|심리\s*상담|치료\s*받|진단\s*받|임신|출산|생리통'
                         r'|아파서|아프다|아픈\s*(?:데|곳)|몸이\s*안\s*좋|감기|독감|확진|건강\s*검진|투병|통증'),
    'family': re.compile(r'부모님|어머니|아버지|엄마|아빠|할머니|할아버지|가족|장례|결혼식|이혼|육아|아이가\s*아|배우자|아내|남편'),
    'relationship': re.compile(r'남자\s*친구|여자\s*친구|남친|여친|연애|헤어졌|애인|소개팅'),
    'money': re.compile(r'대출|(?<!차질을 )(?<!갈등을 )(?<!혼선을 )(?<!물의를 )(?<!논란을 )(?<!오해를 )(?<!마찰을 )빚(?![어었는게습]|고(?!민|\s*뭐고))'
                        r'|연체|월급|연봉|카드\s*값|신용\s*점수|파산|생활비|월세'),
    'belief_legal': re.compile(r'교회|성당|종교'
                               r'|(?:(?<![가-힣0-9])|(?<=[0-9]일)|' + _after(_PRAYER_COMPOUNDS) + r')기도|기도(?=회|문|원)'
                               r'|소송|고소|경찰서|성적\s*지향|커밍아웃'),
    'crisis': re.compile(r'자살|자해|죽고\s*싶'),
    'home': re.compile(r'집\s*주소|우리\s*집(?![중합단착필행권]|계(?!약)|약(?!도)|적(?!금)|무(?!너))|자택'),
}


def personal_categories(text: str, allowed: str = '') -> list[str]:
    """Lexicon categories in text. Words the user put in the project topic (e.g. 병원 for a clinic app) do not count."""
    return [name for name, pattern in PERSONAL_TERMS.items()
            if any(m.group(0) not in allowed for m in pattern.finditer(text))]

