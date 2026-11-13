// 팀 상태 파일(SYNCUP.md · syncup.json) GitHub 저장 상태. 웹·확장 공용.
// 형식: docs/team-server.md 'GitHub 레포 저장'(로컬 수집기 RPC team.repo 의 repo), docs/team-state.md(syncup.json).
// 레포 연결은 팀 서버 환경 변수로만 정해진다 (화면에서 바꾸지 않음)

export interface RepoCommit {
  sha: string;
  url?: string | null;
  at?: string | null; // ISO
}

export interface RepoStatus {
  linked: boolean; // false = 이 팀은 레포에 저장하지 않음 (아래 필드 없음)
  repo?: string; // owner/name
  branch?: string;
  files?: string[];
  state?: "unknown" | "saved" | "unchanged" | "failed"; // unknown = 서버 시작 뒤 아직 확인 안 함
  pending?: boolean; // 저장 대기·진행 중
  commit?: RepoCommit | null;
  httpStatus?: number | null; // 실패 때
  checkedAt?: number; // epoch 초
}

export interface SyncupTodo {
  id: string; // SU-n (서버가 공유 순서대로 붙임. 웹에서 만들지 않는다)
  card_id: string;
  content: string;
  owner?: string | null;
  due?: string | null;
  topic_key?: string | null;
  done?: boolean;
}

export interface SyncupDecisionTopic {
  topic_key: string;
  subtopic?: string;
  status?: "settled" | "review";
  current?: { card_id: string; content: string }[];
  history?: { card_id: string; content: string; state?: string }[];
}

export interface SyncupBranch {
  members: string[];
  todos: string[]; // SU-n
  decisions: string[]; // 세부 주제(topic_key) 이름
}

export interface SyncupState {
  syncup_version: number;
  team?: { name?: string; goal?: string; scope?: string; rules?: string[]; repo?: string };
  updated_at?: string | null;
  decisions?: SyncupDecisionTopic[];
  todos?: SyncupTodo[];
  by_branch?: Record<string, SyncupBranch>;
}

export const repoShortName = (repo = "") => repo.split("/").pop() || repo;

// 커밋 sha 로 읽으면 raw.githubusercontent.com 의 몇 분짜리 캐시에 옛 파일이 걸리지 않는다
export const rawFileUrl = (s: RepoStatus, file: string) =>
  `https://raw.githubusercontent.com/${s.repo}/${s.commit?.sha ?? s.branch}/${file}`;
export const repoFileUrl = (s: RepoStatus, file: string) => `https://github.com/${s.repo}/blob/${s.branch}/${file}`;

/** "방금 전" · "5분 전" · "3시간 전" · "2일 전" */
export function sinceText(iso: string, now = Date.now()) {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}시간 전`;
  return `${Math.floor(minutes / (60 * 24))}일 전`;
}

export type RepoTone = "ok" | "busy" | "error" | "muted";

/** 레포 상태 한 줄 (팀 보드 상태 바·확장 팝업). 연결 안 된 팀은 null (숨김) */
export function repoLine(s: RepoStatus | null, now = Date.now()): { tone: RepoTone; text: string } | null {
  if (!s?.linked) return null;
  const name = repoShortName(s.repo);
  if (s.pending) return { tone: "busy", text: `${name} · 레포에 저장 중…` };
  if (s.state === "failed") {
    const code = s.httpStatus ? ` (HTTP ${s.httpStatus})` : "";
    return { tone: "error", text: `${name} · 레포 저장 실패${code} · 다음 변경 때 다시 저장해요` };
  }
  if ((s.state === "saved" || s.state === "unchanged") && s.commit) {
    const when = s.commit.at ? ` · ${sinceText(s.commit.at, now)}` : "";
    return { tone: "ok", text: `${name} · 레포에 저장됨 ✓${when}` };
  }
  return { tone: "muted", text: `${name} · 레포 연결 확인 중` };
}

/** syncup.json 에서 카드 id → 할 일 ID(SU-n), 레포에 반영된 결정 카드 id */
export function repoIndex(state: SyncupState | null) {
  const todoIds = new Map<string, string>((state?.todos ?? []).map((t) => [t.card_id, t.id]));
  const savedDecisions = new Set<string>(
    (state?.decisions ?? []).flatMap((t) => [...(t.current ?? []), ...(t.history ?? [])].map((d) => d.card_id)),
  );
  return { todoIds, savedDecisions };
}
