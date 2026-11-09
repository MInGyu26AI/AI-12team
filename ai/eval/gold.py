"""평가용 정답 (docs/classification.md "3. 분류 예시 22개" + 충돌 판정 예시).

민규 님 샘플 대화·정답표(xlsx, ai/data/)는 여기에 더하지 않고 eval/sheet_eval.py 가 따로 평가한다.
기준표에 없는 값(말한 사람 이름, 발화 시각)은 평가용으로 정함: 발화 시각 2026-11-06 21:00 → "내일" = 2026-11-07.
※ 분류 프롬프트(prompts/classify_system.md)의 예시는 이 문장들과 겹치지 않게 따로 만들었다 (정답 유출 방지).
"""

HACKATHON = {
    "teamName": "싱크업",
    "projectTopic": "팀원들이 각자 AI와 나눈 대화에서 결정·조사·할 일을 모아 팀 결정 보드로 공유하고 결정 충돌을 알려주는 서비스 (해커톤 출품)",
    "userName": "김단비",
    "knownNames": ["김동균", "김민규", "김단비", "김하은", "이서준", "최유나"],
    "existingTopicKeys": ["MVP 범위"],
    "existingDecisions": [{"topic_key": "MVP 범위", "content": "브라우저 확장 = 행사 이후"}],
}
CLASS = {
    "teamName": "사회통계 3조",
    "projectTopic": "청년 주거 문제 데이터 분석 보고서 (사회통계 수업 팀플)",
    "userName": "김하은",
    "knownNames": ["김하은", "최유나", "박서연", "이도현"],
    "existingTopicKeys": [],
    "existingDecisions": [],
}

# (팀, 문장, 기대 카드 목록). 카드: relevance, subtopic, tag, topic_key, owner, due, is_change, masked
# 키가 없으면 그 항목은 채점하지 않음.
P = {"relevance": "personal"}


def R(subtopic, tag, topic_key=None, **kw):
    return {"relevance": "related", "subtopic": subtopic, "tag": tag, "topic_key": topic_key, **kw}


EXAMPLES = [
    # 결정
    ("hack", "서비스명은 싱크업으로 정했어.", [R("주제·목표", "decision", "서비스명")]),
    ("hack", "타깃은 대학생으로 가자.", [R("주제·목표", "decision", "타깃")]),
    ("class", "3장 분석은 회귀분석으로 하자.", [R("작업·결과물", "decision", "분석 방법")]),
    ("hack", "승인 화면은 카드 형태로 하자.", [R("작업·결과물", "decision", "화면 구성")]),
    ("hack", "브라우저 확장도 MVP에 넣자.", [R("작업·결과물", "decision", "MVP 범위", is_change=True)]),
    ("class", "주제를 청년 주거로 하면 어때?", [R(None, "none")]),
    ("hack", "Claude가 싱크업이라는 이름을 추천했어.", [R("주제·목표", "research", "서비스명")]),
    # 할 일
    ("hack", "분류 기준표는 내가 내일까지 만들게.", [R("역할·일정", "todo", "분류 기준", owner="김단비", due="2026-11-07")]),
    ("hack", "서준이가 API 서버 배포 맡아 줘.", [R("역할·일정", "todo", "API 서버", owner="이서준", due=None)]),
    ("class", "발표는 유나가 하자.", [R("발표·제출", "todo", "발표 담당", owner="최유나")]),
    ("hack", "기준표 누가 좀 만들어야 할 텐데.", [R("역할·일정", "todo", "분류 기준", owner=None, low_conf=True)]),
    # 조사
    ("hack", "ChatGPT 공유 프로젝트는 유료 팀 플랜이 필요하대.", [R("자료 조사", "research", "경쟁 서비스")]),
    ("hack", "카카오 카나나는 그룹방 안에서 대화를 기억해.", [R("자료 조사", "research", "경쟁 서비스")]),
    ("class", "교수님이 10쪽 이내로 하랬어.", [R("과제 조건·피드백", "research", "분량")]),
    ("hack", "API 가격 비교해 보니 GPT가 제일 싸서 GPT로 가자.",
     [R("자료 조사", "research", "API 가격"), R("작업·결과물", "decision", "AI 모델")]),
    # 개인
    ("hack", "오늘 점심 김밥 먹었어.", [P]),
    ("hack", "다음 주 통계학 시험 범위 알려줘.", [P]),
    ("hack", "오늘 저녁엔 약속이 있어서 9시 이후에 볼게.", [P]),
    ("hack", "수요일 병원 가서 회의 못 갈 것 같아.", [P]),
    ("hack", "난 ChatGPT가 Claude보다 편하더라.", [P]),
    # 복합
    ("hack", "서비스명은 싱크업으로 하고, 기준표는 내가 내일까지 만들게.",
     [R("주제·목표", "decision", "서비스명"), R("역할·일정", "todo", "분류 기준", owner="김단비", due="2026-11-07")]),
    # 민감정보
    ("hack", "발표 자료는 010-1234-5678로 보내 줘.", [R("발표·제출", "todo", "발표 자료", masked=True)]),
]


