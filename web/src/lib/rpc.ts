import {
  BRIDGE_FROM_EXT,
  BRIDGE_FROM_WEB,
  EXT_SYNC_NOW,
  type ExtStatus,
  type SyncNowParams,
  type SyncNowResult,
} from "@shared/bridge";
import { LOCAL_RPC_VERSION } from "@shared/collector";

// 확장 경유 응답을 기다리는 시간. native host 가 수집기를 기다리는 20초(native_host.py)보다 길게 둬서
// 수집기 쪽 시간 초과 오류가 먼저 도착하게 한다.
const EXTENSION_TIMEOUT_MS = 25000;
// 싱크 맞추기는 확장이 ChatGPT 대화를 최대 20건 받는 동안(요청 사이 1~2초) 끝나지 않으므로 더 오래 기다린다
const SYNC_NOW_TIMEOUT_MS = 90000;
// 확장이 요청을 받았다는 신호(rpc-ack)를 기다리는 시간. 확장은 받자마자 보내므로 이 안에 없으면 확장이 없다고 본다
const EXTENSION_ACK_MS = 2000;

/** 확장이 요청을 받지 않음: 설치되지 않았거나, 팝업의 개인 검토함 주소가 이 페이지가 아님 (web-bridge 는 그런 페이지에 답하지 않는다) */
export class ExtensionMissing extends Error {
  constructor() {
    super("확장 프로그램이 설치되지 않았습니다. 설치했다면 팝업의 개인 검토함 주소가 이 페이지 주소인지 확인하세요.");
  }
}

/** 로컬 수집기 RPC. NEXT_PUBLIC_LOCAL_BRIDGE=true 면 웹 서버의 /api/local, 아니면 확장(web-bridge 콘텐츠 스크립트)을 거친다 */
export async function rpc<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = EXTENSION_TIMEOUT_MS): Promise<T> {
  const payload = { version: LOCAL_RPC_VERSION, method, params };
  if (process.env.NEXT_PUBLIC_LOCAL_BRIDGE === "true") return viaLocalRoute<T>(payload);
  return viaExtension<T>(payload, timeoutMs);
}

/**
 * 싱크 맞추기 (docs/sync-contract.md 5장 syncNow): 확장이 프로젝트 동기화 패스를 한 번 돌리고, 수집 중이면 collection.flush 를 부른다.
 * NEXT_PUBLIC_LOCAL_BRIDGE=true 면 확장이 없으므로 수집 중일 때 collection.flush 만 부른다 (sync 는 늘 'off').
 */
export async function syncNow(reason: SyncNowParams["reason"]): Promise<SyncNowResult> {
  if (process.env.NEXT_PUBLIC_LOCAL_BRIDGE === "true") return flushOnly();
  return rpc<SyncNowResult>(EXT_SYNC_NOW, { reason }, SYNC_NOW_TIMEOUT_MS);
}

async function flushOnly(): Promise<SyncNowResult> {
  const blockedReason = collectBlockedReason(await rpc<ExtStatus>("collection.status"));
  if (blockedReason) return { sync: "off", newTurns: 0, flushed: false, blockedReason };
  await rpc("collection.flush");
  return { sync: "off", newTurns: 0, flushed: true };
}

// 수집 중이 아닌 이유, 수집 중이면 null (확장의 sendBlockedReason 과 같은 판정. 설정 여부는 수집기가 flush 에서 확인한다)
function collectBlockedReason(status: ExtStatus): string | null {
  if (Date.parse(status.endsAt) <= Date.now()) return "수집 종료 시각이 지났어요. 종료 시각을 갱신하고 자동 수집을 켜 주세요";
  if (!status.autoCollect) return "수집이 꺼져 있어요. 자동 수집을 켜 주세요";
  return null;
}

type SyncTone = "success" | "info" | "warning" | "error";

const SYNC_HEAD: Record<SyncNowResult["sync"], { tone: SyncTone; text: (newTurns: number) => string }> = {
  ran: { tone: "success", text: (n) => (n > 0 ? `새 대화 ${n}개를 가져왔어요` : "새로 가져올 대화가 없어요") },
  off: { tone: "success", text: () => "프로젝트 동기화는 꺼져 있어요" },
  resting: { tone: "warning", text: () => "ChatGPT 요청을 잠시 쉬는 중이에요" },
  "no-tab": { tone: "warning", text: () => "chatgpt.com 탭을 하나 열어 두세요" },
  busy: { tone: "info", text: () => "이미 맞추는 중이에요" },
  failed: { tone: "error", text: () => "싱크를 맞추지 못했어요. 확장 팝업에서 상태를 확인하세요" },
};

/** 싱크 맞추기 결과를 화면에 알릴 짧은 문구와 토스트 종류로 바꾼다 */
export function syncNowSummary(result: SyncNowResult): { tone: SyncTone; text: string } {
  const head = SYNC_HEAD[result.sync] ?? SYNC_HEAD.failed; // 모르는 값은 실패로 본다
  const tail = result.flushed ? "쌓인 대화는 분류에 보냈어요" : result.blockedReason;
  const tone = head.tone === "success" && !result.flushed && result.blockedReason ? "warning" : head.tone;
  return { tone, text: tail ? `${head.text(result.newTurns)}. ${tail}` : head.text(result.newTurns) };
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

// 같은 창·같은 출처에서 확장이 보낸, 이 요청 id 의 메시지만 받는다 (다른 페이지·프레임의 메시지는 무시)
function isFromExtension(event: MessageEvent, id: string, type: "rpc-ack" | "rpc-result"): boolean {
  return (
    event.source === window &&
    event.origin === location.origin &&
    event.data?.source === BRIDGE_FROM_EXT &&
    event.data?.type === type &&
    event.data?.id === id
  );
}

function viaExtension<T>(payload: object, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const stop = () => {
      clearTimeout(ackTimer);
      clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
    const ackTimer = setTimeout(() => {
      stop();
      reject(new ExtensionMissing());
    }, EXTENSION_ACK_MS);
    const timer = setTimeout(() => {
      stop();
      reject(new Error("확장 프로그램과 로컬 수집기의 연결을 확인하세요."));
    }, timeoutMs);
    function receive(event: MessageEvent) {
      if (isFromExtension(event, id, "rpc-ack")) {
        clearTimeout(ackTimer);
        return;
      }
      if (!isFromExtension(event, id, "rpc-result")) return;
      stop();
      if (event.data.ok) resolve(event.data.result as T);
      else reject(new Error(event.data.error ?? "로컬 요청 실패"));
    }
    window.addEventListener("message", receive);
    window.postMessage({ source: BRIDGE_FROM_WEB, type: "rpc", id, ...payload }, location.origin);
  });
}
