// CLAUDE.md §8 팀 서버 API. 화면은 TeamApi 인터페이스만 쓰고,
// createTeamApi(baseUrl)에 주소가 있으면 실제 서버, 없으면 목업을 쓴다.
import type { Card, Conflict, Resolution } from "./types";
import { mockCards, mockConflicts } from "./mock";

export interface TeamApi {
  approve(team: string, cards: Card[]): Promise<void>;
  getBoard(team: string): Promise<Card[]>;
  getConflicts(team: string): Promise<Conflict[]>;
  resolveConflict(id: string, resolution: Resolution, resolutionNote?: string): Promise<void>;
}

function httpTeamApi(baseUrl: string): TeamApi {
  const req = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(baseUrl + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return res.status === 204 ? (undefined as T) : res.json();
  };
  return {
    approve: (team, cards) =>
      req("/items/approve", { method: "POST", body: JSON.stringify({ team, cards }) }),
    getBoard: (team) => req(`/board?team=${encodeURIComponent(team)}`),
    getConflicts: (team) => req(`/conflicts?team=${encodeURIComponent(team)}`),
    resolveConflict: (id, resolution, resolutionNote) =>
      req(`/conflicts/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ resolution, resolutionNote }),
      }),
  };
}

// 메모리 안에서만 동작하는 가짜 서버 (새로고침하면 초기화)
function mockTeamApi(): TeamApi {
  let board = mockCards.filter((c) => c.status === "approved");
  let conflicts = [...mockConflicts];
  const delay = () => new Promise((r) => setTimeout(r, 300));
  return {
    async approve(_team, cards) {
      await delay();
      board = [...board, ...cards.map((c) => ({ ...c, status: "approved" as const }))];
    },
    async getBoard() {
      await delay();
      return board;
    },
    async getConflicts() {
      await delay();
      return conflicts;
    },
    async resolveConflict(id, resolution, resolutionNote) {
      await delay();
      conflicts = conflicts.map((c) => (c.id === id ? { ...c, resolution, resolutionNote } : c));
    },
  };
}

export function createTeamApi(baseUrl?: string): TeamApi {
  return baseUrl ? httpTeamApi(baseUrl) : mockTeamApi();
}
