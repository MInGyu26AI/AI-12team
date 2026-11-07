// 서비스 워커: 수집한 발화 → (10턴 묶기) → 분류 → 개인 버림·민감정보 가림 → 검토 대기 저장 → 아이콘 배지
// 묶기 규칙은 ai/syncup_ai/batch.py (= shared/batch.ts) 와 같다:
//   질문 + 이어지는 AI 답변 = 1턴, N턴(기본 10)이 차면 분류. 일시중지·종료 시각·수동 보내기 때는 남은 것까지.
import { countTurns, takeReadyBatches } from '@shared/batch';
import type { BatchRecord, ExtSettingsPatch } from '@shared/bridge';
import type { CollectedMessage } from '@shared/collector';
import { isShareable } from '@shared/labels';
import type { RelatedCard } from '@shared/types';
import { classifyWithFallback } from '@/lib/classifier';
import type { BgRequest, CollectResult, TabToast } from '@/lib/messages';
import { selectionMessage } from '@/lib/selection';
import {
  MAX_RECENT,
  MAX_REMEMBERED_IDS,
  bufferItem,
  collectStateItem,
  endsAtOf,
  isConfigured,
  isEnded,
  pendingItem,
  recentItem,
  settingsItem,
  turnsOf,
} from '@/lib/settings';

// storage 읽고-쓰기가 겹치지 않도록 한 줄로 세움
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(job: () => Promise<T>): Promise<T> => {
  const next = queue.then(job, job);
  queue = next.catch(() => {});
  return next;
};

const END_ALARM = 'syncup-collect-end';

/** 한 묶음 분류 → 검토 대기에 추가 → 최근 수집 기록. 새 카드 수를 돌려준다 */
async function classifyBatch(messages: CollectedMessage[], trigger: BatchRecord['trigger']): Promise<number> {
  const settings = await settingsItem.getValue();
  const pending = await pendingItem.getValue();
  const topicKeys = [...new Set(pending.map((c) => c.topic_key).filter((k): k is string => !!k))];

  const { cards, used, nativeError } = await classifyWithFallback(messages, settings, topicKeys);
  if (nativeError) console.info('[싱크업] 로컬 수집기 연결 실패 → 목업 분류 사용:', nativeError);

  // 개인(personal)은 여기서 버린다. 분류기가 민감정보를 이미 가렸으므로 원문은 남지 않는다.
  const related = cards.filter((c): c is RelatedCard => c.relevance === 'related');
  await pendingItem.setValue([...pending, ...related]);

  const record: BatchRecord = {
    id: `b${Date.now().toString(36)}`,
    at: new Date().toISOString(),
    site: 'ChatGPT',
    turns: countTurns(messages),
    cardIds: related.filter(isShareable).map((c) => c.id),
    personal: cards.length - related.length,
    trigger,
  };
  await recentItem.setValue([record, ...(await recentItem.getValue())].slice(0, MAX_RECENT));

  const state = await collectStateItem.getValue();
  await collectStateItem.setValue({ ...state, lastCollectedAt: record.at, lastClassifier: used, lastError: null });
  return related.filter(isShareable).length;
}

/** 버퍼에서 꽉 찬 묶음(또는 flush 면 전부)을 분류에 보낸다 */
async function drain(flush: boolean, trigger: BatchRecord['trigger']): Promise<number> {
  const settings = await settingsItem.getValue();
  const { batches, leftover } = takeReadyBatches(await bufferItem.getValue(), turnsOf(settings), flush);
  await bufferItem.setValue(leftover);
  let newCards = 0;
  for (const b of batches) newCards += await classifyBatch(b, trigger);
  return newCards;
}

async function collect(req: Extract<BgRequest, { type: 'collect' }>): Promise<CollectResult> {
  const settings = await settingsItem.getValue();
  if (!isConfigured(settings)) return { ok: false, error: '설정 안 됨: 팝업에서 팀 정보를 먼저 입력해 주세요' };
  if (req.trigger === 'auto' && (!settings.autoCollect || isEnded(settings))) {
    return { ok: true, newMessages: 0, newCards: 0 }; // 일시중지 중이거나 종료 시각이 지남 → 새 발화 수집 안 함
  }

  const state = await collectStateItem.getValue();
  const seen = new Set(state.collectedIds);
  const fresh = req.messages.filter((m) => !seen.has(m.id));
  await collectStateItem.setValue({
    ...state,
    collectedIds: [...state.collectedIds, ...fresh.map((m) => m.id)].slice(-MAX_REMEMBERED_IDS),
    collectedCount: state.collectedCount + fresh.length,
  });

  try {
    let newCards = 0;
    if (req.trigger === 'selection') {
      // 드래그한 내용은 묶지 않고 바로 분류
      if (fresh.length) newCards = await classifyBatch(fresh, 'selection');
    } else {
      await bufferItem.setValue([...(await bufferItem.getValue()), ...fresh]);
      // 자동: 꽉 찬 묶음만 / 수동 보내기: 남은 것까지
      newCards = await drain(req.trigger === 'manual', req.trigger === 'manual' ? 'manual' : 'auto');
    }
    const buffered = countTurns(await bufferItem.getValue());
    return { ok: true, newMessages: fresh.length, newCards, bufferedTurns: buffered, turnsPerBatch: turnsOf(settings) };
  } catch (e) {
    const error = `분류 실패: ${(e as Error).message}`;
    await collectStateItem.setValue({ ...(await collectStateItem.getValue()), lastError: error });
    return { ok: false, error };
  }
}

