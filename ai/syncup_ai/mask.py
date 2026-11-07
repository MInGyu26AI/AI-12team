"""민감정보 가림 — 외부 AI 로 보내기 '전에' 형식이 뚜렷한 것부터 코드로 가린다.
(shared/classify.ts mask() 와 같은 규칙. 건강·가족·연애처럼 형식이 없는 건 프롬프트에서 AI 가 가림)
"""
import re

SENSITIVE: list[tuple[re.Pattern, str]] = [
    (re.compile(r"01[016789][-.\s]?\d{3,4}[-.\s]?\d{4}"), "[연락처]"),
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"), "[이메일]"),
    (re.compile(r"\d{6}-?[1-4]\d{6}"), "[주민번호]"),
    (re.compile(r"\d{3,6}-\d{2,6}-\d{4,8}"), "[계좌]"),  # 날짜(2026-11-06)는 안 걸림
]

# AI 가 가린 자리 표시 (프롬프트에서 이 이름들만 쓰게 함)
MASK_TOKENS = ("[연락처]", "[이메일]", "[주민번호]", "[계좌]", "[주소]", "[건강정보]", "[금융정보]", "[개인사정]")


def mask(text: str) -> tuple[str, bool]:
    masked = False
    for pattern, label in SENSITIVE:
        text, n = pattern.subn(label, text)
        masked = masked or n > 0
    return text, masked


def has_mask_token(text: str) -> bool:
    return any(t in text for t in MASK_TOKENS)
