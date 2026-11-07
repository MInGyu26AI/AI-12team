// 실제 팀 서버 (김동균 님). 응답 형식이 확정되면 여기만 맞춘다.
import type { TeamApi } from "./types";

export function createRealApi(baseUrl: string): TeamApi {
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(baseUrl.replace(/\/$/, "") + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
    if (!res.ok) throw new Error(`서버 오류 ${res.status} (${path})`);
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  };

  return {
    approveItems: (cards) =>
      request("/items/approve", { method: "POST", body: JSON.stringify({ cards }) }),
    getBoard: () => request("/board"),
    getConflicts: () => request("/conflicts"),
    resolveConflict: (id, choice, note) =>
      request(`/conflicts/${encodeURIComponent(id)}/resolve`, {
        method: "POST",
        body: JSON.stringify({ resolution: choice, resolutionNote: note }),
      }),
  };
}
