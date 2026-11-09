"""조정 가능한 값 모음. 숫자는 시연하면서 바꿀 예정."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # ai/
PROMPTS = ROOT / "prompts"

# ── 대화 자동 기록 기준 (이용흐름도: 10턴마다, 질문+답변 = 1턴) ──
# TODO(조정 예정): 시연하며 턴 수·문자 수 기준을 더 세밀하게 맞춘다.
TURNS_PER_BATCH = 10
CONTEXT_TURNS = 1  # 앞 배치의 마지막 N턴을 "참고용"으로만 같이 보냄 ("그걸로 하자" 같은 지시어 해석용)
MAX_AI_CHARS = 1200  # AI 답변은 길어서 앞부분만 발췌해 보냄 ("필요한 발췌만 외부 AI로")
MAX_USER_CHARS = 2000
MAX_CARDS_PER_AI_MESSAGE = 2  # AI 답변 하나에서 만들 수 있는 카드 수 상한

# ── 화면 규칙과 맞춤 (shared/labels.ts LOW_CONFIDENCE) ──
LOW_CONFIDENCE = 0.6

# ── 충돌 판정 ──
CONFLICT_TOP_K = 1  # 다른 기존 결정의 값이 섞이지 않게 한 쌍씩 전부 비교한다.
# shortcut: 합성 사례로 측정한 MVP 한도, 실제 팀 데이터 부하가 커지면 다시 평가한다.
CONFLICT_MAX_CANDIDATES = 30
CONFLICT_MAX_INPUT_CHARS = 30000
CONFLICT_CHECK_SECONDS = 90  # 새 호출 전/결과 수신 후 검사. 진행 중 HTTP 요청을 취소하지는 않는다.
# 이용흐름도는 "같음·바뀜 → 저장, 충돌 → 경고"인데, 목업·시연(MVP 범위)은 '변경'도 경고로 보여 준다.
# 팀에서 정하면 이 값만 바꾼다.
CONFLICT_ON_CHANGE = True


def load_env() -> None:
    """ai/.env 를 읽어 환경변수로 (이미 있는 값은 덮어쓰지 않음). .env 는 .gitignore 대상."""
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
