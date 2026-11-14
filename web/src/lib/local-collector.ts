"use client";
// 로컬 수집기 상태를 화면 전체가 나눠 쓴다. 구독하는 화면이 있을 때만 POLL_MS 마다 한 번 읽는다.
// 후보가 필요한 화면(승인함·대화 수집)이 있으면 candidates.list(상태 포함) + privacy.list 를,
// 헤더·아바타처럼 상태만 필요하면 collection.status 만 읽는다. 목업 모드는 수집기에 요청하지 않는다.
import { useCallback, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { ExtSettingsPatch, ExtStatus, PrivacyList, SyncNowParams, SyncNowResult } from "@shared/bridge";
import type { RelatedCard } from "@shared/types";
import { POLL_MS, USE_MOCK } from "./api";
import { ExtensionMissing, rpc, syncNow } from "./rpc";

interface Snapshot {
  status: ExtStatus | null; // 마지막으로 받은 상태 (뒤 요청이 실패해도 남긴다)
  available: boolean; // 마지막 요청이 수집기에 닿았는지
  error: string | null;
  extensionMissing: boolean; // 마지막 요청을 확장이 받지 않았는지 (설치 안 됨, 또는 팝업 주소가 이 페이지가 아님)
  statusChecked: boolean; // 상태 요청을 한 번이라도 마쳤는지 (성공·실패)
  cards: RelatedCard[];
  cardsChecked: boolean; // 후보 화면이 열린 뒤 candidates.list 를 한 번이라도 마쳤는지
  privacy: PrivacyList | null; // status.teamId 와 같은 팀의 목록만 담는다
  privacyError: string | null;
}

type Need = "status" | "candidates";

const NO_CANDIDATES: Pick<Snapshot, "cards" | "cardsChecked" | "privacy" | "privacyError"> = {
  cards: [],
  cardsChecked: false,
  privacy: null,
  privacyError: null,
};
const INITIAL: Snapshot = { status: null, available: false, error: null, extensionMissing: false, statusChecked: false, ...NO_CANDIDATES };
const MOCK: Snapshot = { ...INITIAL, statusChecked: true, cardsChecked: true };

let snapshot = INITIAL;
const listeners = new Map<() => void, Need>();
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = 0; // 아직 끝나지 않은 상태 요청 수
// 가장 최근 요청의 응답만 반영한다 (예: 팀을 바꾸기 전에 보낸 요청의 늦은 응답은 버림)
let generation = 0;

function publish(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((_, listener) => listener());
}

const wantsCandidates = () => [...listeners.values()].includes("candidates");

async function refreshPrivacy(mine: number, teamId: string | undefined) {
  try {
    const list = await rpc<PrivacyList>("privacy.list");
    if (mine === generation && list.teamId === teamId) publish({ privacy: list, privacyError: null });
  } catch (error) {
    // 마지막 목록은 화면에 두고 실패만 알린다. 빈 목록으로 바꾸면 확인 필요 묶음이 사라져 보인다
    if (mine === generation) publish({ privacyError: (error as Error).message });
  }
}

/** 지금 상태를 새로 읽는다. 실패는 상태(error)로 남기고 던지지 않는다 */
export async function refreshCollector(): Promise<void> {
  inFlight += 1;
  try {
    await readOnce(++generation, wantsCandidates());
  } finally {
    inFlight -= 1;
  }
}

async function readOnce(mine: number, withCandidates: boolean) {
  try {
    if (!withCandidates) {
      const status = await rpc<ExtStatus>("collection.status");
      if (mine === generation) publish({ status, available: true, error: null, extensionMissing: false, statusChecked: true });
      return;
    }
    const { cards, status } = await rpc<{ cards: RelatedCard[]; status: ExtStatus }>("candidates.list");
    if (mine !== generation) return;
    publish({ status, cards, available: true, error: null, extensionMissing: false, statusChecked: true, cardsChecked: true });
    await refreshPrivacy(mine, status.teamId);
  } catch (error) {
    if (mine !== generation) return;
    publish({
      available: false,
      error: (error as Error).message,
      extensionMissing: error instanceof ExtensionMissing,
      statusChecked: true,
      ...(withCandidates ? { cardsChecked: true } : {}),
    });
  }
}

// 주기 요청은 앞 요청이 끝난 뒤에만 보낸다. 겹쳐 보내면 늦게 끝나는 요청이 늘 '오래된 응답'으로 버려져
// 확장이 없을 때 화면이 '확인 중'에 머문다
function poll() {
  if (!inFlight) void refreshCollector();
}

/** 구독 시작 (첫 구독이면 폴링을 시작). 돌려준 함수로 끝낸다 */
export function watchCollector(listener: () => void, need: Need) {
  const firstForCandidates = need === "candidates" && !wantsCandidates();
  listeners.set(listener, need);
  if (!timer) timer = setInterval(poll, POLL_MS);
  if (listeners.size === 1 || firstForCandidates) void refreshCollector();
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
    // 후보 화면을 떠나면 후보를 비워, 다음에 열 때 다른 팀의 옛 후보가 잠깐 보이지 않게 한다.
    // 아직 오는 중인 candidates.list 응답이 비운 목록을 다시 채우지 않도록 그 요청도 버린다
    if (need === "candidates" && !wantsCandidates()) {
      generation += 1;
      publish(NO_CANDIDATES);
    }
  };
}

