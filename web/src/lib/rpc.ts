import { BRIDGE_FROM_EXT, BRIDGE_FROM_WEB } from "@shared/bridge";
import { LOCAL_RPC_VERSION } from "@shared/collector";

// 확장 경유 응답을 기다리는 시간. native host 가 수집기를 기다리는 20초(native_host.py)보다 길게 둬서
// 수집기 쪽 시간 초과 오류가 먼저 도착하게 한다.
const EXTENSION_TIMEOUT_MS = 25000;

/** 로컬 수집기 RPC. NEXT_PUBLIC_LOCAL_BRIDGE=true 면 웹 서버의 /api/local, 아니면 확장(web-bridge 콘텐츠 스크립트)을 거친다 */
export async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const payload = { version: LOCAL_RPC_VERSION, method, params };
  if (process.env.NEXT_PUBLIC_LOCAL_BRIDGE === "true") return viaLocalRoute<T>(payload);
  return viaExtension<T>(payload);
}

async function viaLocalRoute<T>(payload: object): Promise<T> {
  const response = await fetch("/api/local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error ?? "로컬 연결 오류");
  return body.result as T;
}

// 같은 창·같은 출처에서 확장이 보낸, 이 요청 id 의 응답만 받는다 (다른 페이지·프레임의 메시지는 무시)
function isReply(event: MessageEvent, id: string): boolean {
  return (
    event.source === window &&
    event.origin === location.origin &&
    event.data?.source === BRIDGE_FROM_EXT &&
    event.data?.type === "rpc-result" &&
    event.data?.id === id
  );
}

function viaExtension<T>(payload: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const stop = () => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error("확장 프로그램과 로컬 수집기의 연결을 확인하세요."));
    }, EXTENSION_TIMEOUT_MS);
    function receive(event: MessageEvent) {
      if (!isReply(event, id)) return;
      stop();
      if (event.data.ok) resolve(event.data.result as T);
      else reject(new Error(event.data.error ?? "로컬 요청 실패"));
    }
    window.addEventListener("message", receive);
    window.postMessage({ source: BRIDGE_FROM_WEB, type: "rpc", id, ...payload }, location.origin);
  });
}
