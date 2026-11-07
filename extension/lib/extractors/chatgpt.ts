// ChatGPT 화면 전용 발화 추출. ChatGPT DOM이 바뀌면 이 파일만 고친다.
import type { Utterance } from '../collector';

const MESSAGE = '[data-message-author-role][data-message-id]';
const STREAMING = '[data-testid="stop-button"]'; // 답변 생성 중에만 보이는 버튼

export function watchChatGPT(onCompleted: (u: Utterance) => void): () => void {
  const seen = new Set<string>();

  const scan = () => {
    if (document.querySelector(STREAMING)) return; // 아직 생성 중 → 완료 후 다시 스캔
    const conversationId = location.pathname.split('/c/')[1] ?? 'new';
    document.querySelectorAll<HTMLElement>(MESSAGE).forEach((el) => {
      const messageId = el.dataset.messageId!;
      const text = el.innerText.trim();
      if (seen.has(messageId) || !text) return;
      seen.add(messageId);
      onCompleted({
        site: 'chatgpt-web',
        conversationId,
        messageId,
        speaker: el.dataset.messageAuthorRole === 'user' ? 'user' : 'ai',
        text,
        completedAt: new Date().toISOString(),
      });
    });
  };

  // 페이지에 이미 있던 이전 대화는 수집 대상이 아님(설정 기간 중 "새로" 완료된 발화만)
  document.querySelectorAll<HTMLElement>(MESSAGE).forEach((el) => seen.add(el.dataset.messageId!));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(scan, 800);
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}
