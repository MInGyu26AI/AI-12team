import type { SyncNowResult } from '@shared/bridge';
import { sendToBackground, type BgResponse, type TabToast } from './messages';
import { EXTENSION_UPDATED_GUIDE, deliverTeamRecord, loadTeamRecord, type TeamRecordSource } from './team-record';

// AI 채팅 화면 오른쪽 아래의 "싱크업에 보내기"·"선택한 내용 보내기"·"싱크 맞추기"·"팀 기록 불러오기" 버튼과 안내. shadow DOM 으로 사이트 스타일과 분리한다.
const TEMPLATE = `
  <style>
    :host { all: initial; }
    .wrap { position: fixed; right: 20px; bottom: 96px; z-index: 2147483646; display: flex; flex-direction: column;
            align-items: flex-end; gap: 6px; font: 600 13px/1.3 "Pretendard Variable", Pretendard, system-ui, sans-serif; }
    button { border: 1px solid rgba(0,0,0,.08); border-radius: 9999px; padding: 8px 12px; cursor: pointer; color: #fff;
             background: #1d4ed8; box-shadow: 0 4px 12px rgba(0,0,0,.15); font: inherit; opacity: .94; }
    button.sel { background: #fff; color: #1d4ed8; border-color: #1d4ed8; }
    button.alt { background: #fff; color: #1d4ed8; border-color: #1d4ed8; }
    button:disabled { opacity: .45; cursor: default; }
    .toast { max-width: 280px; padding: 8px 12px; border-radius: 10px; color: #fff; font-weight: 500;
             box-shadow: 0 4px 12px rgba(0,0,0,.15); display: none; }
    .toast.ok { background: #0f766e; } .toast.error { background: #b91c1c; } .toast.show { display: block; }
  </style>
  <div class="wrap">
    <div class="toast" role="status"></div>
    <button type="button" class="alt record">팀 기록 불러오기</button>
    <button type="button" class="alt sync">싱크 맞추기</button>
    <button type="button" class="sel" disabled>선택한 내용 보내기</button>
    <button type="button" class="all">싱크업에 보내기</button>
  </div>`;

export interface ChatOverlay {
  host: HTMLElement; // 페이지에 붙일 뿌리 요소. 이 안의 화면 변화는 자동 수집이 무시한다
  sendAllButton: HTMLButtonElement;
  sendSelectionButton: HTMLButtonElement;
  syncButton: HTMLButtonElement; // 싱크 맞추기: 클릭 처리는 createChatOverlay 가 이미 연결한다
  recordButton: HTMLButtonElement; // 팀 기록 불러오기: 클릭 처리는 createChatOverlay 가 이미 연결한다
  showToast(text: string, tone: TabToast['tone']): void;
}

export interface OverlayActions {
  /** 팀 보드 카드·충돌을 받아 오는 함수. 백그라운드 연결은 ai-chat.content.ts 에서 넘긴다. 없으면 '팀 기록 불러오기'는 연결 전이라고만 안내한다 */
  fetchTeamRecord?: TeamRecordSource;
}

const NO_RECORD_SOURCE_GUIDE = '팀 기록을 받아 올 연결이 아직 없어요';

/** '싱크 맞추기' 결과(SyncNowResult)를 화면 안내로. 패스 결과와 분류 시작 여부를 한 줄에 담는다 */
export function syncNowToast(result: SyncNowResult): { text: string; tone: TabToast['tone'] } {
  const pass: Record<SyncNowResult['sync'], string> = {
    ran: result.newTurns > 0 ? `새 대화 ${result.newTurns}턴을 가져왔어요` : '새로 가져올 대화가 없어요',
    off: '프로젝트 동기화가 꺼져 있어요',
    resting: 'ChatGPT 요청 제한으로 쉬는 중이에요. 잠시 뒤에 다시 눌러 주세요',
    'no-tab': 'chatgpt.com 탭을 하나 열어 두세요',
    busy: '이미 동기화하는 중이에요',
    failed: '동기화하지 못했어요. 팝업에서 상태를 확인해 주세요',
  };
  const classify = result.flushed ? '분류를 시작했어요' : result.blockedReason;
  const failed = result.sync === 'failed' || result.sync === 'no-tab' || result.sync === 'resting';
  return { text: [pass[result.sync], classify].filter(Boolean).join(' · '), tone: failed || !!result.blockedReason ? 'error' : 'ok' };
}

