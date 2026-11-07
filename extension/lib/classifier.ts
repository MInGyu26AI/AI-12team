// 분류기 연결부. nativeCollector(김동균 님 Mac 로컬 수집기) → 실패하면 mockClassify 로 자동 대체.
import { mockClassify } from '@shared/classify';
import {
  NATIVE_HOST,
  NATIVE_PROTOCOL_VERSION,
  type CollectedMessage,
  type NativeClassifyRequest,
  type NativeClassifyResponse,
} from '@shared/collector';
import { DEMO_KNOWN_NAMES } from '@shared/mock';
import type { Card, ClassificationOutput } from '@shared/types';
import type { Settings } from './settings';

export interface Classifier {
  name: 'native' | 'mock';
  classify(messages: CollectedMessage[], settings: Settings, existingTopicKeys: string[]): Promise<Card[]>;
}

// "ChatGPT, 2026-11-07 21:10" (docs/classification.md source 형식)
const sourceOf = (m: CollectedMessage) => {
  const d = new Date(m.collectedAt);
  const p = (n: number) => String(n).padStart(2, '0');
  const label = m.site === 'chatgpt' ? 'ChatGPT' : m.site;
  return `${label}, ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

let seq = 0;
const withAppFields = (o: ClassificationOutput): Card => ({ ...o, id: `x${Date.now().toString(36)}${(seq++).toString(36)}`, status: 'candidate' });

export const nativeClassifier: Classifier = {
  name: 'native',
  async classify(messages, s, existingTopicKeys) {
    const req: NativeClassifyRequest = {
      type: 'classify',
      version: NATIVE_PROTOCOL_VERSION,
      context: {
        teamName: s.teamName,
        projectTopic: s.projectTopic,
        userName: s.userName,
        enabledSubtopics: s.enabledSubtopics,
        existingTopicKeys,
      },
      messages,
    };
    const res = (await browser.runtime.sendNativeMessage(NATIVE_HOST, req)) as NativeClassifyResponse | undefined;
    if (!res || !res.ok) throw new Error(res?.error ?? '로컬 수집기 응답 없음');
    return res.cards.map(withAppFields);
  },
};

export const mockClassifier: Classifier = {
  name: 'mock',
  async classify(messages, s, existingTopicKeys) {
    return mockClassify(
      messages.map((m) => ({ speaker: m.role === 'user' ? 'user' : 'ai', text: m.text, source: sourceOf(m) })),
      {
        userName: s.userName,
        knownNames: [...new Set([s.userName, ...DEMO_KNOWN_NAMES])],
        existingTopicKeys,
        enabledSubtopics: s.enabledSubtopics,
      },
    );
  },
};

/** 로컬 수집기를 먼저 시도하고, 연결 실패(미설치 등)면 목업으로 */
export async function classifyWithFallback(
  messages: CollectedMessage[],
  settings: Settings,
  existingTopicKeys: string[],
): Promise<{ cards: Card[]; used: Classifier['name']; nativeError?: string }> {
  try {
    return { cards: await nativeClassifier.classify(messages, settings, existingTopicKeys), used: 'native' };
  } catch (e) {
    const cards = await mockClassifier.classify(messages, settings, existingTopicKeys);
    return { cards, used: 'mock', nativeError: (e as Error).message };
  }
}
