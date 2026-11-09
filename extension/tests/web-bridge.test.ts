// @vitest-environment happy-dom
// @vitest-environment-options {"url": "http://localhost:3000/review"}
// 개인 검토함 웹 ↔ 확장 중계(web-bridge 콘텐츠 스크립트). 페이지 쪽은 web/src/lib/rpc.ts 처럼 window.postMessage 로 묻고 답을 기다린다.
// 스크립트는 WEB_BRIDGE_MATCHES 전체에 붙고 리스너도 항상 달지만, 팝업에서 설정한 주소의 페이지에만 메시지마다 확인해 답한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ContentScriptContext } from '#imports';
import { BRIDGE_FROM_EXT, BRIDGE_FROM_WEB } from '@shared/bridge';
import webBridge from '@/entrypoints/web-bridge.content';
import { settingsItem } from '@/lib/settings';
import { LOCAL_WEB_URL, PRODUCTION_WEB_URL } from '@/lib/web-url';

const invalidated: (() => void)[] = [];
const ctx = { onInvalidated: (stop: () => void) => invalidated.push(stop) } as unknown as ContentScriptContext;

let toBackground: ReturnType<typeof vi.fn>;
const replies: { id: string }[] = [];
const collectReply = (event: MessageEvent) => {
  if (event.data?.source === BRIDGE_FROM_EXT) replies.push(event.data);
};

const useWebUrl = async (webUrl: string | undefined) => settingsItem.setValue({ ...(await settingsItem.getValue()), webUrl });
// 페이지의 window.postMessage 가 Chrome 에서 도착하는 모양(source = 같은 window, origin = 페이지 출처)으로 보낸다.
// happy-dom 의 postMessage 는 source 를 시험용 전역 window 와 다른 객체로 채워서 직접 만든다
const ask = (id: string) =>
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { source: BRIDGE_FROM_WEB, type: 'rpc', id, method: 'privacy.list', params: { limit: 5 } },
      origin: location.origin,
      source: window,
    }),
  );
// postMessage 전달·설정 읽기·background 응답·답 전달이 모두 끝날 만큼 기다린다 (실제 I/O 없음)
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  fakeBrowser.reset();
  replies.length = 0;
  toBackground = vi.fn(async () => ({ ok: true, result: { cards: [] } }));
  vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(toBackground as never);
  window.addEventListener('message', collectReply);
  webBridge.main(ctx);
});

afterEach(() => {
  window.removeEventListener('message', collectReply);
  invalidated.splice(0).forEach((stop) => stop());
});

describe('웹 화면 RPC 중계', () => {
  it('설정한 주소의 페이지면 background 로 넘기고 같은 id 로 답한다', async () => {
    await useWebUrl(LOCAL_WEB_URL);
    ask('r1');
    await settle();
    expect(toBackground).toHaveBeenCalledWith({ type: 'rpc', method: 'privacy.list', params: { limit: 5 } });
    expect(replies).toEqual([
      { source: BRIDGE_FROM_EXT, type: 'rpc-ack', id: 'r1' },
      { ok: true, result: { cards: [] }, source: BRIDGE_FROM_EXT, type: 'rpc-result', id: 'r1' },
    ]);
  });

  it('수집기 응답을 기다리기 전에 받았다는 신호(rpc-ack)를 먼저 보낸다', async () => {
    await useWebUrl(LOCAL_WEB_URL);
    let answer: (value: unknown) => void = () => {};
    toBackground.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    ask('slow');
    await settle();
    expect(replies).toEqual([{ source: BRIDGE_FROM_EXT, type: 'rpc-ack', id: 'slow' }]);
    answer({ ok: true, result: {} });
    await settle();
    expect(replies.map((r) => (r as { type?: string }).type)).toEqual(['rpc-ack', 'rpc-result']);
  });

  it.each([
    ['주소를 설정하지 않음(배포 주소)', undefined],
    ['배포 주소', PRODUCTION_WEB_URL],
    ['다른 배포 주소', 'https://other-team.vercel.app'],
    ['같은 컴퓨터의 다른 이름', 'http://127.0.0.1:3000'],
  ])('설정한 주소가 아니면 답하지도 background 로 넘기지도 않는다: %s', async (_name, webUrl) => {
    await useWebUrl(webUrl);
    ask('r1');
    await settle();
    expect(toBackground).not.toHaveBeenCalled();
    expect(replies).toEqual([]);
  });

  it('리스너는 처음부터 붙어 있고, 주소를 바꾸면 새로고침 없이 메시지마다 따른다', async () => {
    // beforeEach 의 main 은 믿지 않는 주소(기본값) 상태에서 한 번만 실행됐다
    ask('before');
    await settle();
    await useWebUrl(LOCAL_WEB_URL);
    ask('trusted');
    await settle();
    await useWebUrl(PRODUCTION_WEB_URL);
    ask('after');
    await settle();
    expect(replies.map((r) => r.id)).toEqual(['trusted', 'trusted']); // rpc-ack 와 rpc-result
    expect(toBackground).toHaveBeenCalledTimes(1);
  });
});
