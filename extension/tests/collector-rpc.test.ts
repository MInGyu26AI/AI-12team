// 확장이 로컬 수집기(native host)로 보내는 요청 봉투. native_host.py 는 {version, method, params} 를 받고 version 이 다르면 거절한다.
// 공용 상수 이름이 바뀌어 import 가 undefined 가 되면 tsc 말고는 잡지 못했으므로 값까지 확인한다
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { LOCAL_RPC_VERSION, NATIVE_HOST } from '@shared/collector';
import { rpc } from '@/lib/collector-rpc';

let sendNative: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fakeBrowser.reset();
  sendNative = vi.fn(async () => ({ ok: true, result: { cards: [] } }));
  vi.spyOn(fakeBrowser.runtime, 'sendNativeMessage').mockImplementation(sendNative as never);
});

describe('로컬 수집기 요청 봉투', () => {
  it('공용 상수의 숫자 version 과 method, params 만 담아 수집기 host 로 보낸다', async () => {
    await rpc('turns.append', { messages: [], flush: true });
    expect(sendNative).toHaveBeenCalledTimes(1);
    const [host, request] = sendNative.mock.calls[0]!;
    expect(host).toBe(NATIVE_HOST);
    expect(Object.keys(request).sort()).toEqual(['method', 'params', 'version']);
    expect(Number.isInteger(request.version)).toBe(true);
    expect(request.version).toBe(LOCAL_RPC_VERSION);
    expect(request).toEqual({ version: LOCAL_RPC_VERSION, method: 'turns.append', params: { messages: [], flush: true } });
  });

  it('params 를 주지 않으면 빈 객체를 보낸다', async () => {
    await rpc('candidates.list');
    expect(sendNative.mock.calls[0]![1]).toEqual({ version: LOCAL_RPC_VERSION, method: 'candidates.list', params: {} });
  });
});
