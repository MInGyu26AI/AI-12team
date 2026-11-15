import { USE_MOCK } from "@/lib/api";

// Real onboarding works before installing the extension. Mock mode remains a browser-only demo.
export const START = USE_MOCK
  ? { href: "/team/new", label: "팀 만들고 시작하기", short: "팀 만들기", step: "팀 만들기·초대" }
  : { href: "/login", label: "GitHub로 시작하기", short: "가입 / 로그인", step: "가입·팀 만들기" };
