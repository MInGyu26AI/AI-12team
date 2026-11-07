// "선택한 내용 보내기" (플로팅 버튼 · 우클릭 메뉴 공용): 드래그한 텍스트 → 수집 메시지 한 건
import type { CollectedMessage } from '@shared/collector';
import { hash } from './hash';

export function selectionMessage(text: string, url: string, title: string): CollectedMessage | null {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length < 2) return null;
  const conversationId = url.match(/\/c\/([\w-]+)/)?.[1] ?? 'selection';
  return {
    id: `selection:${conversationId}:${hash(clean)}`,
    site: 'chatgpt',
    role: 'user', // 내가 골라서 보낸 내용이므로 사용자 발화로 간주
    roleGuessed: true,
    text: clean,
    conversationId,
    conversationTitle: title.replace(/\s*[-|]\s*ChatGPT$/, '') || '(제목 없음)',
    url,
    collectedAt: new Date().toISOString(),
  };
}
