// chrome.storage.local 에 저장하는 값들 (WXT storage 래퍼)
import { storage } from '#imports';
import type { ExtStatus } from '@shared/bridge';
import { MAX_TURNS_PER_BATCH, TURNS_PER_BATCH } from '@shared/batch';
import { isShareable } from '@shared/labels';
import { SUBTOPICS, type RelatedCard, type Subtopic } from '@shared/types';

// webUrl·enabledSubtopics 는 팝업 설정 화면이 저장한다. 나머지는 background 가 로컬 수집기 status(candidates.list)에서
// 옮겨 온 값이라 확장에서 바꾸려면 collection.configure 를 부른다.
export interface Settings {
  webUrl?: string; // 개인 검토함 웹 주소 (origin). 없으면 DEFAULT_WEB_URL
  enabledSubtopics: Subtopic[]; // 수집기 status 에는 없어서 마지막으로 저장한 값을 둔다
  configured?: boolean; // false = 등록된 팀에 접근할 수 없음 (teamName 은 '접근 불가')
  teamName: string;
  projectTopic: string;
  userName: string;
  autoCollect: boolean; // false = 수집 일시정지 또는 종료 시각 지남
  // 대화 N회(질문+답변)마다 분류. 덜 찬 묶음은 수동 보내기("지금 분류하기"·"싱크업에 보내기"·선택 보내기)만 바로 보낸다.
  // 수동 보내기도 수집 중일 때만 된다. 일시정지·종료 시각에는 남은 대화를 로컬 수집기에 두고, 다시 켜면 다음 묶음에 합친다
  turnsPerBatch?: number;
  endsAt?: string | null; // 수집 종료 시각 (ISO). 지나면 수집기가 새 수집과 AI 요청을 멈춘다
  bufferedTurns?: number;
  lastCollectedAt?: string | null;
}

export const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: { teamName: '', projectTopic: '', userName: '', enabledSubtopics: [...SUBTOPICS], autoCollect: false },
});

/** 수집기 status 를 저장할 설정으로. 확장이 정한 값은 그대로 두고, 확장이 읽지 않는 status 필드는 담지 않는다 */
export const settingsFromStatus = (previous: Settings, status: ExtStatus): Settings => ({
  webUrl: previous.webUrl,
  enabledSubtopics: previous.enabledSubtopics,
  configured: status.configured,
  teamName: status.teamName,
  projectTopic: status.projectTopic ?? previous.projectTopic,
  userName: status.userName,
  autoCollect: status.autoCollect,
  turnsPerBatch: status.turnsPerBatch,
  endsAt: status.endsAt,
  bufferedTurns: status.bufferedTurns,
  lastCollectedAt: status.lastCollectedAt,
});

// 묶음 크기 범위 1..MAX_TURNS_PER_BATCH. 로컬 수집기 collection_settings.configure 도 같은 범위만 받는다
export const clampTurns = (turns: number) => Math.min(Math.max(Math.round(turns), 1), MAX_TURNS_PER_BATCH);

// 수집기 status 를 옮기기 전에는 아래 값이 비어 있을 수 있으므로 항상 이 함수들로 읽는다
export const turnsOf = (s: Settings) => clampTurns(s.turnsPerBatch ?? TURNS_PER_BATCH);
export const endsAtOf = (s: Settings) => (s.endsAt ? new Date(s.endsAt) : null);
export const isEnded = (s: Settings, now = Date.now()) => {
  const end = endsAtOf(s);
  return !!end && end.getTime() <= now;
};

export const isConfigured = (s: Settings) => !!(s.teamName.trim() && s.projectTopic.trim() && s.userName.trim());

/**
 * 수동 보내기(싱크업에 보내기·선택 보내기·우클릭·지금 분류하기)를 막아야 하는 이유, 보낼 수 있으면 null.
 * 수집기는 수집 중(autoCollect = 일시정지도 종료도 아님)일 때만 발화와 분류 요청을 받는다
 */
export function sendBlockedReason(s: Settings, now = Date.now()): string | null {
  if (!isConfigured(s)) return '확장 아이콘을 눌러 먼저 설정해 주세요';
  if (isEnded(s, now)) return '수집 종료 시각이 지났어요. 확장 팝업에서 종료 시각을 갱신하고 자동 수집을 켜 주세요';
  if (!s.autoCollect) return '수집이 꺼져 있어요. 확장 팝업에서 자동 수집을 켜 주세요';
  return null;
}

// 확장 자신이 로컬 수집기를 부른 마지막 실패. unreachable: 수집기에 닿지 못함, op: 실패한 호출 종류.
// 언제 지우는지는 collector-status.ts 가 정한다.
export interface CollectState {
  lastError: string | null;
  unreachable?: boolean;
  op?: 'refresh' | 'request';
}

export const collectStateItem = storage.defineItem<CollectState>('local:collectState', {
  fallback: { lastError: null },
});

// 검토 대기 카드: 개인(personal)은 버렸고 민감정보는 가린 상태
export const pendingItem = storage.defineItem<RelatedCard[]>('local:pending', { fallback: [] });

// 배지와 팝업이 함께 쓰는 검토 대기 수. 수집기는 공유 후보만 보내지만 프로세스 경계라 한 번 더 거른다
export const shareableCount = (cards: RelatedCard[]) => cards.filter(isShareable).length;
