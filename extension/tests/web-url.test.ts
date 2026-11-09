import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEB_URL,
  LOCAL_WEB_URL,
  PRODUCTION_WEB_URL,
  WEB_BRIDGE_MATCHES,
  bridgeSupported,
  normalizeWebUrl,
} from '@/lib/config';
import { isTrustedWebOrigin } from '@/lib/settings';

describe('isTrustedWebOrigin', () => {
  it('설정한 주소 하나만 믿는다: 배포 주소를 고르면 로컬 3000번 페이지는 못 부른다', () => {
    const settings = { webUrl: PRODUCTION_WEB_URL };
    expect(isTrustedWebOrigin(settings, PRODUCTION_WEB_URL)).toBe(true);
    expect(isTrustedWebOrigin(settings, 'http://localhost:3000')).toBe(false);
    expect(isTrustedWebOrigin(settings, 'http://127.0.0.1:3000')).toBe(false);
    expect(isTrustedWebOrigin(settings, 'https://other.vercel.app')).toBe(false);
  });

  it('로컬 개발 주소는 그 주소를 골랐을 때만 믿는다', () => {
    expect(isTrustedWebOrigin({ webUrl: LOCAL_WEB_URL }, 'http://localhost:3000')).toBe(true);
    expect(isTrustedWebOrigin({ webUrl: LOCAL_WEB_URL }, 'http://127.0.0.1:3000')).toBe(false);
    expect(isTrustedWebOrigin({ webUrl: 'http://127.0.0.1:3000' }, 'http://127.0.0.1:3000')).toBe(true);
  });

  it('주소를 설정하지 않았으면 빌드 기본 주소(WXT_WEB_URL, 없으면 배포 주소)만 믿는다', () => {
    expect(isTrustedWebOrigin({}, DEFAULT_WEB_URL)).toBe(true);
    expect(isTrustedWebOrigin({}, 'https://other.vercel.app')).toBe(false);
  });
});

describe('bridgeSupported', () => {
  it('web-bridge 콘텐츠 스크립트가 붙는 주소(manifest matches)와 같은 범위다', () => {
    const supported = ['http://localhost:3000', 'http://127.0.0.1:3000', 'https://syncup-ashen.vercel.app'];
    supported.forEach((origin) => expect(bridgeSupported(origin)).toBe(true));
    ['http://localhost:3001', 'http://x.vercel.app', 'https://example.com'].forEach((origin) => expect(bridgeSupported(origin)).toBe(false));
    expect(WEB_BRIDGE_MATCHES).toEqual(['http://localhost:3000/*', 'http://127.0.0.1:3000/*', 'https://*.vercel.app/*']);
  });
});

describe('normalizeWebUrl', () => {
  it('경로를 떼고 origin 만 남기며, http(s) 가 아니면 null', () => {
    expect(normalizeWebUrl(' https://x.vercel.app/review/ ')).toBe('https://x.vercel.app');
    expect(normalizeWebUrl('ftp://x')).toBeNull();
    expect(normalizeWebUrl('주소 아님')).toBeNull();
  });
});