export function createChatOverlay(actions: OverlayActions = {}): ChatOverlay {
  const host = document.createElement('div');
  host.id = 'syncup-root';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = TEMPLATE;
  const toast = shadow.querySelector<HTMLDivElement>('.toast')!;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const overlay: ChatOverlay = {
    host,
    sendAllButton: shadow.querySelector<HTMLButtonElement>('button.all')!,
    sendSelectionButton: shadow.querySelector<HTMLButtonElement>('button.sel')!,
    syncButton: shadow.querySelector<HTMLButtonElement>('button.sync')!,
    recordButton: shadow.querySelector<HTMLButtonElement>('button.record')!,
    showToast(text, tone) {
      toast.textContent = text;
      toast.className = `toast show ${tone}`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (toast.className = 'toast'), tone === 'error' ? 6000 : 3000);
    },
  };
  wireSyncButton(overlay);
  wireRecordButton(overlay, actions.fetchTeamRecord);
  return overlay;
}

// 싱크 맞추기: 백그라운드가 프로젝트 동기화 패스를 바로 돌리고(켜져 있을 때) 수집 중이면 분류까지 시작한다
function wireSyncButton({ syncButton, showToast }: ChatOverlay) {
  syncButton.addEventListener('click', async () => {
    syncButton.disabled = true;
    showToast('동기화하는 중이에요…', 'ok');
    try {
      const response = await sendToBackground<BgResponse | undefined>({ type: 'syncNow', params: { reason: 'button' } });
      if (!response) return showToast(EXTENSION_UPDATED_GUIDE, 'error');
      if (!response.ok) return showToast(response.error, 'error');
      const result = response.result as SyncNowResult | undefined;
      if (typeof result?.sync !== 'string') return showToast('동기화 결과를 읽지 못했어요', 'error');
      const toast = syncNowToast(result);
      showToast(toast.text, toast.tone);
    } catch {
      // 확장을 새로 고친 뒤 이전 콘텐츠 스크립트가 남아 있는 경우
      showToast(EXTENSION_UPDATED_GUIDE, 'error');
    } finally {
      syncButton.disabled = false;
    }
  });
}

// 팀 기록 불러오기: 팀 보드를 마크다운으로 입력창에 채운다(전송은 사용자). 입력창을 못 채우면 클립보드에 복사한다
function wireRecordButton({ recordButton, showToast }: ChatOverlay, fetchTeamRecord: TeamRecordSource | undefined) {
  recordButton.addEventListener('click', async () => {
    if (!fetchTeamRecord) return showToast(NO_RECORD_SOURCE_GUIDE, 'error');
    recordButton.disabled = true;
    try {
      const record = await loadTeamRecord(fetchTeamRecord);
      if (!record.ok) return showToast(record.error, 'error');
      const delivered = await deliverTeamRecord(record.markdown);
      if (delivered === 'filled') showToast(`팀 기록 ${record.cardCount}개를 입력창에 채웠어요. 질문을 덧붙여 직접 보내세요`, 'ok');
      else if (delivered === 'copied') showToast('입력창에 바로 넣지 못해 클립보드에 복사했어요. 입력창에 붙여넣어 주세요', 'ok');
      else showToast('입력창에도 클립보드에도 넣지 못했어요. 브라우저 권한을 확인해 주세요', 'error');
    } finally {
      recordButton.disabled = false;
    }
  });
}
