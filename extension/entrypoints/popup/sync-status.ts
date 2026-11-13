// '프로젝트만 수집' 상태 한 줄과 '싱크 맞추기' 결과 안내 (docs/sync-contract.md 5장).
// 팝업은 SyncState 를 읽기만 한다. 켜고 끄는 일과 패스는 백그라운드가 한다.
import type { SyncNowResult } from '@shared/bridge';
import type { SyncState, SyncStopReason } from '@/lib/chatgpt-sync/state';
import type { Settings } from '@/lib/settings';
import { sendBlockedReason } from '@/lib/settings';
import { formatAgo, formatClock } from './time-format';

export interface PopupNotice {
  tone: 'info' | 'ok' | 'error';
  text: string;
}

// 멈춤 문구. 로그인·탭 문구는 약속 5장 "실패 문구"와 같다
const STOP_TEXT: Record<SyncStopReason, string> = {
  collection_paused: '수집이 멈춰 있어 동기화도 쉬어요. 자동 수집을 다시 켜 주세요',
  no_tab: 'chatgpt.com 탭을 열어 두세요',
  logged_out: 'ChatGPT에 로그인하세요',
  account_mismatch: '켤 때와 다른 ChatGPT 계정이에요. 껐다가 다시 켜 주세요',
  shape_changed: 'ChatGPT 화면이 바뀌어 동기화를 멈췄어요',
};

const REST_TEXT = { rate_limited: '요청 제한', forbidden: '접속 제한' } as const;

/** 스위치 아래 한 줄. 동기화가 꺼져 있으면 null */
export function syncStatusLine(state: SyncState, now = Date.now()): PopupNotice | null {
  if (!state.enabled) return null;
  const project = state.project ? ` · ${state.project.name} 프로젝트` : '';
  switch (state.mode) {
    case 'stopped':
      return { tone: 'error', text: state.stopReason ? STOP_TEXT[state.stopReason] : '동기화가 멈췄어요. 껐다가 다시 켜 주세요' };
    case 'rest': {
      const reason = state.restReason ? REST_TEXT[state.restReason] : '잠시';
      const until = state.restUntil ? formatClock(state.restUntil, now) : '';
      return { tone: 'info', text: `쉼: ${reason}${until ? ` · ${until}에 다시` : ''}` };
    }
    case 'running':
      return { tone: 'info', text: `동기화: 확인 중${project}` };
    default: {
      const when = state.lastPassFinishedAt ? formatAgo(state.lastPassFinishedAt, now) : '곧 첫 확인';
      return { tone: 'info', text: `동기화: ${when}${project}` };
    }
  }
}

/**
 * '싱크 맞추기'를 누를 수 없는 이유, 누를 수 있으면 null.
 * 수집기는 수집 중일 때만 받으므로 sendBlockedReason 을 그대로 쓴다.
 * 동기화가 꺼져 있으면 flush 만 되므로, 쌓인 대화가 없을 때는 할 일이 없다.
 */
export function syncNowBlockedReason(settings: Settings, syncEnabled: boolean, now = Date.now()): string | null {
  const blocked = sendBlockedReason(settings, now);
  if (blocked) return blocked;
  if (!syncEnabled && !settings.bufferedTurns) return '쌓인 대화가 없어요. 프로젝트만 수집을 켜면 새 대화를 가져와요';
  return null;
}

/** SyncNowResult 를 쉬운 말로. flush 결과는 sync 결과 뒤에 붙인다 */
export function syncNowNotice(result: SyncNowResult): PopupNotice {
  const flushText = result.flushed ? '쌓인 대화는 분류에 보냈어요' : result.blockedReason ?? '';
  const join = (head: string) => (flushText ? `${head}. ${flushText}` : head);
  switch (result.sync) {
    case 'ran':
      return {
        tone: 'ok',
        text: join(result.newTurns ? `새 대화 ${result.newTurns}회를 가져왔어요` : '새로 가져올 대화는 없어요'),
      };
    case 'off':
      return { tone: result.flushed ? 'ok' : 'info', text: flushText || '동기화가 꺼져 있어요' };
    case 'resting':
      return { tone: 'info', text: join('동기화는 쉬는 중이에요') };
    case 'busy':
      return { tone: 'info', text: join('동기화가 이미 돌고 있어요') };
    case 'no-tab':
      return { tone: 'error', text: join('chatgpt.com 탭을 열어 두세요') };
    case 'failed':
      return { tone: 'error', text: join('동기화를 못 했어요. 위 안내를 확인해 주세요') };
  }
}
