// 가짜 팀 서버. 브라우저 localStorage 에 저장해서 새로고침해도 승인한 카드가 남는다.
// 충돌 판정은 하은 님 ai/syncup_ai/conflict.py 의 규칙 판정(shared/conflict.ts)과 같다.
import { checkNewCards } from "@shared/conflict";
import { MOCK_DONE_TODOS, mockCards } from "@shared/mock";
import type { Conflict, RelatedCard, Resolution } from "@shared/types";
import type { TeamApi } from "./types";

const KEY = "syncup:mock-board:v2";

interface State {
  board: RelatedCard[]; // approved + dismissed(충돌 처리로 밀려난 결정), 승인 순서대로
  resolutions: Record<string, { resolution: Resolution; note?: string }>;
  done: string[]; // 완료한 할 일 id
}

const seed = (): State => ({
  board: mockCards.map((c) => ({ ...c, status: "approved" })),
  resolutions: {},
  done: [...MOCK_DONE_TODOS],
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
  await new Promise((r) => setTimeout(r, 300));
  if (typeof window !== "undefined" && window.location.search.includes("mockFail")) {
    throw new Error("목업 서버 실패 (?mockFail)");
  }
};

const approved = (s: State) => s.board.filter((c) => c.status === "approved");

/** 보드의 결정을 승인 순서대로 다시 판정 → 아직 처리 안 된 경고 (논의 요청 중인 것 포함) */
function openConflicts(s: State): Conflict[] {
  return checkNewCards(approved(s), [])
    .filter((x) => {
      const r = s.resolutions[x.id]?.resolution;
      return !r || r === "discuss";
    })
    .map((x) => ({ ...x, ...s.resolutions[x.id] }));
}

export function createMockApi(): TeamApi {
  return {
    async approveItems(cards) {
      await delay();
      const s = load();
      const ids = new Set(s.board.map((c) => c.id));
      const added = cards.filter((c) => !ids.has(c.id)).map((c) => ({ ...c, status: "approved" as const }));
      const conflicts = checkNewCards(added, approved(s)); // 서버의 /items/approve 충돌 검사
      save({ ...s, board: [...s.board, ...added] });
      return { conflicts };
    },
    async getBoard() {
      await delay();
      return approved(load());
    },
    async getConflicts() {
      await delay();
      return openConflicts(load());
    },
    async resolveConflict(id, choice, note) {
      await delay();
      const s = load();
      const [aId, bId] = id.split("__");
      // 기존 유지 → 새 결정을 내림 / 새 결정으로 변경 → 기존 결정을 내림 / 논의 요청 → 둘 다 두고 경고 유지
      const loser = choice === "keep-existing" ? bId : choice === "adopt-new" ? aId : null;
      save({
        ...s,
        board: s.board.map((c) => (c.id === loser ? { ...c, status: "dismissed" } : c)),
        resolutions: { ...s.resolutions, [id]: { resolution: choice, ...(note ? { note } : {}) } },
      });
    },
    async getDoneTodos() {
      await delay();
      return load().done;
    },
    async setTodoDone(id, done) {
      const s = load();
      save({ ...s, done: done ? [...new Set([...s.done, id])] : s.done.filter((x) => x !== id) });
    },
  };
}
