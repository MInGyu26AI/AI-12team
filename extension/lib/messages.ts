// 확장 내부(콘텐츠 스크립트 · 팝업 · 백그라운드) runtime 메시지
import type { ExtSettingsPatch } from '@shared/bridge';
import type { CollectedMessage } from '@shared/collector';

export type BgRequest =
  | { type: 'collect'; trigger: 'auto' | 'manual' | 'selection'; messages: CollectedMessage[] }
  | { type: 'flush' } // 지금 쌓인 대화까지 분류 (팝업 "지금 분류하기")
  | { type: 'updateSettings'; patch: ExtSettingsPatch };

export type CollectResult =
  | { ok: true; newMessages: number; newCards: number }
  | { ok: false; error: string };

// 팝업 → 콘텐츠 스크립트: 지금 이 탭에서 대화를 읽을 수 있는지
export type TabPing = { type: 'ping' };
export type TabPingResult = {
  site: string;
  onConversation: boolean; // /c/... 대화 화면인지
  messageCount: number;
  selector: string | null; // 실제로 먹힌 전략 이름 (없으면 못 읽음)
  guessedRoles: number;
};

// 백그라운드 → 콘텐츠 스크립트: 화면 안내 띄우기 (우클릭 메뉴 결과 등)
export type TabToast = { type: 'toast'; text: string; tone: 'ok' | 'error' };

export const READ_FAIL_GUIDE = '대화를 못 읽었어요. 텍스트를 드래그해서 보내거나 개인 검토함에 붙여넣어 주세요';
