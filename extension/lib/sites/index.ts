import { chatgpt } from './chatgpt';
import type { SiteAdapter } from './types';

// 지원 사이트 목록. 콘텐츠 스크립트 matches, 우클릭 메뉴, background 출처 검사가 이 목록을 쓴다.
// 사이트를 늘리면 팝업의 'chatgpt.com'·'ChatGPT' 안내 문구(SetupForm 수집 범위 안내, TabNotice, AutoCollectSwitch)도 고친다.
// 확장 밖에서는 shared/collector.ts 의 CollectedMessage.site 와 로컬 수집기 clean_message 의 site 허용 목록도 늘려야 한다.
export const SITES: SiteAdapter[] = [chatgpt];

export const CHAT_PAGE_MATCHES = SITES.flatMap((s) => s.hosts.map((host) => `https://${host}/*`));

export const siteForHost = (hostname: string) => SITES.find((s) => s.hosts.includes(hostname)) ?? null;

export function siteForUrl(url: string) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? siteForHost(u.hostname) : null;
  } catch {
    return null;
  }
}

export type { SiteAdapter };
