// 이용 방법 6단계. 첫 화면 '이용 방법' 페이지(app/(marketing)/guide)와 대시보드 '이용 방법' 팝업(components/dashboard/flow-slides.tsx)이 같은 글을 쓴다.
import { USE_MOCK } from "@/lib/api";
import { START } from "@/lib/start-link";

export type GuideStep = { title: string; body: string; tip: string; href: string; cta: string };

// 첫 단계는 모드마다 다르다: 목업은 이 브라우저에 팀을 만들고, 실제는 GitHub 로그인 후 팀을 만들거나 초대로 참여한다
export const FIRST_STEP: GuideStep = USE_MOCK
  ? {
      title: START.step,
      body: "팀 이름, 프로젝트 주제, 마감일을 입력해요. 프로젝트 주제는 AI가 팀 관련 대화를 고르는 기준이 돼요. 초대 링크를 카카오톡·디스코드에 보내면 팀원이 바로 참여해요.",
      tip: "예시 모드에서는 팀 정보가 이 브라우저에만 저장돼요.",
      href: START.href,
      cta: START.short,
    }
  : {
      title: START.step,
      body: "GitHub로 로그인한 뒤 팀을 만들거나 초대 링크로 참여해요. PC 연결 프로그램과 확장을 설치하면 대화를 수집하고 개인 승인함을 사용할 수 있어요.",
      tip: "팀원이 보낸 초대 링크는 GitHub 로그인 후 참여할 수 있어요.",
      href: START.href,
      cta: "GitHub로 시작하기",
    };

export const STEPS: GuideStep[] = [
  FIRST_STEP,
  {
    title: "브라우저 확장 연결",
    body: "크롬 확장 zip을 내려받아 압축을 풀고, chrome://extensions 의 개발자 모드에서 ‘압축해제된 확장 프로그램 로드’로 설치해요. 툴바에 고정해 두면 편해요.",
    tip: "처음 설정에서 수집 범위와 외부 AI 전송 안내를 꼭 읽어 주세요.",
    href: "/install",
    cta: "설치 방법 보기",
  },
  {
    title: "대화 자동 수집",
    body: "확장에서 수집 범위와 기간을 정하고 시작하면 질문+답변 10회마다 대화를 모아 분류해요. AI가 팀과 관련된 내용을 고르고, 수집은 원할 때 중지할 수 있어요.",
    tip: "자동으로 못 읽으면 대화를 드래그해 오른쪽 아래 ‘선택한 내용 보내기’를 누르거나, 대화를 직접 붙여넣어도 돼요.",
    href: "/collect",
    cta: "대화 수집 화면",
  },
  {
    title: "승인함에서 체크",
    body: "프로젝트 대화에서 나온 결정·조사·할 일 후보가 내 승인함에 쌓여요. 내용을 확인·수정하고 팀에 올릴 것만 체크해서 올려요. 확신도가 낮으면 ‘확인 필요’가 붙어요.",
    tip: "승인함은 나만 봐요. 체크하지 않은 후보는 팀에 올라가지 않아요.",
    href: "/review",
    cta: "승인함 열기",
  },
  {
    title: "충돌 확인",
    body: "올린 결정이 같은 주제의 기존 결정과 어긋나면 두 결정과 근거 문장을 나란히 보여줘요. ‘기존 유지’, ‘새 결정으로 변경’, ‘팀에 논의 요청’ 중 하나를 골라요.",
    tip: "같은 사람이 스스로 고친 건 ‘변경’, 다른 사람이 반대로 정한 건 ‘충돌’로 표시돼요.",
    href: "/board",
    cta: "충돌 확인하기",
  },
  {
    title: "팀 결정 기록",
    body: "승인된 결정이 주제별·시간순으로 쌓이고, 할 일은 담당자·기한과 함께 체크할 수 있어요. ‘팀 기록 복사’를 누르면 지금까지의 결정을 AI에 붙여넣기 좋은 글로 복사해요.",
    tip: "새 AI 대화를 시작할 때 팀 기록을 붙여넣으면 팀이 정한 내용을 전제로 답해 줘요.",
    href: "/board",
    cta: "팀 결정 기록 보기",
  },
];
