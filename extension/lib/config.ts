// 개인 검토함 웹 주소. 우선순위: 팝업 설정 > 빌드 시 .env 의 WXT_WEB_URL > 배포 주소
// 로컬에서 고친 웹으로 통합 시험할 때는 WXT_WEB_URL=http://localhost:3000 으로 빌드하거나 팝업에서 주소를 바꾼다
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

// web-bridge 콘텐츠 스크립트가 붙는 주소 (manifest content_scripts.matches). 이 밖의 주소는 카드 넘기기가 안 된다.
// 스크립트가 붙어도 설정한 주소 하나에서만 답한다 (settings.ts isTrustedWebOrigin)
const LOCAL_WEB_ORIGINS = [LOCAL_WEB_URL, 'http://127.0.0.1:3000'];
export const WEB_BRIDGE_MATCHES = [...LOCAL_WEB_ORIGINS.map((origin) => `${origin}/*`), 'https://*.vercel.app/*'];

/** web-bridge 콘텐츠 스크립트가 붙는 주소인지 (WEB_BRIDGE_MATCHES 와 같은 범위) */
export function bridgeSupported(origin: string) {
  try {
    const u = new URL(origin);
    return LOCAL_WEB_ORIGINS.includes(origin) || (u.protocol === 'https:' && u.hostname.endsWith('.vercel.app'));
  } catch {
    return false;
  }
}

// 자동 수집 디바운스
export const COLLECT_DEBOUNCE_MS = 2000;
