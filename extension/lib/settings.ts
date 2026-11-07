// chrome.storage.local 에 저장하는 값들 (WXT storage 래퍼)
import { storage } from '#imports';
import type { BatchRecord } from '@shared/bridge';
import { TURNS_PER_BATCH } from '@shared/batch';
import type { CollectedMessage } from '@shared/collector';
import { SUBTOPICS, type RelatedCard, type Subtopic } from '@shared/types';
import { DEFAULT_WEB_URL } from './config';

export interface Settings {
  teamName: string;
  projectTopic: string;
  userName: string;
  enabledSubtopics: Subtopic[];
  autoCollect: boolean; // false = 수집 일시정지
  webUrl?: string; // 개인 검토함 웹 주소 (origin). 없으면 DEFAULT_WEB_URL
  turnsPerBatch?: number; // 대화 N회(질문+답변)마다 분류. 없으면 TURNS_PER_BATCH(10)
  endsAt?: string | null; // 수집 종료 시각 (ISO). 지나면 남은 대화를 보내고 자동 수집을 끈다
}

export const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: { teamName: '', projectTopic: '', userName: '', enabledSubtopics: [...SUBTOPICS], autoCollect: false },
});

// 예전에 저장된 설정에는 새 필드가 없을 수 있으므로 항상 이 함수들로 읽는다
export const webUrlOf = (s: Settings) => s.webUrl || DEFAULT_WEB_URL;
export const turnsOf = (s: Settings) => Math.min(Math.max(Math.round(s.turnsPerBatch ?? TURNS_PER_BATCH), 1), 50);
export const endsAtOf = (s: Settings) => (s.endsAt ? new Date(s.endsAt) : null);
export const isEnded = (s: Settings, now = Date.now()) => {
  const end = endsAtOf(s);
  return !!end && end.getTime() <= now;
};

export const isConfigured = (s: Settings) => !!(s.teamName.trim() && s.projectTopic.trim() && s.userName.trim());

export interface CollectState {
  collectedIds: string[]; // 이미 수집한 메시지 id (중복 방지, 최근 것만 보관)
  collectedCount: number;
  lastCollectedAt: string | null;
  lastClassifier: 'native' | 'mock' | null;
  lastError: string | null;
}

export const collectStateItem = storage.defineItem<CollectState>('local:collectState', {
  fallback: { collectedIds: [], collectedCount: 0, lastCollectedAt: null, lastClassifier: null, lastError: null },
});

// 아직 분류에 안 보낸 발화 (N턴이 차거나 일시중지·종료 시각·수동 보내기 때 보냄)
export const bufferItem = storage.defineItem<CollectedMessage[]>('local:buffer', { fallback: [] });

// 최근 수집 묶음 (대화 수집 화면의 "최근 수집")
export const recentItem = storage.defineItem<BatchRecord[]>('local:recent', { fallback: [] });

// 검토 대기 카드: 개인(personal)은 버렸고 민감정보는 가린 상태
export const pendingItem = storage.defineItem<RelatedCard[]>('local:pending', { fallback: [] });

export const MAX_REMEMBERED_IDS = 5000;
export const MAX_RECENT = 20;
