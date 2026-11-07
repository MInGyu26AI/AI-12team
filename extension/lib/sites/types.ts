// 사이트별 대화 추출 공통 인터페이스. claude.ai 등은 이 모양으로 파일 하나만 추가하면 된다.
import type { CollectedMessage } from '@shared/collector';

export interface ExtractResult {
  messages: CollectedMessage[];
  selector: string | null; // 성공한 전략 이름 (없으면 못 읽음)
  tried: { name: string; count: number }[]; // 시도한 전략별로 잡힌 요소 수 (진단용)
  guessedRoles: number; // 화자를 순서로 추정한 메시지 수
}

export interface SiteAdapter {
  id: CollectedMessage['site'];
  label: string; // 출처 표시용, 예: "ChatGPT"
  hosts: string[]; // location.hostname 비교용
  isConversationPage(): boolean;
  /** 지금 화면에 보이는 메시지. 답변 생성 중인 마지막 AI 메시지는 빼고 돌려준다 */
  extract(): ExtractResult;
}
