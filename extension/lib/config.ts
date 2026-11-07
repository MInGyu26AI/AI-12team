// 웹 주소 (개인 검토함). .env 의 WXT_WEB_URL, 기본 http://localhost:3000
export const WEB_URL: string = (import.meta.env.WXT_WEB_URL || 'http://localhost:3000').replace(/\/$/, '');

// web-bridge 가 검토 대기 카드를 넘겨도 되는 웹 주소 (매칭은 *.vercel.app 까지 넓지만, 실제로는 여기 있는 곳만)
export const BRIDGE_ORIGINS = [...new Set([new URL(WEB_URL).origin, 'http://localhost:3000'])];

// 자동 수집 디바운스
export const COLLECT_DEBOUNCE_MS = 2000;
