"""마스킹 전용 세트: 외부 AI로 보내기 직전의 형식 가림을 유형별로 잰다 (외부 AI 없이 돈다).

  python3 -m eval.mask_set            # 유형별 놓친 건수 출력, eval/results/ 에 저장
  python3 -m eval.mask_set --show     # 놓친 문장도 출력

1) 유형마다 값 5개 × 문장 틀 4개 = 20문장. 값은 모두 가짜이고, 흔한 표기와 덜 흔한 표기를 섞었다.
2) 두 단계를 따로 잰다. ai: 통합 모드 저장 전 ai/syncup_ai/mask.py, gate: 로컬 개인정보 게이트의 형식 규칙
   (collector/privacy_rules.py apply_rules, ai 가림을 포함). 외부 AI로 나가는 건 gate 를 지난 글이다.
3) 문장에 값의 어느 부분이라도 남으면 놓친 것으로 센다. 목표: 유형별 20개 중 1건 이하 (2차 최종 회의 11장).
이름·집 주소·개인 사정은 형식 규칙이 아니라 로컬 모델이 맡아서 checks/check_local_privacy_model.py 로 잰다.
"""
from __future__ import annotations

import sys
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
sys.path[1:1] = [str(_REPO), str(_REPO / "collector")]

from privacy_rules import apply_rules  # noqa: E402

from syncup_ai.mask import mask_text  # noqa: E402

from .scoring import save_result  # noqa: E402

# 유형: (값, 남으면 안 되는 부분) 5개, 문장 틀 4개. {v} 자리에 값이 들어간다.
SETS = {
    "전화": (
        [("010-2345-6789", "2345"), ("010 3456 7890", "3456"), ("01045678901", "45678901"),
         ("+82 10-5678-9012", "5678"), ("02-345-6789", "345-6789")],
        ["급하면 {v}로 전화 줘", "서버 터지면 {v} 번호로 문자 부탁", "교수님 조교실 번호 {v} 이래",
         "공지에 연락처 {v} 넣어 줘"],
    ),
    "이메일": (
        [("kim.dev@ewha-example.ac.kr", "kim.dev"), ("syncup+test@gmail-example.com", "syncup+test"),
         ("lee_prof@univ-example.ac.kr", "lee_prof"), ("team12@naver-example.com", "team12"),
         ("park.ux @ daum-example.net", "park.ux")],
        ["결과물은 {v}로 보내 줘", "제출 메일 주소는 {v}", "피드백은 {v} 쪽으로 받기로 했어",
         "계정 초대 {v} 로 해 줘"],
    ),
    "계좌": (
        [("110-234-567890", "567890"), ("3333-02-1234567", "1234567"), ("1002-345-678901", "678901"),
         ("국민 123456-01-234567", "234567"), ("352 0123 4567 83", "4567")],
        ["회비는 {v}로 보내 줘", "상금 받을 계좌 {v} 적어 둘게", "출력비 정산은 {v} 이쪽으로",
         "대표 계좌는 {v}로 하자"],
    ),
    "API 키": (
        # 가짜 키. GitHub 비밀 검사가 진짜 키로 오인하지 않게 접두사를 따로 붙인다
        [("sk-" + "proj-Ab3dEf6hIj9kLm2nOp5qRs8t", "Ab3dEf6h"), ("ghp" + "_1a2B3c4D5e6F7g8H9i0J1k2L", "1a2B3c4D"),
         ("AI" + "zaSyB1c2D3e4F5g6H7i8J9k0L1m2N3o4P5q6R", "SyB1c2D3"), ("AKIA" + "IOSFODNN7EXAMPLE", "IOSFODNN"),
         ("api_key=9f8e7d6c5b4a3210fedcba98", "9f8e7d6c")],
        ["테스트 키는 {v} 이거 쓰면 돼", "env 에 {v} 넣어 놨어", "배포 서버 키 {v} 공유할게",
         "이 키 {v} 만료됐대"],
    ),
}


def items() -> list[tuple[str, str, str]]:
    """[(유형, 문장, 남으면 안 되는 부분)] 유형마다 20개."""
    out = []
    for kind, (values, frames) in SETS.items():
        for value, secret in values:
            for frame in frames:
                out.append((kind, frame.format(v=value), secret))
    return out


def _gate(text: str) -> str:
    return apply_rules(text)[0]


def run(show: bool = False) -> dict:
    stages = {"ai": mask_text, "gate": _gate}
    result = {"target": "유형별 20개 중 1건 이하", "stages": {}}
    for stage, fn in stages.items():
        missed = {}
        for kind, text, secret in items():
            out = fn(text)
            if secret in out:
                missed.setdefault(kind, []).append(out)
        result["stages"][stage] = {kind: {"missed": len(missed.get(kind, [])), "total": 20, "examples": missed.get(kind, [])}
                                   for kind in SETS}
    for stage, kinds in result["stages"].items():
        line = ", ".join(f"{k} {v['missed']}/20" for k, v in kinds.items())
        print(f"[{stage}] 놓침 {line}")
        if show:
            for k, v in kinds.items():
                for ex in v["examples"]:
                    print(f"    {k}: {ex}")
    return result


if __name__ == "__main__":
    res = run(show="--show" in sys.argv)
    print(save_result("mask-set", res))
