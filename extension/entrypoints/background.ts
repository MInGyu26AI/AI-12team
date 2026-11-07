// 서비스 워커: 수집한 메시지 → 분류 → 개인 버림·민감정보 가림 → 검토 대기 저장 → 아이콘 배지
import type { RelatedCard } from '@shared/types';
import { classifyWithFallback } from '@/lib/classifier';
import type { BgRequest, CollectResult } from '@/lib/messages';
import {
  MAX_REMEMBERED_IDS,
  collectStateItem,
  isConfigured,
  pendingItem,
  settingsItem,
} from '@/lib/settings';

// storage 읽고-쓰기가 겹치지 않도록 한 줄로 세움
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(job: () => Promise<T>): Promise<T> => {
  const next = queue.then(job, job);
  queue = next.catch(() => {});
  return next;
};

async function collect(req: Extract<BgRequest, { type: 'collect' }>): Promise<CollectResult> {
  const settings = await settingsItem.getValue();
  if (!isConfigured(settings)) return { ok: false, error: '설정 안 됨: 팝업에서 팀 정보를 먼저 입력해 주세요' };
  if (req.trigger === 'auto' && !settings.autoCollect) return { ok: true, newMessages: 0, newCards: 0 };

  const state = await collectStateItem.getValue();
  const seen = new Set(state.collectedIds);
  const fresh = req.messages.filter((m) => !seen.has(m.id));
  if (!fresh.length) return { ok: true, newMessages: 0, newCards: 0 };

  const pending = await pendingItem.getValue();
  const topicKeys = [...new Set(pending.map((c) => c.topic_key).filter((k): k is string => !!k))];

  try {
    const { cards, used, nativeError } = await classifyWithFallback(fresh, settings, topicKeys);
    if (nativeError) console.info('[싱크업] 로컬 수집기 연결 실패 → 목업 분류 사용:', nativeError);

    // 개인(personal)은 여기서 버린다. 분류기가 민감정보를 이미 가렸으므로 원문은 남지 않는다.
    const related = cards.filter((c): c is RelatedCard => c.relevance === 'related');
    await pendingItem.setValue([...pending, ...related]);
    await collectStateItem.setValue({
      collectedIds: [...state.collectedIds, ...fresh.map((m) => m.id)].slice(-MAX_REMEMBERED_IDS),
      collectedCount: state.collectedCount + fresh.length,
      lastCollectedAt: new Date().toISOString(),
      lastClassifier: used,
      lastError: null,
    });
    return { ok: true, newMessages: fresh.length, newCards: related.length };
  } catch (e) {
    const error = `분류 실패: ${(e as Error).message}`;
    await collectStateItem.setValue({ ...state, lastError: error });
    return { ok: false, error };
  }
}

async function removePending(ids: string[]) {
  const drop = new Set(ids);
  await pendingItem.setValue((await pendingItem.getValue()).filter((c) => !drop.has(c.id)));
}

const updateBadge = (count: number) => {
  browser.action.setBadgeText({ text: count ? String(count) : '' });
  browser.action.setBadgeBackgroundColor({ color: '#1d4ed8' });
};

export default defineBackground(() => {
  pendingItem.getValue().then((p) => updateBadge(p.length));
  pendingItem.watch((p) => updateBadge(p.length));

  browser.runtime.onMessage.addListener((msg: BgRequest) => {
    if (msg.type === 'collect') return serial(() => collect(msg));
    if (msg.type === 'removePending') return serial(() => removePending(msg.ids)).then(() => ({ ok: true }));
  });
});
