import { USE_MOCK } from "@/lib/api";

// 소개 화면들의 '시작' 버튼과 첫 단계. 목업 모드는 이 브라우저에 팀을 만들고,
// 실제 모드는 관리자가 미리 등록한 팀을 대화 수집 화면에서 확인한다 (team/new·join 은 안내만 보인다)
export const START = USE_MOCK
  ? { href: "/team/new", label: "팀 만들고 시작하기", short: "팀 만들기", step: "팀 만들기·초대" }
  : { href: "/collect", label: "등록된 팀으로 시작하기", short: "시작하기", step: "등록된 팀 확인" };
