import { BRIDGE_FROM_WEB, BRIDGE_FROM_EXT } from '@shared/bridge';

export async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const payload = { version: 1, method, params };
  if (process.env.NEXT_PUBLIC_LOCAL_BRIDGE === 'true') {
    const response = await fetch('/api/local', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error ?? '로컬 연결 오류');
    return body.result as T;
  }
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { window.removeEventListener('message', receive); reject(new Error('확장 프로그램과 로컬 수집기의 연결을 확인하세요.')); }, 25000);
    function receive(event: MessageEvent) {
      if (event.source !== window || event.origin !== location.origin || event.data?.source !== BRIDGE_FROM_EXT || event.data?.type !== 'rpc-result' || event.data?.id !== id) return;
      clearTimeout(timer); window.removeEventListener('message', receive);
      if (event.data.ok) resolve(event.data.result as T);
      else reject(new Error(event.data.error ?? '로컬 요청 실패'));
    }
    window.addEventListener('message', receive);
    window.postMessage({ source: BRIDGE_FROM_WEB, type: 'rpc', id, ...payload }, location.origin);
  });
}
