// docs/classification.md "3. 분류 예시 22개"를 그대로 옮긴 목업.
// 한 문장을 나누는 예시 2개(API 가격, 복합)는 카드 2장씩 → 22문장 = 24장.
// 팀 종류(해커톤/수업 팀플/공통)가 섞여 있지만 목업에서는 한 팀으로 본다.
// 기준표에 없는 값(source 시각, 결정자·"내가"의 실제 이름, confidence)은 목업용으로 채움.
// 팀원: 김동균·김민규·김단비·김하은. 문장에 이름이 나오는 예시(서준이, 유나)만 기준표대로 이서준·최유나.
import type { Card, Conflict, PersonalCard, RelatedCard } from "./types";

export const MOCK_TEAM_CODE = "SYNC-2026";

let n = 0;
const at = (time: string) => `ChatGPT, 2026-11-06 ${time}`;

const rel = (c: Partial<RelatedCard> & Pick<RelatedCard, "sentence" | "tag" | "content">): RelatedCard => ({
  id: `c${++n}`,
  relevance: "related",
  subtopic: null,
  topic_key: null,
  is_new_topic: false,
  reason: null,
  owner: null,
  due: null,
  is_change: false,
  source: at("21:00"),
  masked: false,
  confidence: 0.85,
  status: "candidate",
  ...c,
});

const personal = (source: string, masked = false, confidence = 0.9): PersonalCard => ({
  id: `c${++n}`,
  relevance: "personal",
  source,
  masked,
  confidence,
  status: "candidate",
});

// 충돌 데모용 기존 결정 "브라우저 확장은 행사 이후로" (22개 외 추가, 결정자 김하은)
export const priorMvpDecision: RelatedCard = rel({
  sentence: "브라우저 확장은 행사 이후로 하자.",
  subtopic: "작업·결과물",
  tag: "decision",
  topic_key: "MVP 범위",
  is_new_topic: true,
  content: "브라우저 확장 = 행사 이후",
  owner: "김하은",
  source: "ChatGPT, 2026-11-05 20:40",
  status: "approved",
});