const SERVER_SNAPSHOT = USE_MOCK ? MOCK : INITIAL;
/** 지금 상태 (목업 모드는 늘 같은 빈 상태) */
export const readCollector = () => (USE_MOCK ? MOCK : snapshot);
const serverSnapshot = () => SERVER_SNAPSHOT;

function useSnapshot(need: Need): Snapshot {
  const subscribeTo = useCallback((listener: () => void) => (USE_MOCK ? () => {} : watchCollector(listener, need)), [need]);
  return useSyncExternalStore(subscribeTo, readCollector, serverSnapshot);
}

/** 상태만 필요한 곳 (헤더의 팀 이름·아바타) */
export function useCollectorStatus() {
  const { status, available, statusChecked, extensionMissing } = useSnapshot("status");
  return { status, available, checked: statusChecked, extensionMissing };
}

/** RPC 를 보내고 상태를 새로 읽는다. 실패는 토스트로 알린다 (목업 모드는 안내만) */
async function act(method: string, params: Record<string, unknown> = {}) {
  if (USE_MOCK) {
    toast.info("예시 모드에서는 실제 수집기에 요청하지 않습니다.");
    return;
  }
  try {
    await rpc(method, params);
    await refreshCollector();
  } catch (error) {
    toast.error((error as Error).message);
  }
}

/** '싱크 맞추기' 버튼을 누를 수 있는지: 수집 중이어야 하고, 쌓인 대화가 있거나 프로젝트 동기화가 켜져 있어야 한다 */
export const canSyncNow = (status: ExtStatus) => status.autoCollect && (status.bufferedTurns > 0 || !!status.accountSync?.enabled);

let syncing: Promise<SyncNowResult> | null = null; // 돌고 있는 싱크 맞추기 (승인함 자동 실행과 버튼이 겹치거나 화면이 두 번 실행해도 한 번만 보낸다)

/**
 * 싱크 맞추기를 하고, 끝나면 보여 줄 화면이 있을 때 후보·상태를 다시 읽는다. 실패는 던진다 (조용히 둘지는 부른 쪽이 정한다).
 * 이미 돌고 있으면 그 결과를 함께 받는다.
 */
export function syncAndRefresh(reason: SyncNowParams["reason"]): Promise<SyncNowResult> {
  if (USE_MOCK) return Promise.reject(new Error("예시 모드에서는 실제 수집기에 요청하지 않습니다."));
  syncing ??= syncThenRefresh(reason).finally(() => {
    syncing = null;
  });
  return syncing;
}

async function syncThenRefresh(reason: SyncNowParams["reason"]): Promise<SyncNowResult> {
  const result = await syncNow(reason);
  if (listeners.size) await refreshCollector();
  return result;
}

// 개인정보 처리 요청은 서버 답을 돌려주거나 던진다 (실패를 성공으로 보이지 않게).
// {queued:true} 는 다음 실행에서 다시 본다는 뜻이지 검사가 끝났다는 뜻이 아니다.
async function privacyAction(method: "privacy.recheck" | "privacy.exclude", params: { id: string; teamId: string; messageId?: string }) {
  const result = await rpc<{ queued: boolean }>(method, params);
  await refreshCollector();
  return result;
}

// 승인한 카드는 수집기가 이미 후보에서 뺐으니 다시 읽기만 한다. 버린 카드는 하나씩 candidates.dismiss
async function remove(ids: string[], reason: "approved" | "dismissed") {
  if (USE_MOCK) return;
  if (reason === "dismissed") {
    for (const id of ids) {
      try {
        await rpc("candidates.dismiss", { id });
      } catch (error) {
        toast.error((error as Error).message);
      }
    }
  }
  await refreshCollector();
}

const ACTIONS = {
  refresh: refreshCollector,
  action: act,
  privacyAction,
  remove,
  updateSettings: (patch: ExtSettingsPatch) => act("collection.configure", { ...patch }),
  syncNow: syncAndRefresh,
};

/** 후보까지 필요한 곳 (승인함·대화 수집) */
export function useLocalCollector() {
  const s = useSnapshot("candidates");
  const teamId = s.status?.teamId;
  return {
    status: s.status,
    available: s.available,
    checked: s.cardsChecked,
    error: s.error,
    extensionMissing: s.extensionMissing,
    cards: s.cards,
    privacy: { list: s.privacy?.teamId === teamId ? s.privacy : null, error: s.privacyError },
    ...ACTIONS,
  };
}

// 연결 상태 구분 (대화 수집 화면 · 빈 승인함 안내):
// checking = 아직 확인 중, connected = 수집기 응답, extension-missing = 확장이 요청을 받지 않음(설치 안 됨 또는 팝업 주소가 이 페이지가 아님),
// collector-off = 확장은 받았지만 로컬 수집기가 꺼져 있거나 연결 실패. 목업 모드는 수집기에 요청하지 않으므로 확장 설치 안내를 둔다
export type CollectorLink = "checking" | "connected" | "extension-missing" | "collector-off";

export function collectorLink(c: { checked: boolean; available: boolean; extensionMissing: boolean; status: ExtStatus | null }): CollectorLink {
  if (USE_MOCK) return "extension-missing";
  if (!c.checked) return "checking";
  if (c.available && c.status) return "connected";
  return c.extensionMissing ? "extension-missing" : "collector-off";
}
