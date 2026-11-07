// 사이트별 대화 추출 공통 인터페이스. claude.ai 등은 이 모양으로 파일 하나만 추가하면 된다.
import type { CollectedMessage } from '@shared/collector';

export interface SiteAdapter {
  id: CollectedMessage['site'];
  label: string; // 출처 표시용, 예: "ChatGPT"
  hosts: string[]; // location.hostname 비교용
  isConversationPage(): boolean;
  /** 지금 화면에 보이는 메시지. 답변 생성 중인 마지막 AI 메시지는 빼고 돌려준다 */
  extract(): { messages: CollectedMessage[]; selector: string | null };
}
