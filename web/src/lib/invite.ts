// 초대 링크 (server/team_invites.py, docs/team-server.md '초대 링크로 팀에 참여').
// 팀원은 수집기를 거쳐 링크를 만들고(team.createInvite), 받은 사람은 /join/<코드> 에서 GitHub 로 로그인해 참여한다.
// 코드는 이 PC의 연결 프로그램(setup.begin)이 로그인 동안 갖고 있다가 팀 서버에 한 번만 보낸다. 로그인 주소에는 싣지 않는다.

export const INVITE_CODE = /^[A-Za-z0-9_-]{24}$/; // server/team_invites.py CODE (144비트)
export const NAME_MAX = 40;

/** setup.invite: 로그인 전에 보여 줄 링크 상태. valid 일 때만 팀 이름·만료가 온다 */
export type InvitePreview =
  | { status: "valid"; team: string; expiresAt: string; members: number; memberLimit: number }
  | { status: "unknown_link" | "expired" | "revoked" | "team_full" };

/** team.invites: 팀 인원과 최근 7일 링크 (코드는 오지 않는다) */
export type InviteList = {
  members: number;
  member_limit: number;
  invites: { id: string; created_by: string; created_at: string; expires_at: string; revoked_at: string | null; joined: number }[];
};
/** team.createInvite: 코드는 이 응답에서 한 번만 온다 */
export type CreatedInvite = { created: true; id: string; code: string; expires_at: string } | { created: false };

export function isInviteCode(code: string): boolean {
  return INVITE_CODE.test(code);
}

export function inviteUrl(origin: string, code: string): string {
  return `${origin}/join/${code}`;
}

/** 참여할 때 팀에 보일 이름 (처음 참여하는 사람만 이 이름으로 만들어진다). 맞지 않으면 null */
export function cleanName(value: string): string | null {
  const name = value.trim();
  if (!name || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

const GONE: Record<Exclude<InvitePreview["status"], "valid">, string> = {
  unknown_link: "초대 링크가 올바르지 않아요. 받은 링크 전체를 다시 열거나 팀원에게 새 링크를 받으세요.",
  expired: "초대 링크가 만료됐어요. 팀원에게 새 링크를 받으세요.",
  revoked: "회수된 초대 링크예요. 팀원에게 새 링크를 받으세요.",
  team_full: "팀 인원이 가득 찼어요. 팀원에게 확인하세요.",
};

export function previewProblem(preview: InvitePreview): string | null {
  return preview.status === "valid" ? null : GONE[preview.status];
}

/** 링크 상태 한 단어: 사용 중 / 만료 / 회수 */
export function inviteState(invite: InviteList["invites"][number], now = Date.now()): "open" | "expired" | "revoked" {
  if (invite.revoked_at) return "revoked";
  return Date.parse(invite.expires_at) <= now ? "expired" : "open";
}

/** 연결 프로그램(native host)이 없거나 팀 서버 주소 없이 설치됐음을 뜻하는 오류인지: 그러면 /install 안내로 보낸다 */
export function needsInstall(message: string): boolean {
  return /native messaging host not found|로컬 수집기 연결 실패|팀 서버 주소가 없습니다/i.test(message);
}
