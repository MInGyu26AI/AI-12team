import { PRIVACY_VERSION, TERMS_VERSION } from "./legal";

/** Only known internal destinations may survive a GitHub redirect. Never accept an external or encoded URL.
 *  로그인 뒤 기본 화면은 대시보드다 (첫 로그인이면 대시보드 위에 팀 만들기 팝업이 뜬다) */
export function loginDestination(value: unknown): string {
  if (typeof value !== "string" || value.length > 200 || /[\\%?#\s]/.test(value)) return "/dashboard";
  return /^\/(?:dashboard|start|me|collect(?:\/paste)?|review|board(?:\/(?:record|repo|notion))?|team\/new|install|connect|join\/[A-Za-z0-9_-]{20,100})$/.test(value)
    ? value : "/dashboard";
}

export function loginUrl(next: string) { return `/login?next=${encodeURIComponent(loginDestination(next))}`; }

/** 약관·처리방침 동의 기록. 아직 동의하지 않은 계정은 null (옛 서버 응답에는 이 필드가 아예 없다) */
export type Consent = { terms: string; privacy: string; at: string };
export type Account = { id: string; name: string; teams: { id: string; name: string }[]; consent?: Consent | null };

const isConsent = (value: unknown): value is Consent => {
  const consent = value as Consent | null;
  return !!consent && typeof consent === "object" && !Array.isArray(consent) &&
    typeof consent.terms === "string" && typeof consent.privacy === "string" && typeof consent.at === "string";
};

export function readAccount(data: unknown): Account {
  const value = data as Account | null;
  if (!value || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/i.test(value.id) ||
      typeof value.name !== "string" || !Array.isArray(value.teams) ||
      value.teams.some(t => !t || typeof t.id !== "string" || typeof t.name !== "string") ||
      (value.consent != null && !isConsent(value.consent))) {
    throw new Error("가입 정보를 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
  }
  return value;
}

/** 동의 기록이 없거나, 지금 약관·처리방침 버전(lib/legal.ts)과 다르면 다시 동의를 받아야 한다 */
export function needsConsent(account: Account): boolean {
  const consent = account.consent;
  return !consent || consent.terms !== TERMS_VERSION || consent.privacy !== PRIVACY_VERSION;
}

/** 동의 화면 주소. 동의가 끝나면 next(허용된 내부 주소만, 기본 대시보드)로 돌아간다 */
export function consentUrl(next: string) { return `/signup/consent?next=${encodeURIComponent(loginDestination(next))}`; }

/** 팀 만들기 같은 요청이 '먼저 동의해 주세요'(403)로 거절됐는지. 다른 403(주소 불일치 등)과 구분한다 */
export function isConsentRefusal(status: number, message: unknown): boolean {
  return status === 403 && typeof message === "string" && message.includes("이용약관");
}

export function connectionProblem(account: Account, status: { userId?: string; teamId?: string }): string | null {
  if (!status.userId) return "PC 연결 프로그램을 최신 버전으로 업데이트해 주세요.";
  if (status.userId !== account.id) return "이 PC에 연결된 계정과 로그인한 계정이 달라요. 같은 GitHub 계정으로 PC를 다시 연결해 주세요.";
  if (!status.teamId || !account.teams.some(t => t.id === status.teamId)) return "참여한 팀을 PC 연결 프로그램에서 선택해 주세요.";
  return null;
}
