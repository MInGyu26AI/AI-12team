"""합성 팀 대화 30개와 정답표 (2차 최종 회의 11장 '데이터와 분할').

  python3 -m eval.synth            # data/synth_*.csv 3개를 만들고 문장 비율을 출력

1) 대화와 정답은 Claude(Claude Code, 11/13)가 만들었다. 파이프라인 분류 모델(OpenAI)과 다른 모델이다.
   SynTitan 은 대화문을 만들지 않으므로 보고서에 'SynTitan 합성 대화'라고 쓰지 않는다.
2) 팀 유형(해커톤 H·수업 팀플 C·공모전 P)마다 10개. 번호 1~7 은 개발용, 8~10 은 시험용 (대화 단위로 나눔).
3) 형식은 민규 님 v1 시트와 같다: synth_conversations.csv(대화), synth_answer_key.csv(문장 단위 정답),
   synth_conflict_key.csv(심어 둔 결정 쌍). 이름·연락처·계좌는 모두 가짜다.
4) 정답은 docs/classification.md 기준. 민규 님이 10%를 검수해 일치율을 기록한다.

대화 한 개: {"id", "team", "topic", "day", "turns": [...], "pairs": [(앞 키, 뒤 키, 판정)]}
턴: (말한 사람, 원문, [문장 정답...]) / ("AI", 답변) / ("@", 며칠 뒤)
문장 정답: (문장, 표시, 소주제, 세부 주제, 담당자, 기한, 변경 여부, 쌍 키)
  표시 D 결정 · T 할 일 · R 조사 · N 제안·요청 · P 개인 (개인은 문장만)
  소주제 주 작 자 역 과 발 기. 뒤쪽 칸은 생략할 수 있다. 문장에 [연락처] 같은 가림 표시가 있으면 masked=1
"""
from __future__ import annotations

import csv
from collections import Counter
from datetime import datetime, timedelta

from ..sheets import DATA
from .class_teams import TEAMS as CLASS_TEAMS
from .contest_teams import TEAMS as CONTEST_TEAMS
from .hack_teams import TEAMS as HACK_TEAMS

GROUPS = (("해커톤", HACK_TEAMS), ("수업 팀플", CLASS_TEAMS), ("공모전", CONTEST_TEAMS))
SUBTOPIC = {"주": "주제·목표", "작": "작업·결과물", "자": "자료 조사", "역": "역할·일정",
            "과": "과제 조건·피드백", "발": "발표·제출", "기": "기타"}
TAG = {"D": "결정", "T": "할 일", "R": "조사", "N": "해당 없음 (제안·요청)"}
MASKS = ("[연락처]", "[이메일]", "[계좌]", "[주민번호]", "[주소]", "[건강정보]", "[금융정보]", "[개인사정]")
GAP_MINUTES = 6


def _split(conv_id: str) -> str:
    return "dev" if int(conv_id[1:]) <= 7 else "test"


def build() -> tuple[list[list], list[list], list[list]]:
    talk, answers, pairs = [], [], []
    for kind, teams in GROUPS:
        for t in teams:
            when = datetime.fromisoformat(t["day"] + "T20:00")
            keys = {}
            turn = 0
            for item in t["turns"]:
                if item[0] == "@":
                    when = when.replace(hour=20, minute=0) + timedelta(days=item[1])
                    continue
                turn += 1
                when += timedelta(minutes=GAP_MINUTES)
                speaker, text = item[0], item[1]
                msg_id = f"{t['id']}-{turn:02d}"
                speaker_name = "ChatGPT" if speaker == "AI" else speaker
                talk.append([t["id"], _split(t["id"]), kind, t["team"], t["topic"], speaker_name, turn,
                             f"{when:%Y-%m-%d}", f"{when:%H:%M}", msg_id, text])
                units = item[2] if len(item) > 2 else [(text, "AI")]
                for k, u in enumerate(units, 1):
                    unit_id = f"{msg_id}-{k}"
                    answers.append([t["id"], unit_id, msg_id, *_answer(u, speaker_name)])
                    if len(u) > 7 and u[7]:
                        keys[u[7]] = unit_id
            for a, b, label in t.get("pairs", []):
                pairs.append([t["id"], _split(t["id"]), keys[a], keys[b], label])
    return talk, answers, pairs


def _answer(u: tuple, speaker: str) -> list:
    text, tag = u[0], u[1]
    masked = int(any(m in text for m in MASKS))
    if tag == "AI":
        return [text, "관련", "", "해당 없음 (AI 의견·제안)", "", "ChatGPT", "", "", masked]
    if tag == "P":
        return [text, "개인", "", "", "", "", "", "", masked]
    sub, topic, owner, due, change = (list(u[2:7]) + [None] * 5)[:5]
    return [text, "관련", SUBTOPIC[sub], TAG[tag], topic or "", owner or "", due or "",
            "" if tag != "D" else int(bool(change)), masked]


def write() -> None:
    talk, answers, pairs = build()
    files = {
        "synth_conversations.csv": (["conv_id", "split", "team_type", "team", "topic", "speaker", "turn", "date", "time",
                                     "message_id", "text"], talk),
        "synth_answer_key.csv": (["conv_id", "unit_id", "message_id", "text", "relevance", "subtopic", "tag",
                                  "topic_key", "owner_or_source", "due", "is_change", "masked"], answers),
        "synth_conflict_key.csv": (["conv_id", "split", "old_unit", "new_unit", "label"], pairs),
    }
    for name, (header, rows) in files.items():
        with (DATA / name).open("w", encoding="utf-8-sig", newline="") as f:
            w = csv.writer(f)
            w.writerow(header)
            w.writerows(rows)
    user_units = [a for a in answers if a[6] != "해당 없음 (AI 의견·제안)"]
    kinds = Counter("개인" if a[4] == "개인" else a[6].split(" (")[0] for a in user_units)
    n = len(user_units)
    convs = len({t[0] for t in talk})
    print(f"대화 {convs}개, 턴 {len(talk)}개, 문장 {len(answers)}개 (사용자 문장 {n}개), 결정 쌍 {len(pairs)}개")
    for k, v in kinds.most_common():
        print(f"  {k}: {v} ({v / max(n, 1):.0%})")
    print(f"  민감정보 포함: {sum(a[-1] for a in user_units)} ({sum(a[-1] for a in user_units) / max(n, 1):.0%})")
    print(f"  결정 쌍: {dict(Counter(p[4] for p in pairs))}")
