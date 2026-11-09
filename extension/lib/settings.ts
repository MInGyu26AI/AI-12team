// chrome.storage.local 에 저장하는 값들 (WXT storage 래퍼)
import { storage } from '#imports';
import type { ExtStatus } from '@shared/bridge';
import { TURNS_PER_BATCH } from '@shared/batch';
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
  // 아래는 로컬 수집기 상태(candidates.list 의 status)를 background 가 병합한 값
  bufferedTurns?: ExtStatus['bufferedTurns'];
  lastCollectedAt?: ExtStatus['lastCollectedAt'];
  lastClassifier?: ExtStatus['lastClassifier'];
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

// 수집·분류 상태는 로컬 수집기가 관리하므로 확장에는 확장 자신이 로컬 수집기를 부른 마지막 실패만 남긴다.
// 상태 새로 고침이 성공하면 연결 실패(unreachable)와 새로 고침 자신의 실패(op='refresh')를 지운다.
// 수집·지금 분류·설정 저장이 거절된 오류는 그 요청이 다시 성공할 때까지 남는다. 웹 화면 요청의 실패는 웹 화면이 알린다.
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