export const mockCards: Card[] = [
  priorMvpDecision,

  // ── 결정 ──
  rel({ sentence: "서비스명은 싱크업으로 정했어.", subtopic: "주제·목표", tag: "decision", topic_key: "서비스명", is_new_topic: true,
    content: "서비스명 = 싱크업", owner: "김단비", source: at("20:05"), confidence: 0.95, status: "approved" }), // 해커톤 · 확정 표현
  rel({ sentence: "타깃은 대학생으로 가자.", subtopic: "주제·목표", tag: "decision", topic_key: "타깃", is_new_topic: true,
    content: "타깃 = 대학생", owner: "김민규", source: at("20:12"), confidence: 0.92, status: "approved" }), // 해커톤 · 합의 표현
  rel({ sentence: "3장 분석은 회귀분석으로 하자.", subtopic: "작업·결과물", tag: "decision", topic_key: "분석 방법", is_new_topic: true,
    content: "3장 분석 = 회귀분석", owner: "김하은", source: at("20:20"), confidence: 0.9, status: "approved" }), // 수업 팀플 · 확정 표현
  rel({ sentence: "승인 화면은 카드 형태로 하자.", subtopic: "작업·결과물", tag: "decision", topic_key: "화면 구성", is_new_topic: true,
    content: "승인 화면 = 카드 형태", owner: "김민규", source: at("20:31"), confidence: 0.9, status: "approved" }), // 해커톤 · 확정 표현
  rel({ sentence: "브라우저 확장도 MVP에 넣자.", subtopic: "작업·결과물", tag: "decision", topic_key: "MVP 범위",
    content: "브라우저 확장 = MVP 포함", owner: "김단비", is_change: true, source: at("21:10"), confidence: 0.85, status: "approved" }), // (헷갈림) 기존 결정과 같은 세부 주제 → 충돌 확인
  rel({ sentence: "주제를 청년 주거로 하면 어때?", tag: "none",
    content: "주제를 청년 주거로 제안", source: at("21:14"), confidence: 0.8 }), // (헷갈림) 수업 팀플 · 확정 표현 없음 → 공유 후보 제외
  rel({ sentence: "Claude가 싱크업이라는 이름을 추천했어.", subtopic: "주제·목표", tag: "research", topic_key: "서비스명",
    content: "Claude가 '싱크업' 이름 추천", source: at("21:18"), confidence: 0.7 }), // (헷갈림) AI 제안 전달, 팀 수용 표현 없음

  // ── 할 일 ──
  rel({ sentence: "분류 기준표는 내가 내일까지 만들게.", subtopic: "역할·일정", tag: "todo", topic_key: "분류 기준", is_new_topic: true,
    content: "분류 기준표 만들기", owner: "김민규", due: "2026-11-07", source: at("21:22"), confidence: 0.9, status: "approved" }), // 담당: 말한 사람, 기한: 다음 날
  rel({ sentence: "서준이가 API 서버 배포 맡아 줘.", subtopic: "역할·일정", tag: "todo", topic_key: "API 서버", is_new_topic: true,
    content: "API 서버 배포", owner: "이서준", source: at("21:25"), confidence: 0.88, status: "approved" }), // 담당: 이서준, 기한: 미정
  rel({ sentence: "발표는 유나가 하자.", subtopic: "발표·제출", tag: "todo", topic_key: "발표 담당", is_new_topic: true,
    content: "발표 담당 = 최유나", owner: "최유나", source: at("21:27"), confidence: 0.86, status: "approved" }), // 수업 팀플
  rel({ sentence: "기준표 누가 좀 만들어야 할 텐데.", subtopic: "역할·일정", tag: "todo", topic_key: "분류 기준",
    content: "분류 기준표 만들 사람 필요", source: at("21:29"), confidence: 0.5 }), // (헷갈림) 담당: 미정 → 확인 필요

  // ── 조사 ──
  rel({ sentence: "ChatGPT 공유 프로젝트는 유료 팀 플랜이 필요하대.", subtopic: "자료 조사", tag: "research", topic_key: "경쟁 서비스", is_new_topic: true,
    content: "ChatGPT 공유 프로젝트 = 유료 팀 플랜 필요", source: at("21:33"), confidence: 0.9, status: "approved" }),
  rel({ sentence: "카카오 카나나는 그룹방 안에서 대화를 기억해.", subtopic: "자료 조사", tag: "research", topic_key: "경쟁 서비스",
    content: "카카오 카나나 = 그룹방 대화 기억", source: at("21:36"), confidence: 0.88, status: "approved" }),
  rel({ sentence: "교수님이 10쪽 이내로 하랬어.", subtopic: "과제 조건·피드백", tag: "research", topic_key: "분량", is_new_topic: true,
    content: "보고서 분량 = 10쪽 이내", source: at("21:40"), confidence: 0.9, status: "approved" }), // 수업 팀플 · 외부 조건
  // (헷갈림) 한 문장을 나눔: 조사(가격 비교) + 결정(GPT 사용)
  rel({ sentence: "API 가격 비교해 보니 GPT가 제일 싸서", subtopic: "자료 조사", tag: "research", topic_key: "API 가격", is_new_topic: true,
    content: "API 가격 비교 결과 GPT가 가장 저렴", source: at("21:44"), confidence: 0.8 }),
  rel({ sentence: "GPT로 가자.", subtopic: "작업·결과물", tag: "decision", topic_key: "AI 모델", is_new_topic: true,
    content: "AI 모델 = GPT", reason: "API 가격이 가장 저렴", owner: "김하은", source: at("21:44"), confidence: 0.8 }),

  // ── 개인 (sentence 저장 안 함) ──
  personal(at("21:50")), // 오늘 점심 김밥 먹었어.
  personal(at("21:52")), // 다음 주 통계학 시험 범위 알려줘.
  personal(at("21:55")), // 오늘 저녁엔 약속이 있어서 9시 이후에 볼게.
  personal(at("21:58"), true, 0.75), // (헷갈림) 수요일 병원 가서 회의 못 갈 것 같아. — 건강 정보
  personal(at("22:01"), false, 0.7), // (헷갈림) 난 ChatGPT가 Claude보다 편하더라. — 개인 취향

  // ── 복합: 문장을 나눠 각각 분류 ──
  rel({ sentence: "서비스명은 싱크업으로 하고,", subtopic: "주제·목표", tag: "decision", topic_key: "서비스명",
    content: "서비스명 = 싱크업", owner: "김단비", source: at("22:05"), confidence: 0.9 }),
  rel({ sentence: "기준표는 내가 내일까지 만들게.", subtopic: "역할·일정", tag: "todo", topic_key: "분류 기준",
    content: "분류 기준표 만들기", owner: "김단비", due: "2026-11-07", source: at("22:05"), confidence: 0.85 }),

  // ── 민감정보: 전화번호는 [연락처]로 가림 ──
  rel({ sentence: "발표 자료는 [연락처]로 보내 줘.", subtopic: "발표·제출", tag: "todo", topic_key: "발표 자료", is_new_topic: true,
    content: "발표 자료를 [연락처]로 전달", masked: true, source: at("22:10"), confidence: 0.85 }),
];

const mvpChange = mockCards.find((c): c is RelatedCard => c.relevance === "related" && c.is_change)!;

export const mockConflicts: Conflict[] = [
  {
    id: "x1",
    topic_key: "MVP 범위",
    cardA: priorMvpDecision,
    cardB: mvpChange,
    judgement: "변경",
    reason: "같은 세부 주제(MVP 범위)의 기존 결정 '브라우저 확장은 행사 이후'를 'MVP 포함'으로 바꾸는 표현",
  },
];
