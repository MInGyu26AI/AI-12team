// 로컬 수집기(동균님 Mac Native Messaging host) 연결부.
// 화면/백그라운드는 Collector 인터페이스만 쓰고, 목업 ↔ 실제는 createCollector()에서 교체.
import type { Card, Speaker } from '@shared/types';
import { mockCards } from '@shared/mock';

export interface Utterance {
  site: 'chatgpt-web';
  conversationId: string;
  messageId: string;
  speaker: Speaker;
  text: string;
  completedAt: string;
}

export interface Collector {
  sendUtterances(items: Utterance[]): Promise<void>;
  getCandidates(): Promise<Card[]>;
}

// TODO(동균님과 확정): host 이름과 메시지 형식
const NATIVE_HOST = 'com.syncup.collector';

function nativeCollector(): Collector {
  const call = <T>(message: object) =>
    browser.runtime.sendNativeMessage(NATIVE_HOST, message) as Promise<T>;
  return {
    sendUtterances: (items) => call({ type: 'utterances', items }),
    getCandidates: () => call<Card[]>({ type: 'candidates' }),
  };
}

function mockCollector(): Collector {
  const received: Utterance[] = [];
  return {
    async sendUtterances(items) {
      received.push(...items);
      console.log('[mock collector] 받은 발화', received.length, items);
    },
    async getCandidates() {
      return mockCards.filter((c) => c.status === 'candidate');
    },
  };
}

export function createCollector(): Collector {
  return import.meta.env.WXT_USE_NATIVE === 'true' ? nativeCollector() : mockCollector();
}
