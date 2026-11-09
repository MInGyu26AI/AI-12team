// 개인 검토함 웹 주소. 우선순위: 팝업 설정 > 빌드 시 .env 의 WXT_WEB_URL > 배포 주소
// 로컬에서 고친 웹으로 통합 시험할 때는 WXT_WEB_URL=http://localhost:3000 으로 빌드하거나 팝업에서 주소를 바꾼다
import type { Settings } from './settings';

export const LOCAL_WEB_URL = 'http://localhost:3000';
export const PRODUCTION_WEB_URL = 'https://syncup-ashen.vercel.app'; // Vercel 배포 (soonsim1007/syncup)
export const DEFAULT_WEB_URL: string =
  normalizeWebUrl(import.meta.env.WXT_WEB_URL || PRODUCTION_WEB_URL) ?? PRODUCTION_WEB_URL;

// web-bridge 콘텐츠 스크립트가 붙는 주소 (manifest content_scripts.matches). 이 밖의 주소는 카드 넘기기가 안 된다.
// 스크립트가 붙어도 설정한 주소 하나에서만 답한다 (isTrustedWebOrigin)
const LOCAL_WEB_ORIGINS = [LOCAL_WEB_URL, 'http://127.0.0.1:3000'];
const DEPLOY_HOST_SUFFIX = '.vercel.app';
export const WEB_BRIDGE_MATCHES = [...LOCAL_WEB_ORIGINS.map((origin) => `${origin}/*`), `https://*${DEPLOY_HOST_SUFFIX}/*`];

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

/** web-bridge 콘텐츠 스크립트가 붙는 주소인지 (WEB_BRIDGE_MATCHES 와 같은 범위). origin 은 normalizeWebUrl 을 거친 값 */
export const bridgeSupported = (origin: string) =>
  LOCAL_WEB_ORIGINS.includes(origin) || (origin.startsWith('https://') && origin.endsWith(DEPLOY_HOST_SUFFIX));

// 설정값이 없거나 수집기 status 를 옮기기 전일 수 있으므로 항상 이 함수로 읽는다
export const webUrlOf = (s: Pick<Settings, 'webUrl'>) => s.webUrl || DEFAULT_WEB_URL;

/**
 * 이 출처의 페이지가 로컬 수집기 RPC(개인 후보 읽기·승인 등)를 부를 수 있는지. 사용자가 설정한 개인 검토함 주소 하나만 믿는다.
 * 로컬 개발 주소도 팝업에서 그 주소를 골랐을 때만 믿는다 (통합_사용법.md 4장).
 */
export const isTrustedWebOrigin = (settings: Pick<Settings, 'webUrl'>, origin: string) => origin === webUrlOf(settings);
