// 가입 동의 화면(/signup/consent)의 필수 항목 4개와 '요약 보기' 글 (디자인 Login.dc.html 2번 화면).
// 요약은 /terms·/privacy 전문을 줄인 것이다. 문서를 고치면 여기 요약도 맞추고 lib/legal.ts 버전을 올린다.

export type ConsentId = "age" | "terms" | "privacy" | "transfer";

export type ConsentItem = {
  id: ConsentId;
  label: string;
  /** 요약 보기에 보이는 줄들. 없으면 요약 버튼도 없다 */
  points?: string[];
  /** 전문 링크 */
  href?: "/terms" | "/privacy";
  docLabel?: string;
};

export const CONSENT_ITEMS: ConsentItem[] = [
  { id: "age", label: "만 14세 이상이에요" },
  {
    id: "terms",
    label: "이용약관에 동의해요",
    href: "/terms",
    docLabel: "이용약관",
    points: [
      "베타 서비스예요. 기능이 바뀌거나 멈출 수 있고, 끝낼 때는 30일 전에 알려요.",
      "ChatGPT 화면 읽기와 프로젝트 동기화는 OpenAI 약관에 어긋날 수 있어요. 동기화는 꺼져 있고, 따로 안내를 읽고 켜야 작동해요.",
      "후보 카드와 충돌 판정은 AI가 만든 결과라 틀릴 수 있어요. 승인 전에 직접 확인해 주세요.",
    ],
  },
  {
    id: "privacy",
    label: "개인정보 수집·이용에 동의해요",
    href: "/privacy",
    docLabel: "개인정보 처리방침",
    points: [
      "수집 항목: 이름, GitHub 숫자 ID, 내가 승인한 카드와 근거 문장 1개",
      "목적: 본인 확인, 팀 기록, 충돌 확인",
      "보유 기간: 베타 기간 동안. 종료 후 5일 안에 파기해요.",
      "삭제·탈퇴 기능은 준비 중이에요. 그때까지 요청은 메일로 받아요.",
    ],
  },
  {
    id: "transfer",
    label: "개인정보 국외 이전 안내를 확인했어요",
    href: "/privacy",
    docLabel: "개인정보 처리방침",
    points: [
      "OpenAI(미국): 가림 처리한 대화 정리본과 카드 내용. 카드 추출과 충돌 판정에 써요.",
      "Supabase·Railway·Vercel(국외): 데이터베이스, 로그인, 서버와 웹 호스팅",
      "국외 이전을 원하지 않으면 서비스를 이용할 수 없어요.",
    ],
  },
];

export type ConsentChecks = Record<ConsentId, boolean>;

export const noConsent = (): ConsentChecks => ({ age: false, terms: false, privacy: false, transfer: false });

/** 체크 안 한 항목 수 */
export const consentLeft = (checks: ConsentChecks) => CONSENT_ITEMS.filter((item) => !checks[item.id]).length;

/** 시작 버튼 아래 한 줄 */
export const consentHint = (left: number) =>
  left === 0 ? "동의한 문서의 버전과 날짜를 기록해요." : `필수 항목 ${left}개가 남았어요. 모두 체크해야 시작할 수 있어요.`;
