// chrome.storage.local 에 저장하는 값들 (WXT storage 래퍼)
import { storage } from '#imports';
import { SUBTOPICS, type RelatedCard, type Subtopic } from '@shared/types';
import { DEFAULT_WEB_URL } from './config';

export interface Settings {
  teamName: string;
  projectTopic: string;
  userName: string;
  enabledSubtopics: Subtopic[];
  autoCollect: boolean;
  webUrl?: string; // 개인 검토함 웹 주소 (origin). 없으면 DEFAULT_WEB_URL
}

export const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: { teamName: '', projectTopic: '', userName: '', enabledSubtopics: [...SUBTOPICS], autoCollect: false },
});

// 예전에 저장된 설정에는 webUrl 이 없을 수 있으므로 항상 이 함수로 읽는다
export const webUrlOf = (s: Settings) => s.webUrl || DEFAULT_WEB_URL;

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
