// 확장 내부(콘텐츠 스크립트 · 팝업 · 백그라운드) runtime 메시지
import type { CollectedMessage } from '@shared/collector';

export type BgRequest =
  | { type: 'collect'; trigger: 'auto' | 'manual'; messages: CollectedMessage[] }
  | { type: 'removePending'; ids: string[] };

export type CollectResult =
  | { ok: true; newMessages: number; newCards: number }
  | { ok: false; error: string };

// 팝업 → 콘텐츠 스크립트: 지금 이 탭에서 대화를 읽을 수 있는지
export type TabPing = { type: 'ping' };
export type TabPingResult = {
  site: string;
  onConversation: boolean; // /c/... 대화 화면인지
  messageCount: number;
  selector: string | null; // 실제로 먹힌 셀렉터 (없으면 못 읽음)
};
