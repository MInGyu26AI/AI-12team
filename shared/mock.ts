// 목업 팀·팀 결정 기록 (공개 시연, NEXT_PUBLIC_USE_MOCK=true).
// 내용은 하은 님 합성 대화·정답표의 해커톤 팀 H01 '온길'(ai/eval/synth/hack_teams.py)에서 골랐다. 이름·연락처는 모두 가짜.
// 시각은 합성 정답표 규칙(eval/synth build: 하루 20:00 시작, 발화마다 6분)을 따른다.
// 정답표 밖에서 덧붙인 것은 두 가지뿐이고 아래에 표시했다: (1) 'QR 대신 NFC' 제안을 AI가 확신 없이 결정으로 본 상황(확인 필요 시연),
// (2) 변경 시연용 문장 1줄 (합성 대화는 대화마다 정답 충돌 쌍이 1개라 한 팀으로는 충돌·변경·확인 필요를 다 보여 줄 수 없음)
import type { TeamCriteria } from "./criteria";
import type { RelatedCard } from "./types";

export interface TeamMember {
  name: string;
  initial: string; // 아바타 글자
  color: string; // 아바타 색
  ai: string; // 주로 쓰는 AI
  status: "joined" | "invited";
  leader?: boolean;
}

export interface Team {
  code: string; // 초대 코드
  name: string;
  topic: string; // 프로젝트 주제 (AI 분류·충돌 기준)
  deadline: string; // YYYY-MM-DD
  kind: string; // 팀 종류
  members: TeamMember[];
  me: string; // 지금 이 브라우저의 사용자 (로그인 붙기 전 임시)
  criteria?: TeamCriteria; // 팀 목표·범위·규칙 (선택)
}

export const TEAM_KINDS = ["해커톤 (단기 팀)", "수업 팀플 (학기)", "동아리·사이드 프로젝트"];

export const MOCK_TEAM: Team = {
  code: "ONGIL-01",
  name: "온길",
  topic: "시각장애인 대학생을 위한 캠퍼스 실내 길안내 앱",
  deadline: "2026-11-08",
  kind: TEAM_KINDS[0]!,
  me: "김도윤",
  members: [
    { name: "김도윤", initial: "도", color: "#4F46E5", ai: "ChatGPT", status: "joined", leader: true },
    { name: "서하준", initial: "하", color: "#3B9AE1", ai: "ChatGPT", status: "joined" },
    { name: "윤채원", initial: "채", color: "#C2407A", ai: "Claude", status: "joined" },
  ],
  // 팀 기준 예시 (팀 만들기 화면에서 바꿀 수 있음)
  criteria: {
    teamGoal: "시각장애인 대학생이 캠퍼스 건물 안에서 혼자 길을 찾게 돕기",
    teamRules: ["개인 사정·연락처는 팀에 올리지 않기"],
  },
};

// 붙여넣기 분류의 담당자 인식용 이름 목록 (목업 팀원만. 실제 사람 이름은 넣지 않는다)
export const DEMO_KNOWN_NAMES = MOCK_TEAM.members.map((m) => m.name);

const card = (c: Partial<RelatedCard> & Pick<RelatedCard, "id" | "sentence" | "tag" | "content" | "source">): RelatedCard => ({
  relevance: "related",
  subtopic: "작업·결과물",
  topic_key: null,
  is_new_topic: false,
  reason: null,
  owner: null,
  due: null,
  is_change: false,
  masked: false,
  confidence: 0.9,
  status: "approved",
  ...c,
});

// 팀 결정 기록 보드: 결정 5개 · 할 일 1개 · 조사 1개. 승인 순서 = 시간순 (목업 충돌 판정이 이 순서로 비교한다)
// 보드에 보이는 경고: 충돌 1 (MVP 범위) · 변경 1 · 확인 필요 2 (실내 위치 확인 방식)
export const mockCards: RelatedCard[] = [
  // ── 11/2 (H01 첫날) ──
  card({
    id: "d-mvp-indoor", tag: "decision", topic_key: "MVP 범위",
    sentence: "MVP는 실내 길안내만 하고 실외는 빼자.", content: "MVP는 실내 길안내만 (실외 제외)",
    owner: "김도윤", source: "ChatGPT, 2026-11-02 20:06",
  }),
  card({
    id: "t-flow", tag: "todo", topic_key: "화면 흐름도",
    sentence: "화면 흐름도는 내가 내일까지 그릴게.", content: "화면 흐름도 그리기",
    owner: "김도윤", due: "2026-11-03", source: "ChatGPT, 2026-11-02 20:06",
  }),
  card({
    id: "r-floorplan", tag: "research", subtopic: "자료 조사", topic_key: "건물 도면",
    sentence: "찾아보니 교내 건물 도면은 시설팀에 요청하면 받을 수 있대.", content: "교내 건물 도면은 시설팀에 요청하면 받을 수 있음",
    source: "ChatGPT, 2026-11-02 20:18",
  }),
  card({
    id: "d-qr", tag: "decision", topic_key: "실내 위치 확인 방식",
    sentence: "실내 위치 확인은 QR 방식으로 가자. 비콘은 예산이 안 돼.", content: "실내 위치 확인은 QR 방식",
    reason: "비콘은 예산이 안 됨", owner: "윤채원", source: "ChatGPT, 2026-11-02 20:30",
  }),
  // ── 11/3 ──
  // 정답표 충돌 쌍 (a ↔ b): 다른 사람이 같은 세부 주제를 반대로 정함
  card({
    id: "d-mvp-outdoor", tag: "decision", topic_key: "MVP 범위", is_change: true,
    sentence: "실외 길안내도 MVP에 넣자. 심사위원은 캠퍼스 전체를 보고 싶어 할 거야.", content: "실외 길안내도 MVP에 포함",
    reason: "심사위원은 캠퍼스 전체를 보고 싶어 할 것", owner: "서하준", source: "ChatGPT, 2026-11-03 20:06",
  }),
  // 덧붙임 (1): 정답표에서는 제안(N)이다. AI가 결정인지 확신하지 못한 경우(확신도 0.45)를 보여 주려고 결정 후보로 둠 → '확인 필요'
  card({
    id: "d-nfc", tag: "decision", topic_key: "실내 위치 확인 방식", is_change: true, confidence: 0.45,
    sentence: "QR 대신 NFC 태그는 어때?", content: "실내 위치 확인을 QR 대신 NFC 태그로",
    owner: "윤채원", source: "ChatGPT, 2026-11-03 20:24",
  }),
  // ── 11/4 ──
  // 덧붙임 (2): 변경 시연용 문장. 팀 합의로 기존 결정을 바꿈 → '변경'. 이유는 H01 대화의 AI 답변("QR 코드 옆에 점자 표지를…")
  card({
    id: "d-qr-braille", tag: "decision", topic_key: "실내 위치 확인 방식", is_change: true,
    sentence: "회의에서 다들 동의해서 실내 위치 확인은 QR에 점자 표지를 같이 붙이는 걸로 바꿨어.",
    content: "실내 위치 확인은 QR + 점자 표지", reason: "QR 코드 옆에 점자 표지가 있으면 찾기 쉬움",
    owner: "김도윤", source: "ChatGPT, 2026-11-04 20:06",
  }),
];

// 팀 기록 보드의 '완료' 체크 초기값 (화면 흐름도는 기한 11/3이 지나 완료)
export const MOCK_DONE_TODOS = ["t-flow"];
