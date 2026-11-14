// 가짜 팀 서버. 브라우저 localStorage 에 저장해서 새로고침해도 승인한 카드가 남는다.
// 충돌 판정은 shared/conflict.ts 의 목업용 근사 판정이다 (실제는 팀 서버).
import { checkNewCards } from "@shared/conflict";
import { fmtHM, ymd } from "@shared/format";
import { MOCK_DONE_TODOS, mockCards } from "@shared/mock";
import type { Conflict, RelatedCard, Resolution } from "@shared/types";
import type { TeamApi } from "./types";

const KEY = "syncup:mock-board:v3"; // v3: 목업을 합성 대화 H01 '온길'로 바꿈 (옛 저장값은 읽지 않음)

interface State {
  board: RelatedCard[]; // approved + dismissed(충돌 처리로 밀려난 결정), 승인 순서대로
  resolutions: Record<string, { resolution: Resolution; note?: string; at?: string }>; // 충돌 id → 처리 (처리 순서대로)
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
    .map((x) => ({ ...x, resolution: s.resolutions[x.id]?.resolution }));
}

// 기존 유지 → 새 결정을 내림 / 새 결정으로 변경 → 기존 결정을 내림 / 둘 다 유효·논의 요청 → 둘 다 둠
function demote(card: RelatedCard, loserId: string | null, choice: Resolution): RelatedCard {
  if (card.id !== loserId) return card;
  return { ...card, status: "dismissed", decisionState: choice === "adopt-new" ? "superseded" : "rejected" };
}

export function createMockApi(): TeamApi {
  return {
    async approveItems(cards) {
      await delay();
      const s = load();
      const ids = new Set(s.board.map((c) => c.id));
      const added = cards.filter((c) => !ids.has(c.id)).map((c) => ({ ...c, status: "approved" as const }));
      const conflicts = checkNewCards(added, approved(s)); // 목업은 승인하자마자 판정한다 (실제는 팀 서버가 나중에)
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
      const loser = choice === "keep-existing" ? bId : choice === "adopt-new" ? aId : null;
      const now = new Date();
      save({
        ...s,
        board: s.board.map((c) => demote(c, loser, choice)),
        resolutions: { ...s.resolutions, [id]: { resolution: choice, ...(note ? { note } : {}), at: `${ymd(now)} ${fmtHM(now)}` } },
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
    // 목업 카드는 충돌 검사를 바로 끝내므로 다시 시작할 검사가 없다
    async retryCheck() {
      await delay();
    },
    async getHistory() {
      await delay();
      const s = load();
      const events = Object.values(s.resolutions).map((r) => ({ resolution: r.resolution, note: r.note ?? "", at: r.at ?? "" }));
      return { records: s.board, events };
    },
    // 목업 팀은 레포에 저장하지 않는다 (레포 상태 바·팀 기록 파일은 실제 모드에서만)
    async getRepo() {
      return { linked: false };
    },
  };
}
