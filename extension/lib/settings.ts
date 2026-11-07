// chrome.storage 에 저장되는 사용자 설정 (WXT storage 래퍼)
import { storage } from '#imports';

export interface Settings {
  teamCode: string;
  userName: string;
  collecting: boolean;
  endsAt: string | null; // ISO. 이 시각이 지나면 수집·외부 전송 중단 (CLAUDE.md §9)
  allowedSites: string[];
  localProjects: string[];
}

export const settings = storage.defineItem<Settings>('local:settings', {
  fallback: {
    teamCode: '',
    userName: '',
    collecting: false,
    endsAt: null,
    allowedSites: ['chatgpt.com'],
    localProjects: [],
  },
});

export const isCollectingNow = (s: Settings, site: string) =>
  s.collecting &&
  s.allowedSites.includes(site) &&
  (!s.endsAt || Date.now() < new Date(s.endsAt).getTime());
