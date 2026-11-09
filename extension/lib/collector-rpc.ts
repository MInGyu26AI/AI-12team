// 로컬 수집기(Native Messaging host) 호출. native_host.py 는 {ok, result} 또는 {ok: false, code?: 'unreachable', error} 로 답한다
import { LOCAL_RPC_VERSION, NATIVE_HOST } from '@shared/collector';

/** 로컬 수집기에 닿지 못한 실패. 수집기가 요청을 거절한 실패(Error)와 구분한다 */
export class CollectorUnreachable extends Error {}

export const errorText = (error: unknown) => (error instanceof Error ? error.message : '로컬 연결 오류');

export async function rpc<T>(method: string, params: unknown = {}): Promise<T> {
  let response;
  try {
    response = await browser.runtime.sendNativeMessage(NATIVE_HOST, { version: LOCAL_RPC_VERSION, method, params });
  } catch (error) {
    throw new CollectorUnreachable(errorText(error));
  }
  if (!response) throw new CollectorUnreachable('로컬 수집기 연결 실패');
  if (!response.ok && response.code === 'unreachable') throw new CollectorUnreachable(response.error);
  if (!response.ok) throw new Error(response.error ?? '로컬 수집기 요청 실패');
  return response.result;
}
