"""민감정보·인증정보 가림 — 외부 AI 로 보내기 '전에' 형식이 뚜렷한 것부터 코드로 가린다.

shared/classify.ts mask() 와 같은 규칙·같은 순서. 두 쪽 모두 shared/mask-cases.json 으로 검사한다.
건강·가족·연애처럼 형식이 없는 건 프롬프트에서 AI 가 가린다.

순서: 따옴표 안 인증값 → 주소·건강정보·개인사정 라벨 값 → 인증정보(키·토큰) → 개인정보(연락처·이메일·주민번호·계좌)
  인증정보를 먼저 가려야 계좌 규칙이 토큰 안 숫자만 잘라 먹어 뒷부분이 남는 일이 없다.
  한 번 지나간 결과에 다시 걸리는 값이 있을 수 있다 (앞 규칙이 바꾼 자리 뒤에서 경계가 새로 생김).

인증정보 기준 (동균 님과 11/8 합의)
- OpenAI 키 sk-proj-… / sk-…, GitHub 토큰 ghp_… 등 / github_pat_… : 접두사로 판단. "…abcd" 같은 줄임 표기 뒷부분까지 가림
- 우리 서버 토큰(secrets.token_urlsafe(32), 43자, 접두사 없음)은 인증 문맥이 있을 때만 가림:
  Authorization: Bearer …, bearer …, "token": "…", access_token=…, api_key=…, password: … 등
- 문맥 없는 43자 문자열은 일반 식별자 오탐 때문에 가리지 않음
"""
import re

_TAIL = r"(?:(?:\.{2,3}|…)[A-Za-z0-9_-]+)?"  # "sk-proj-abcd...wxyz" 의 뒷부분까지
_VALUE_END = r"\s\"'&,;)}\]\\"  # 값 끝: 공백·따옴표·구분자·역슬래시(JSON 이스케이프)


# 아래 두 규칙은 키 이름으로 표시를 고르는 순서가 다르다 (따옴표 값은 비밀번호 먼저, 일반 값은 API키 먼저).
# 'api_key_password' 같은 이름의 결과가 달라지므로 가림 규칙을 바꾸지 않는 한 순서를 합치지 않는다.
def _quoted_secret(m: re.Match) -> str:
    key, quote = m.group(1), m.group(2)
    if re.search(r'passw', key, re.I):
        token = '[비밀번호]'
    elif re.search(r'api[_-]?key', key, re.I):
        token = '[API키]'
    else:
        token = '[액세스토큰]'
    return key + quote + token + quote


def _keyed_secret(m: re.Match) -> str:
    name = m.group(2)
    if re.search(r"api[_-]?key", name, re.I):
        token = "[API키]"
    elif re.search(r"passw", name, re.I):
        token = "[비밀번호]"
    else:
        token = "[액세스토큰]"
    return m.group(1) + token


def _label_token(prefix: str) -> str:
    """'주소: ' 같은 라벨 앞부분 → '[주소]'."""
    return '[' + re.match(r'주소|건강정보|개인사정', prefix).group() + ']'


def _quoted_label_value(m: re.Match) -> str:
    return m.group(1) + m.group(2) + _label_token(m.group(1)) + m.group(2)


def _label_value(m: re.Match) -> str:
    return m.group(1) + _label_token(m.group(1))


