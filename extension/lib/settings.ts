// chrome.storage.local 에 저장하는 값들 (WXT storage 래퍼)
import { storage } from '#imports';
import { SUBTOPICS, type RelatedCard, type Subtopic } from '@shared/types';

export interface Settings {
  teamName: string;
  projectTopic: string;
  userName: string;
  enabledSubtopics: Subtopic[];
  autoCollect: boolean;
}

export const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: { teamName: '', projectTopic: '', userName: '', enabledSubtopics: [...SUBTOPICS], autoCollect: false },
});

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

// 검토 대기 카드: 개인(personal)은 버렸고 민감정보는 가린 상태
export const pendingItem = storage.defineItem<RelatedCard[]>('local:pending', { fallback: [] });

export const MAX_REMEMBERED_IDS = 5000;
