// 목업 팀·팀 결정 기록. 내용은 김민규 님 피그마 시안(2·6번 화면)에 나온 그대로.
// (평가용 샘플 대화·정답표 엑셀은 깃에 올리지 않으므로 여기에도 옮기지 않는다)
import type { TeamCriteria } from "./criteria";
import type { RelatedCard } from "./types";

export interface TeamMember {
  name: string;
  initial: string; // 아바타 글자 (피그마: 지·서·유·하)
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
  code: "SYNC-12",
  name: "AI 해커톤 12팀",
  topic: "대학생 팀용 AI 결정 기록 서비스",
  deadline: "2026-11-08",
  kind: TEAM_KINDS[0]!,
  me: "박지민",
  members: [
    { name: "박지민", initial: "지", color: "#4F46E5", ai: "ChatGPT", status: "joined", leader: true },
    { name: "이서준", initial: "서", color: "#3B9AE1", ai: "ChatGPT", status: "joined" },
    { name: "최유나", initial: "유", color: "#C2407A", ai: "ChatGPT", status: "joined" },
    { name: "정하린", initial: "하", color: "#3F9D52", ai: "ChatGPT", status: "invited" },
  ],
};

// 담당자 인식용 이름 목록 (우리 실제 팀원도 함께)
export const DEMO_KNOWN_NAMES = [...MOCK_TEAM.members.map((m) => m.name), "김동균", "김민규", "김단비", "김하은"];

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

// 팀 결정 기록 보드 (피그마 6번): 결정 5개 · 할 일 6개 + 조사 2개
export const mockCards: RelatedCard[] = [
  // ── 결정 (시간순) ──
  card({
    id: "d-target", tag: "decision", subtopic: "주제·목표", topic_key: "타깃",
    sentence: "타깃 사용자는 대학생으로 하자.", content: "타깃 사용자 = 대학생",
    reason: "팀플에서 AI 사용 비율이 가장 높음", owner: "최유나", source: "ChatGPT, 2026-11-06 19:30",
  }),
  card({
    id: "d-name", tag: "decision", subtopic: "주제·목표", topic_key: "서비스명",
    sentence: "싱크업으로 하자. Sync up이랑 Think up 둘 다 들어가서 좋다.", content: "서비스명 = 싱크업",
    reason: "Sync up + Think up 이중 의미", owner: "박지민", source: "ChatGPT, 2026-11-06 19:40",
  }),
  card({
    id: "d-mvp-later", tag: "decision", topic_key: "MVP 범위",
    sentence: "이틀 안에 브라우저 확장까지는 어려우니까 행사 끝나고 하자.", content: "브라우저 확장은 행사 이후로 미룸",
    reason: "이틀 안에 구현하기 어려움", owner: "박지민", source: "ChatGPT, 2026-11-06 19:50",
  }),
  card({
    id: "d-feature", tag: "decision", topic_key: "기능",
    sentence: "결정 충돌 감지는 MVP 핵심 기능으로 넣자.", content: "결정 충돌 감지를 MVP 핵심 기능으로 포함",
    reason: "기존 서비스와 가장 큰 차별점", owner: "정하린", source: "ChatGPT, 2026-11-06 20:05",
  }),
  card({
    id: "d-mvp-ext", tag: "decision", topic_key: "MVP 범위", is_change: true,
    sentence: "대화 자동 수집이 있어야 시연이 살 것 같아. 브라우저 확장도 MVP에 넣자.", content: "브라우저 확장을 MVP에 포함",
    reason: "대화 자동 수집이 있어야 시연 효과가 큼", owner: "이서준", source: "ChatGPT, 2026-11-06 21:10",
  }),

  // ── 할 일 ──
  card({
    id: "t-name", tag: "todo", subtopic: "역할·일정", topic_key: "팀명·서비스명",
    sentence: "팀명이랑 서비스명은 오늘 다 같이 확정하자.", content: "팀명·서비스명 확정",
    owner: "전체", due: "2026-11-06", source: "ChatGPT, 2026-11-06 19:35",
  }),
  card({
    id: "t-criteria", tag: "todo", subtopic: "역할·일정", topic_key: "분류 기준표",
    sentence: "분류 기준표를 내가 내일까지 만들어야 돼.", content: "분류 기준표 작성",
    owner: "박지민", due: "2026-11-07", source: "ChatGPT, 2026-11-06 19:45",
  }),
  card({
    id: "t-samples", tag: "todo", subtopic: "역할·일정", topic_key: "샘플 대화·정답표",
    sentence: "샘플 대화랑 정답표는 지민이가 만들어 주기로 했어.", content: "샘플 대화와 정답표",
    owner: "박지민", due: "2026-11-07", source: "ChatGPT, 2026-11-06 22:08",
  }),
  card({
    id: "t-prompt", tag: "todo", subtopic: "역할·일정", topic_key: "충돌 감지 프롬프트",
    sentence: "충돌 감지 프롬프트는 내가 내일까지 짤게.", content: "충돌 감지 프롬프트",
    owner: "정하린", due: "2026-11-07", source: "ChatGPT, 2026-11-06 22:12",
  }),
  card({
    id: "t-deploy", tag: "todo", subtopic: "역할·일정", topic_key: "API 서버 배포",
    sentence: "API 서버 배포는 내가 맡았어. 토요일 밤까지 끝낼게.", content: "API 서버 배포",
    owner: "이서준", due: "2026-11-07", source: "ChatGPT, 2026-11-06 21:15",
  }),
  card({
    id: "t-report", tag: "todo", subtopic: "발표·제출", topic_key: "중간 보고서",
    sentence: "중간 보고서는 내가 11/8까지 제출할게.", content: "중간 보고서 제출",
    owner: "최유나", due: "2026-11-08", source: "ChatGPT, 2026-11-06 23:10",
  }),

  // ── 조사 (참고 자료) ──
  card({
    id: "r-plan", tag: "research", subtopic: "자료 조사", topic_key: "경쟁 서비스",
    sentence: "ChatGPT 공유 프로젝트는 유료 팀 플랜이 필요해요.",
    content: "ChatGPT 공유 프로젝트는 유료 팀 플랜이 필요해 학생에게 부담이 될 수 있음",
    source: "ChatGPT, 2026-11-06 20:20",
  }),
  card({
    id: "r-store", tag: "research", subtopic: "자료 조사", topic_key: "브라우저 확장 심사",
    sentence: "크롬 웹스토어에 공개하려면 심사를 거쳐야 하고, 며칠이 걸릴 수 있어요.",
    content: "크롬 웹스토어 공개는 심사에 며칠이 걸릴 수 있음",
    source: "ChatGPT, 2026-11-06 21:11",
  }),
];

// 팀 기록 보드의 '완료' 체크 초기값 (피그마: 팀명·서비스명 확정만 체크됨)
export const MOCK_DONE_TODOS = ["t-name"];
