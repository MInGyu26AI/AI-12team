import { watchChatGPT } from '@/lib/extractors/chatgpt';

export default defineContentScript({
  matches: ['https://chatgpt.com/*'],
  main() {
    // 수집 여부·종료 시각 판단은 background 가 한 번 더 확인
    watchChatGPT((utterance) => {
      browser.runtime.sendMessage({ type: 'utterance', utterance }).catch(() => {});
    });
  },
});