# (패턴, 표시 또는 함수). 함수는 match 를 받아 바꿀 문자열을 돌려준다.
SENSITIVE: list[tuple[re.Pattern, object]] = [
    # 따옴표로 감싼 값은 공백을 포함해 끝까지 가린다. 일반 토큰 규칙보다 먼저 적용한다.
    (re.compile(r'''(\b(?:\w*_)?(?:token|secret|api[_-]?key|passw(?:or)?d)["']?\s*[:=]\s*)(["'])(?!\[)([^"'\r\n]+)\2''', re.I | re.A),
     _quoted_secret),
    (re.compile(r'''((?:주소|건강정보|개인사정)\s*[:=]\s*)(["'])(?!\[)([^"'\r\n]+)\2'''), _quoted_label_value),
    # 쉼표에서 멈추지 않는다 ('건강정보: 당뇨, 고혈압', '주소: ○○로 12, 3층'). 마침표·세미콜론·줄바꿈에서 끝
    (re.compile(r'((?:주소|건강정보|개인사정)\s*[:=]\s*)(?![\s\["\x27])[^\n\r.;"\x27]+'), _label_value),
    # ── 인증정보 ──
    (re.compile(r"(?<![A-Za-z0-9_-])sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{16,}|(?=\.{3}|…))" + _TAIL), "[API키]"),
    (re.compile(r"(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})" + _TAIL), "[액세스토큰]"),
    (re.compile(r"(authorization[\"']?\s*[:=]\s*[\"']?(?:(?:bearer|basic|token)\s+)?)(?!\[)[A-Za-z0-9._~+/=-]{8,}", re.I | re.A),
     lambda m: m.group(1) + "[액세스토큰]"),
    (re.compile(r"(\bbearer\s+)(?!\[)[A-Za-z0-9._~+/=-]{8,}", re.I | re.A), lambda m: m.group(1) + "[액세스토큰]"),
    (re.compile(
        r"(\b((?:\w*_)?(?:token|secret|api[_-]?key|passw(?:or)?d))\\?[\"']?\s*[:=]\s*\\?[\"']?)"  # \" (JSON 안 JSON)도
        r"(?!\[)(?!(?:null|none|true|false|undefined)\b)(?!\d{1,9}(?![^" + _VALUE_END + r"]))"
        r"[^" + _VALUE_END + r"]{4,}",
        re.I | re.A),
     _keyed_secret),
    # 한국어 이름: '비밀번호: qwer1234', '서버 비번은 qwer1234'. 영문·숫자 값만 ('비밀번호는 8자리로'는 그대로)
    (re.compile(r"((?:비밀\s*번호|비번|패스워드)(?:\s*[:=]\s*|[은는]\s+))(?!\[)[A-Za-z0-9!@#$%^&*._+-]{4,}"),
     lambda m: m.group(1) + "[비밀번호]"),
    # ── 개인정보 ──
    # 국제 표기(+82)와 지역번호 유선전화(02·031·070 …)도 연락처다. 계좌 규칙보다 먼저 둔다.
    (re.compile(r"(?<!\d)\+82[-.\s]?0?(?:1[016789]|2|[3-6][1-5]|70)[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)"), "[연락처]"),
    (re.compile(r"(?<![\d-])0(?:2|[3-6][1-5]|70)[-.\s)]\s?\d{3,4}[-.\s]\d{4}(?!\d)"), "[연락처]"),
    (re.compile(r"01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}"), "[연락처]"),
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"), "[이메일]"),
    (re.compile(r"\d{6}-?[1-4]\d{6}"), "[주민번호]"),
    (re.compile(r"\d{3,6}-\d{2,6}-\d{4,8}"), "[계좌]"),  # 날짜(2026-11-06)는 안 걸림
    # 띄어 쓴 표기 (eval/mask_set.py v1 에서 놓친 것): "park.ux @ daum.net", "352 0123 4567 83"
    (re.compile(r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+ ?@ ?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}"), "[이메일]"),
    (re.compile(r"(?<![\d-])(?=(?:\d ?){11})\d{2,6}(?: \d{2,8}){2,4}(?![\d-])"), "[계좌]"),  # 11자리 이상만, 날짜는 안 걸림
]

# 가린 자리 표시 (코드가 쓰는 것 + 프롬프트에서 AI 가 쓰는 것). 카드 masked 판정에도 쓴다.
MASK_TOKENS = (
    "[API키]", "[액세스토큰]", "[비밀번호]",
    "[연락처]", "[이메일]", "[주민번호]", "[계좌]", "[주소]", "[건강정보]", "[금융정보]", "[개인사정]",
)


def mask(text: str) -> tuple[str, bool]:
    masked = False
    for pattern, repl in SENSITIVE:
        text, n = pattern.subn(repl, text)
        masked = masked or n > 0
    return text, masked


def mask_text(text: str) -> str:
    return mask(text)[0]


def has_mask_token(text: str) -> bool:
    return any(t in text for t in MASK_TOKENS)
