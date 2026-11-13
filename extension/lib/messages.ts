// 확장 내부(콘텐츠 스크립트 · 팝업 · 백그라운드) runtime 메시지
import type { ExtSettingsPatch } from '@shared/bridge';
import type { CollectedMessage } from '@shared/collector';

export type BgRequest =
  | { type: 'collect'; trigger: 'auto' | 'manual' | 'selection'; messages: CollectedMessage[] }
  | { type: 'flush' } // 지금 쌓인 대화까지 분류 (팝업 "싱크 맞추기")
  | { type: 'updateSettings'; patch: ExtSettingsPatch } // 로컬 수집기 collection.configure 로 그대로 보낸다
  | { type: 'refresh' } // 로컬 수집기 상태 다시 읽기 (팝업을 열 때)
  | { type: 'rpc'; method: string; params?: unknown }; // 개인 검토함 웹 → 로컬 수집기 (web-bridge 가 중계)

export type BgResponse = { ok: true; result?: unknown } | { ok: false; error: string };

// intakeIssues: 수집기가 형식 오류나 같은 id 의 내용 변경으로 분류하지 않고 따로 보관한 발화 수
export type CollectResult =
  | { ok: true; newMessages: number; intakeIssues: number }
  | { ok: false; error: string };

export const sendToBackground = <T = BgResponse>(request: BgRequest) => browser.runtime.sendMessage(request) as Promise<T>;

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

/** "싱크업에 보내기"·선택 보내기·우클릭 메뉴 결과를 화면 안내로 */
export function collectResultToast(result: CollectResult): TabToast {
  if (!result.ok) return { type: 'toast', text: result.error, tone: 'error' };
  if (result.intakeIssues) {
    const text = `${result.intakeIssues}개는 형식이 맞지 않거나 이미 보낸 메시지와 내용이 달라 분류하지 않고 따로 보관했어요`;
    return { type: 'toast', text, tone: 'error' };
  }
  const text = result.newMessages ? '분류 대기함에 저장했어요. 승인함에서 결과를 확인하세요.' : '이미 보낸 내용이에요';
  return { type: 'toast', text, tone: 'ok' };
}

export const READ_FAIL_GUIDE = '대화를 못 읽었어요. 텍스트를 드래그해서 보내거나 개인 검토함에 붙여넣어 주세요';
