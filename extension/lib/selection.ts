// "선택한 내용 보내기" (플로팅 버튼 · 우클릭 메뉴 공용): 드래그한 텍스트 → 수집 메시지 한 건
import type { CollectedMessage } from '@shared/collector';
import { hash } from './hash';
import type { SiteAdapter } from './sites';

export function selectionMessage(site: SiteAdapter, text: string, url: string, title: string): CollectedMessage | null {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean.length < 2) return null;
  // 자동 수집과 같은 대화 id 를 써야 수집기가 같은 대화로 묶는다
  const conversationId = site.conversationIdOf(url);
  return {
    id: `selection:${conversationId}:${hash(clean)}`,
    site: site.id,
    role: 'user', // 내가 골라서 보낸 내용이므로 사용자 발화로 간주
    roleGuessed: true,
    text: clean,
    conversationId,
    conversationTitle: site.titleOf(title),
    url,
    collectedAt: new Date().toISOString(),
  };
}