# ── 충돌 판정 정답: (기존 결정, 새 결정, 기대 판정) ──
def D(id_, topic_key, content, sentence, is_change=False, owner="김단비"):
    return {"id": id_, "relevance": "related", "subtopic": "주제·목표", "tag": "decision", "topic_key": topic_key,
            "content": content, "sentence": sentence, "is_change": is_change, "owner": owner, "reason": None,
            "source": "ChatGPT, 2026-11-06 21:00", "masked": False, "confidence": 0.9, "status": "approved"}


CONFLICT_PAIRS = [
    (D("a1", "MVP 범위", "브라우저 확장 = 행사 이후", "브라우저 확장은 행사 이후로 하자."),
     D("b1", "MVP 범위", "브라우저 확장 = MVP 포함", "브라우저 확장도 MVP에 넣자.", is_change=True), "변경"),
    (D("a2", "타깃", "타깃 = 대학생", "타깃은 대학생으로 가자."),
     D("b2", "타깃", "타깃 = 직장인", "타깃은 직장인으로 하자.", owner="김동균"), "충돌"),
    (D("a3", "서비스명", "서비스명 = 싱크업", "서비스명은 싱크업으로 정했어."),
     D("b3", "서비스명", "서비스명 = 싱크업", "이름은 싱크업으로 확정!"), "같음"),
    (D("a4", "분석 방법", "3장 분석 = 회귀분석", "3장 분석은 회귀분석으로 하자."),
     D("b4", "분석 방법", "3장 분석 = 군집분석", "분석은 군집분석으로 바꾸자.", is_change=True), "변경"),
    (D("a5", "AI 모델", "AI 모델 = GPT", "GPT로 가자."),
     D("b5", "분류 모델", "분류 모델 = Claude", "분류는 Claude로 하자.", owner="김하은"), "충돌"),  # topic_key 가 달라도 잡아야 함
    (D("a6", "발표 담당", "발표 = 최유나", "발표는 유나가 하자."),
     D("b6", "발표 자료", "발표 자료 디자인 = 김민규", "발표 자료 디자인은 민규가 정하자."), "무관"),
    (D("a7", "타깃", "타깃 = 대학생", "타깃은 대학생으로 가자."),
     D("b7", "타깃", "타깃 = 해커톤 참가 대학생 팀", "타깃은 해커톤 나가는 대학생 팀으로 좁히자."), "같음"),
    (D("a8", "회의 시간", "정기 회의 = 매주 화 20시", "회의는 매주 화요일 8시에 하자."),
     D("b8", "회의 시간", "정기 회의 = 매주 목 21시", "회의 목요일 9시로 하자.", owner="김민규"), "충돌"),
]
