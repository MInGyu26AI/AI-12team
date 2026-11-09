// entrypoints/background.ts 를 가짜 browser 위에서 띄우고, 로컬 수집기(native host)는 메서드별 가짜 응답으로 바꾼다
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ExtStatus } from '@shared/bridge';
import background from '@/entrypoints/background';
import { LOCAL_WEB_URL, PRODUCTION_WEB_URL } from '@/lib/config';
import { settingsItem } from '@/lib/settings';

const STATUS: ExtStatus = {
  version: '1',
  configured: true,
  autoCollect: true,
  turnsPerBatch: 10,
  bufferedTurns: 0,
  endsAt: '2026-11-10T00:00:00+00:00',
  lastCollectedAt: null,
  lastClassifier: null,
  teamName: '팀',
  userName: '나',
  projectTopic: '주제',
  recent: [],
};

const nativeCalls: string[] = [];

async function fakeCollector(_host: string, request: { method: string }) {
  nativeCalls.push(request.method);
  if (request.method === 'candidates.list') return { ok: true, result: { cards: [], status: STATUS } };
  return { ok: true, result: { method: request.method } };
}

const send = async (message: unknown, sender: object) => (await fakeBrowser.runtime.onMessage.trigger(message, sender, () => {}))[0];
const fromPage = (url: string) => ({ url, tab: { id: 1 }, id: fakeBrowser.runtime.id });
const useWebUrl = async (webUrl: string) => settingsItem.setValue({ ...(await settingsItem.getValue()), webUrl });

beforeEach(async () => {
  fakeBrowser.reset();
  vi.spyOn(fakeBrowser.runtime, 'sendNativeMessage').mockImplementation(fakeCollector as never);
  vi.spyOn(fakeBrowser.action, 'setBadgeText').mockResolvedValue(undefined);
  vi.spyOn(fakeBrowser.contextMenus.onClicked, 'addListener').mockImplementation(() => {}); // fakeBrowser 에 없는 API
  background.main();
  await new Promise((resolve) => setTimeout(resolve, 0)); // 시작할 때 하는 상태 새로 고침이 끝나게 둔다
  nativeCalls.length = 0;
});

describe('웹 화면의 수집기 RPC', () => {
  it('설정한 주소가 배포 주소면 localhost:3000 페이지의 요청은 수집기에 닿지 않는다', async () => {
    await useWebUrl(PRODUCTION_WEB_URL);
    const result = await send({ type: 'rpc', method: 'privacy.list', params: {} }, fromPage('http://localhost:3000/review'));
    expect(result).toEqual({ ok: false, error: '허용되지 않은 연결 화면' });
    expect(nativeCalls).not.toContain('privacy.list');
  });

  it('로컬 개발 주소를 골랐으면 그 주소의 페이지만 수집기를 부를 수 있다', async () => {
    await useWebUrl(LOCAL_WEB_URL);
    const result = await send({ type: 'rpc', method: 'privacy.list', params: {} }, fromPage('http://localhost:3000/review'));
    expect(result).toEqual({ ok: true, result: { method: 'privacy.list' } });
    const other = await send({ type: 'rpc', method: 'privacy.list', params: {} }, fromPage('http://127.0.0.1:3000/review'));
    expect(other).toEqual({ ok: false, error: '허용되지 않은 연결 화면' });
  });
});
