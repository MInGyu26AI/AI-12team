/** Only known internal destinations may survive a GitHub redirect. Never accept an external or encoded URL. */
export function loginDestination(value: unknown): string {
  if (typeof value !== "string" || value.length > 200 || /[\\%?#\s]/.test(value)) return "/start";
  return /^\/(?:start|collect(?:\/paste)?|review|board(?:\/(?:record|repo|notion))?|team\/new|install|connect|join\/[A-Za-z0-9_-]{20,100})$/.test(value)
    ? value : "/start";
}

export function loginUrl(next: string) { return `/login?next=${encodeURIComponent(loginDestination(next))}`; }

export type Account = { id: string; name: string; teams: { id: string; name: string }[] };

export function readAccount(data: unknown): Account {
  const value = data as Account | null;
  if (!value || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/i.test(value.id) ||
      typeof value.name !== "string" || !Array.isArray(value.teams) ||
      value.teams.some(t => !t || typeof t.id !== "string" || typeof t.name !== "string")) {
    throw new Error("가입 정보를 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
  }
  return value;
}

export function connectionProblem(account: Account, status: { userId?: string; teamId?: string }): string | null {
  if (!status.userId) return "PC 연결 프로그램을 최신 버전으로 업데이트해 주세요.";
  if (status.userId !== account.id) return "이 PC에 연결된 계정과 로그인한 계정이 달라요. 같은 GitHub 계정으로 PC를 다시 연결해 주세요.";
  if (!status.teamId || !account.teams.some(t => t.id === status.teamId)) return "참여한 팀을 PC 연결 프로그램에서 선택해 주세요.";
  return null;
}
