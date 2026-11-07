// 가짜 팀 서버. 브라우저 localStorage 에 저장해서 새로고침해도 승인한 카드가 남는다.
// (localStorage 를 못 쓰는 환경이면 메모리에만 저장)
// 충돌은 서버가 하듯 "같은 topic_key 의 결정인데 내용이 다르면" 그때그때 계산한다.
import { mockCards } from "@shared/mock";
import { isShareable } from "@shared/labels";
import type { Conflict, RelatedCard } from "@shared/types";
import type { TeamApi } from "./types";

const KEY = "syncup:mock-board:v1";

interface State {
  board: RelatedCard[]; // approved + dismissed(충돌 해결로 밀려난 결정)
  notes: Record<string, string>;
}

const seed = (): State => ({
  // 분류 예시 22개 중 공유 가능한 것 = 이미 승인된 팀 보드
  board: mockCards.filter(isShareable).map((c) => ({ ...c, status: "approved" })),
  notes: {},
});

let memory: State | null = null;

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as State;
  } catch {}
  return (memory ??= seed());
}

function save(state: State) {
  memory = state;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {}
}

export function resetMockData() {
  memory = null;
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

// 주소에 ?mockFail 을 붙이면 실패 화면 확인용으로 일부러 실패
const delay = async () => {
  await new Promise((r) => setTimeout(r, 400));
  if (typeof window !== "undefined" && window.location.search.includes("mockFail")) {
    throw new Error("목업 서버 실패 (?mockFail)");
  }
};

const same = (a: string, b: string) => a.replace(/\s/g, "") === b.replace(/\s/g, "");

export function findConflicts(board: RelatedCard[]): Conflict[] {
  const decisions = board.filter((c) => c.status === "approved" && c.tag === "decision" && c.topic_key);
  const byTopic = Map.groupBy(decisions, (c) => c.topic_key!);
  const conflicts: Conflict[] = [];
  for (const [topic_key, list] of byTopic) {
    const [first, ...rest] = list;
    for (const later of rest) {
      if (same(first!.content, later.content)) continue;
      conflicts.push({
        id: `${first!.id}__${later.id}`,
        topic_key,
        cardA: first!,
        cardB: later,
        judgement: later.is_change ? "변경" : "충돌",
        reason: `같은 세부 주제(${topic_key})에 서로 다른 결정이 있어요`,
      });
    }
  }
  return conflicts;
}

export function createMockApi(): TeamApi {
  return {
    async approveItems(cards) {
      await delay();
      const state = load();
      const ids = new Set(state.board.map((c) => c.id));
      const added = cards.filter((c) => !ids.has(c.id)).map((c) => ({ ...c, status: "approved" as const }));
      save({ ...state, board: [...state.board, ...added] });
    },
    async getBoard() {
      await delay();
      return load().board.filter((c) => c.status === "approved");
    },
    async getConflicts() {
      await delay();
      return findConflicts(load().board);
    },
    async resolveConflict(id, choice, note) {
      await delay();
      const state = load();
      const [aId, bId] = id.split("__");
      const loser = choice === "keep-existing" ? bId : aId; // 밀려난 결정은 보드에서 내림
      save({
        board: state.board.map((c) => (c.id === loser ? { ...c, status: "dismissed" } : c)),
        notes: note ? { ...state.notes, [id]: note } : state.notes,
      });
    },
  };
}
