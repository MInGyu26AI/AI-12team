// 개인 검토함 웹 주소. 우선순위: 팝업 설정 > 빌드 시 .env 의 WXT_WEB_URL > 배포 주소
export const LOCAL_WEB_URL = 'http://localhost:3000';
export const PRODUCTION_WEB_URL = 'https://syncup-ashen.vercel.app'; // Vercel 배포 (soonsim1007/syncup)
export const DEFAULT_WEB_URL: string =
  normalizeWebUrl(import.meta.env.WXT_WEB_URL || PRODUCTION_WEB_URL) ?? PRODUCTION_WEB_URL;

/** "https://x.vercel.app/review/" → "https://x.vercel.app" (잘못된 주소면 null) */
export function normalizeWebUrl(input: string): string | null {
  try {
    const u = new URL(input.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * web-bridge 콘텐츠 스크립트가 실제로 동작하는 주소인지.
 * manifest 의 matches(localhost:3000, *.vercel.app) 밖의 주소는 콘텐츠 스크립트가 안 붙으므로 카드 넘기기가 안 된다.
 */
export function bridgeSupported(origin: string) {
  try {
    const u = new URL(origin);
    return origin === LOCAL_WEB_URL || (u.protocol === 'https:' && u.hostname.endsWith('.vercel.app'));
  } catch {
    return false;
  }
}

// 자동 수집 디바운스
export const COLLECT_DEBOUNCE_MS = 2000;
