// 확장 내부(콘텐츠 스크립트 · 팝업 · 백그라운드) runtime 메시지
import type { ExtSettingsPatch, SyncNowParams, SyncWindow } from '@shared/bridge';
import type { CollectedMessage } from '@shared/collector';

export type BgRequest =
  | { type: 'syncNow'; params: SyncNowParams } // 팝업·채팅 화면의 '싱크 맞추기'. 결과는 BgResponse.result = SyncNowResult
  | { type: 'syncSet'; enabled: boolean; project?: SyncProject } // 팝업 '프로젝트만 수집' 스위치. 켤 때 project 필수
  | { type: 'syncProjects' } // 팝업 프로젝트 고르기. result = SyncProject[] (대표 탭의 sync.projects). 실패 문구는 syncSet 표와 같다
  | { type: 'teamRecord' } // 채팅 화면 '팀 기록 불러오기'. result = TeamRecordRaw
  | { type: 'collect'; trigger: 'auto' | 'manual' | 'selection'; messages: CollectedMessage[] }
  | { type: 'flush' } // 지금 쌓인 대화까지 분류 (팝업 "지금 분류하기")
  | { type: 'updateSettings'; patch: ExtSettingsPatch } // 로컬 수집기 collection.configure 로 그대로 보낸다
  | { type: 'refresh' } // 로컬 수집기 상태 다시 읽기 (팝업을 열 때)
  | { type: 'rpc'; method: string; params?: unknown }; // 개인 검토함 웹 → 로컬 수집기 (web-bridge 가 중계)

export type BgResponse = { ok: true; result?: unknown } | { ok: false; error: string };

// 'teamRecord' 결과: 수집기 team.board·team.conflicts 응답 그대로 (웹 보드와 같은 중계). 카드·충돌로 바꾸는 일은 team-record.ts
export interface TeamRecordRaw {
  board: unknown;
  conflicts: unknown;
}

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

// ── 계정 동기화: 백그라운드 → chatgpt.com 콘텐츠 스크립트 (docs/sync-contract.md 4장) ──
// 콘텐츠 스크립트는 sendResponse 로 답한다(Chrome 148 미만 호환). 백그라운드는 요청마다 20초 시간 제한을 둔다.
// 원본 JSON 은 탭 밖으로 내보내지 않는다. 제목도 돌려주지 않는다.
export interface SyncProject {
  gizmoId: string; // ChatGPT 프로젝트 id (g-p-…)
  name: string; // 팝업 표시용. 수집기로 보내지 않는다
}

export interface SyncConversationRef {
  id: string;
  updateTime: string; // ISO (목록의 update_time 을 그대로 또는 초 → ISO)
  isArchived: boolean;
  isTemporary: boolean; // 목록의 is_temporary_chat (없으면 false). 참이면 패스가 뺀다
  gizmoId: string | null;
}

export type TabSyncRequest =
  | { type: 'sync.session' } // 로그인 상태와 계정 해시만 확인
  | { type: 'sync.projects' } // /backend-api/gizmos/snorlax/sidebar → 프로젝트 목록
  | { type: 'sync.projectPage'; gizmoId: string; cursor: string | null } // /backend-api/gizmos/{gizmo}/conversations?cursor=
  | { type: 'sync.conversation'; id: string; windows: SyncWindow[] }; // 상세 → 창 안의 완료된 턴

// 탭이 돌려주는 오류 분류. 백그라운드 스케줄러가 이것으로 쉼·멈춤을 정한다
export type TabSyncError =
  | 'logged_out' // 세션 응답에 토큰이 없음 → 멈춤
  | 'rate_limited' // 429 → 쉼 (retryAfterSec 있으면 따름)
  | 'forbidden' // 403·봇 확인 화면 → 2시간 쉼
  | 'not_found' // 404 (지운 대화) → 그 대화만 건너뜀
  | 'shape_changed' // 응답 모양이 기대와 다름 → 고장 표시, 멈춤
  | 'network'; // fetch 실패·5xx → 일시 오류, 다음 주기에 다시

export type TabSyncResult<T> =
  | { ok: true; account: string; data: T } // account = 사용자 식별자의 sha256 hex (응답마다)
  | { ok: false; error: TabSyncError; retryAfterSec?: number; account?: string };

export interface SyncProjectPage {
  items: SyncConversationRef[]; // update_time 최신 순
  nextCursor: string | null;
}

export interface SyncConversationData {
  messages: CollectedMessage[]; // origin='sync', createdAt·turnId 채움, id 는 'chatgpt:<message.id>'
  inProgress: boolean; // 마지막 답변이 생성 중(또는 보이는 답 없음)이라 그 턴을 뺐음 → 커서를 올리지 않는다
  inProgressAt: string | null; // 그 미완료 턴의 가장 늦은 메시지 시각 (ISO). 10분보다 오래되면 패스는 커서를 붙잡지 않는다
  skippedNoTime: number; // create_time 이 없어 뺀 턴 수
}

export type TabSyncResponse =
  | TabSyncResult<null> // sync.session
  | TabSyncResult<SyncProject[]> // sync.projects
  | TabSyncResult<SyncProjectPage> // sync.projectPage
  | TabSyncResult<SyncConversationData>; // sync.conversation

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
