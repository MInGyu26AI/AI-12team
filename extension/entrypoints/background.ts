import { createCollector, type Utterance } from '@/lib/collector';
import { isCollectingNow, settings } from '@/lib/settings';

export default defineBackground(() => {
  const collector = createCollector();

  browser.runtime.onMessage.addListener((msg: { type: string; utterance?: Utterance }) => {
    if (msg.type === 'utterance' && msg.utterance) {
      return (async () => {
        const s = await settings.getValue();
        if (!isCollectingNow(s, 'chatgpt.com')) return; // 일시중지·종료 시각 이후엔 버림
        await collector.sendUtterances([msg.utterance!]);
      })();
    }
    if (msg.type === 'getCandidates') return collector.getCandidates();
  });
});