async function removePending(ids: string[]) {
  const drop = new Set(ids);
  await pendingItem.setValue((await pendingItem.getValue()).filter((c) => !drop.has(c.id)));
}

/** 웹(대화 수집·팀 만들기 화면)이나 팝업에서 바꾼 설정 반영 */
async function updateSettings(patch: ExtSettingsPatch) {
  const s = await settingsItem.getValue();
  const next = { ...s };
  if (patch.teamName !== undefined) next.teamName = patch.teamName.trim();
  if (patch.projectTopic !== undefined) next.projectTopic = patch.projectTopic.trim();
  if (patch.userName !== undefined) next.userName = patch.userName.trim();
  if (patch.autoCollect !== undefined) next.autoCollect = patch.autoCollect;
  if (patch.turnsPerBatch !== undefined) next.turnsPerBatch = patch.turnsPerBatch;
  if (patch.endsAt !== undefined) next.endsAt = patch.endsAt;
  await settingsItem.setValue(next);
}

// 종료 시각 알람: 설정이 바뀔 때마다 다시 건다
async function scheduleEnd() {
  const s = await settingsItem.getValue();
  await browser.alarms.clear(END_ALARM);
  const end = endsAtOf(s);
  if (end && s.autoCollect && end.getTime() > Date.now()) browser.alarms.create(END_ALARM, { when: end.getTime() });
}

// 종료 시각: 남은 대화까지 분류에 보내고 자동 수집을 끈다 (CLAUDE.md §9)
async function endCollection() {
  await drain(true, 'flush');
  const s = await settingsItem.getValue();
  if (s.autoCollect) await settingsItem.setValue({ ...s, autoCollect: false });
}

const updateBadge = (cards: RelatedCard[]) => {
  const count = cards.filter(isShareable).length; // '해당 없음(제안·요청)'은 세지 않음
  browser.action.setBadgeText({ text: count ? String(count) : '' });
  browser.action.setBadgeBackgroundColor({ color: '#4f46e5' });
};

// ── 우클릭 메뉴 "싱크업에 선택한 내용 보내기" (자동 추출이 안 될 때 시연용 안전장치) ──
const MENU_ID = 'syncup-send-selection';
const CHAT_PAGES = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];

const toastTab = (tabId: number | undefined, toast: Omit<TabToast, 'type'>) => {
  if (tabId !== undefined) browser.tabs.sendMessage(tabId, { type: 'toast', ...toast } satisfies TabToast).catch(() => {});
};

async function sendSelection(info: Browser.contextMenus.OnClickData, tab?: Browser.tabs.Tab) {
  const msg = selectionMessage(info.selectionText ?? '', tab?.url ?? info.pageUrl ?? '', tab?.title ?? '');
  if (!msg) return toastTab(tab?.id, { text: '보낼 텍스트를 먼저 드래그해서 선택해 주세요', tone: 'error' });
  const res = await serial(() => collect({ type: 'collect', trigger: 'selection', messages: [msg] }));
  toastTab(
    tab?.id,
    res.ok
      ? { text: res.newMessages ? `보냈어요 · 검토 후보 ${res.newCards}장` : '이미 보낸 내용이에요', tone: 'ok' }
      : { text: res.error, tone: 'error' },
  );
}

export default defineBackground(() => {
  pendingItem.getValue().then(updateBadge);
  pendingItem.watch(updateBadge);

  // 일시중지로 바뀌면 남은 대화를 보낸다 / 종료 시각 알람 다시 걸기
  settingsItem.watch((next, prev) => {
    if (prev?.autoCollect && !next.autoCollect) void serial(() => drain(true, 'flush'));
    void scheduleEnd();
  });
  void scheduleEnd();
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === END_ALARM) void serial(endCollection);
  });

  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.create({
      id: MENU_ID,
      title: '싱크업에 선택한 내용 보내기',
      contexts: ['selection'],
      documentUrlPatterns: CHAT_PAGES,
    });
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === MENU_ID) void sendSelection(info, tab);
  });

  browser.runtime.onMessage.addListener((msg: BgRequest) => {
    if (msg.type === 'collect') return serial(() => collect(msg));
    if (msg.type === 'flush') return serial(() => drain(true, 'flush')).then((newCards) => ({ ok: true, newCards }));
    if (msg.type === 'removePending') return serial(() => removePending(msg.ids)).then(() => ({ ok: true }));
    if (msg.type === 'updateSettings') return serial(() => updateSettings(msg.patch)).then(() => ({ ok: true }));
  });
});
