import { chatgpt } from './chatgpt';
import type { SiteAdapter } from './types';

// 지원 사이트 목록. 새 사이트는 여기에 추가 + ai-chat.content.ts 의 matches 에 주소 추가
export const SITES: SiteAdapter[] = [chatgpt];

export const siteForHost = (hostname: string) => SITES.find((s) => s.hosts.includes(hostname)) ?? null;

export type { SiteAdapter };
