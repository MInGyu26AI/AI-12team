// 자동 수집: "새로" 완료된 메시지만 보낸다. 대화를 열 때 이미 있던 메시지는 기준선으로 보고 보내지 않는다.
import type { ContentScriptContext } from '#imports';
import type { CollectedMessage } from '@shared/collector';
import type { CollectResult } from './messages';
import type { SiteAdapter } from './sites';
import type { ExtractResult } from './sites/types';

const COLLECT_DEBOUNCE_MS = 2000;
const CHECK_INTERVAL_MS = 1000;
const STOP_WAIT_MS = 60_000;
const NEW_CHAT_FOLLOW_MS = 500;
const ERROR_TOAST_EVERY_MS = 30_000;

interface AutoCollectOptions {
  site: SiteAdapter;
  overlay: HTMLElement; // 우리 버튼·안내. 이 안의 화면 변화는 무시한다
  isActive: () => boolean; // 자동 수집이 켜져 있고 설정이 끝났는지. 꺼져 있는 동안 보인 메시지는 기준선에 넣는다
  send: (messages: CollectedMessage[]) => Promise<CollectResult>;
  showError: (text: string) => void;
}

// 수집기가 꺼져 있으면 화면이 바뀔 때마다 다시 보내 보되(보내지 못한 메시지를 잃지 않게) 같은 오류 안내는 30초에 한 번만 띄운다.
// 다른 오류는 바로 띄우고, 전송이 성공하면(reset) 다시 처음부터 센다.
function limitErrorToasts(showError: (text: string) => void) {
  let lastText = '';
  let lastShownAt = 0;
  return {
    show(text: string) {
      if (text === lastText && Date.now() - lastShownAt < ERROR_TOAST_EVERY_MS) return;
      lastText = text;
      lastShownAt = Date.now();
      showError(text);
    },
    reset: () => (lastText = ''),
  };
}

/** 화면 변화를 지켜보며 새 메시지를 보낸다. markSeen: 지금(또는 주어진) 메시지를 기준선에 넣어 자동으로 보내지 않게 한다 */
export function startAutoCollect(ctx: ContentScriptContext, { site, overlay, isActive, send, showError }: AutoCollectOptions) {
  const baseline = new Set<string>();
  const excludedUsers = new Set<string>();
  const pending = new Map<string, CollectedMessage>();
  let invalidated = false;
  let inFlight: Promise<void> | null = null;
  let lastFailure: string | null = null;
  let retryAt = 0;
  type StopResult = { ok: true } | { ok: false; error: string };
  let stopping: { path: string; ids: Set<string>; replyTo?: string; awaiting: boolean;
    deadline: number; resolve: (result: StopResult) => void; promise: Promise<StopResult>; settled: boolean } | null = null;
  const metadata = (result: ExtractResult) => result.capture?.observed ?? result.messages.map(({ id, role }) => ({ id, role, replyTo: undefined }));
  const markBoundary = (result = site.extract()) => {
    for (const message of metadata(result)) {
      if (!pending.has(message.id)) baseline.add(message.id);
      if (message.role === 'user') excludedUsers.add(message.id);
    }
  };
  let baselinePath: string | null = null;
  // 새 채팅 화면(주소에 대화 id 가 아직 없음)에서 기준선 뒤에 나타난 메시지: 첫 글과 개수. ChatGPT 는 첫 질문을 보내면 주소를
  // /c/<id> 로 바꾼다. 바뀐 주소의 대화가 이 글로 시작하고, 메시지가 그 개수에서 0.5초에 하나씩만 늘어 왔을 때만 같은 대화로
  // 이어 본다. 홈에서 연 지난 대화는 다른 글로 시작하거나 메시지가 짧은 사이에 여러 개 나타난다
  let newChat: { first: string; count: number } | null = null;
  let followedAt = 0; // 새 채팅의 메시지 개수를 마지막으로 읽은 때
  const errorToast = limitErrorToasts(showError);
  const markSeen = (messages?: CollectedMessage[]) => {
    if (!messages) return markBoundary();
    messages.forEach((m) => { baseline.add(m.id); pending.delete(m.id); });
  };
  const rememberNewChat = () => {
    const fresh = site.extract().messages.filter((m) => !baseline.has(m.id));
    const [first] = fresh;
    followedAt = Date.now();
    if (!first) return;
    // 기억한 첫 글이 화면에서 사라졌으면(보내기 실패 뒤 다시 쓴 새 채팅 등) 지금 보이는 첫 글로 바꾼다
    const remembered = newChat?.first;
    const kept = remembered !== undefined && fresh.some((m) => m.text === remembered) ? remembered : first.text;
    newChat = { first: kept, count: fresh.length };
  };
  const continuesNewChat = (messages: CollectedMessage[]) =>
    newChat !== null && messages[0]?.text === newChat.first && messages.length <= newChat.count + 1;
  // 주소가 /c/<id> 로 바뀐 뒤 처음 보낼 때까지 개수를 따라간다. 첫 답이 끝나자마자 다음 질문을 보내면 화면이 2초 동안
  // 조용해지기 전에 메시지가 셋 이상이 된다. 0.5초에 한 번만 읽고 한 번에 하나만 올린다: 답이 생성되는 동안 화면 변화마다
  // 대화를 다시 읽지 않고, 짧은 사이에 이어서 그려지는 지난 대화는 따라가지 않는다
  let followTimer: ReturnType<typeof setTimeout> | undefined;
  const followNewChat = () => {
    if (!newChat || baselinePath === location.pathname || !site.isConversationPage()) return;
    const wait = followedAt + NEW_CHAT_FOLLOW_MS - Date.now();
    if (wait > 0) {
      // 건너뛴 화면 변화가 마지막이었어도 한 번은 읽는다 (답이 끝난 뒤 화면이 조용하면 그 답을 세지 못한다)
      followTimer ??= setTimeout(() => {
        followTimer = undefined;
        followNewChat();
      }, wait);
      return;
    }
    followedAt = Date.now();
    const { messages } = site.extract();
    if (newChat && continuesNewChat(messages)) newChat.count = Math.max(newChat.count, messages.length);
  };

  const settleStop = (result: StopResult) => {
    if (!stopping || stopping.settled) return;
    stopping.settled = true;
    stopping.resolve(result);
  };

  const enqueue = (result: ExtractResult) => {
    const observed = new Map(metadata(result).map((m) => [m.id, m]));
    for (const message of result.messages) {
      const replyTo = observed.get(message.id)?.replyTo;
      if (baseline.has(message.id) || (replyTo && excludedUsers.has(replyTo))) continue;
      if (stopping && !stopping.ids.has(message.id) && !(replyTo && replyTo === stopping.replyTo)) continue;
      pending.set(message.id, message);
    }
  };

  const sendFresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (invalidated || Date.now() < retryAt || stopping?.settled || (!isActive() && !stopping)) return Promise.resolve();
    inFlight = (async () => {
      const result = site.extract();
      const { messages } = result;
      if (stopping && stopping.path !== location.pathname) {
        if (!/\/c\//.test(stopping.path) && continuesNewChat(messages)) stopping.path = location.pathname;
        else {
          settleStop({ ok: false, error: '대화가 바뀌어 마지막 답변 저장을 확인하지 못했어요. 원래 대화를 열어 다시 넣어 주세요.' });
          return;
        }
      }
      if (baselinePath !== location.pathname) {
        const sameChat = site.isConversationPage() && continuesNewChat(messages);
        baselinePath = location.pathname;
        newChat = null;
        if (!sameChat) {
          baseline.clear(); excludedUsers.clear(); markBoundary(result);
          return;
        }
      }
      if (!site.isConversationPage()) {
        if (stopping && !stopping.awaiting && !pending.size) settleStop({ ok: true });
        return;
      }
      enqueue(result);
      const fresh = [...pending.values()];
      if (fresh.length) {
        try {
          const sent = await send(fresh);
          if (!sent.ok) throw new Error(sent.error);
          if (sent.intakeIssues) throw new Error(`${sent.intakeIssues}개 발화가 검토 격리되어 정상 저장을 확인하지 못했어요.`);
          markSeen(fresh); lastFailure = null; retryAt = 0; errorToast.reset();
        } catch (error) {
          lastFailure = error instanceof Error ? error.message : '마지막 답변 저장 실패';
          retryAt = Date.now() + COLLECT_DEBOUNCE_MS;
          errorToast.show(lastFailure);
          return;
        }
      }
      if (stopping?.awaiting) {
        const observed = new Map(metadata(result).map((m) => [m.id, m]));
        // Only the answer paired with the question that was active at the stop request.
        const completed = result.messages.some((m) => m.role === 'assistant' && observed.get(m.id)?.replyTo === stopping?.replyTo);
        if (completed && result.capture?.pendingReplyTo !== stopping.replyTo) stopping.awaiting = false;
      }
      if (stopping && !stopping.awaiting && !pending.size) settleStop({ ok: true });
    })().finally(() => { inFlight = null; });
    return inFlight;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let signature = '';
  let readyAt = Infinity;
  const observe = () => {
    if (invalidated || stopping?.settled) return;
    if (!isActive() && !stopping) { markBoundary(); return; }
    if (stopping) { void sendFresh(); return; }
    if (baselinePath !== null) {
      if (!site.isConversationPage()) rememberNewChat();
      else if (newChat && baselinePath !== location.pathname) followNewChat();
    }
    const result = site.extract();
    const next = location.pathname + JSON.stringify(result.messages.map(({ id, text }) => [id, text]));
    // Unrelated clocks, UI updates, and animation DOM must not restart the wait.
    if (next !== signature) {
      signature = next;
      readyAt = Date.now() + COLLECT_DEBOUNCE_MS;
      clearTimeout(timer);
      timer = setTimeout(() => void sendFresh(), COLLECT_DEBOUNCE_MS);
    }
  };
  const observer = new MutationObserver((records) => {
    if (records.every((r) => overlay.contains(r.target))) return;
    observe();
  });
  // Snapshot synchronously; a delayed baseline would swallow a question sent just after enabling.
  baselinePath = location.pathname;
  markBoundary();
  const poll = () => {
    if (invalidated) return;
    observe();
    if (stopping && !stopping.settled && Date.now() >= stopping.deadline) {
      settleStop({ ok: false, error: lastFailure ?? '마지막 답변을 60초 안에 저장하지 못했어요. 대화 화면에서 다시 넣어 주세요.' });
    } else if (isActive() && Date.now() >= readyAt && !stopping?.settled) {
      void sendFresh(); // retry failed saves even if the page becomes completely quiet
    }
    pollTimer = setTimeout(poll, CHECK_INTERVAL_MS);
  };
  pollTimer = setTimeout(poll, CHECK_INTERVAL_MS);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ['hidden', 'aria-hidden', 'aria-label', 'data-testid', 'style', 'class'] });

  const activityChanged = (wasActive: boolean, active: boolean) => {
    if (!wasActive && active) {
      stopping = null;
      markBoundary(); // includes unfinished/pre-existing questions, not just finished answers
      signature = ''; readyAt = Infinity;
    } else if (!active && !stopping) {
      clearTimeout(timer);
      markBoundary();
    }
  };
  const prepareStop = (): Promise<StopResult> => {
    if (stopping) return stopping.promise;
    if (!isActive()) return Promise.resolve({ ok: true });
    clearTimeout(timer);
    if (baselinePath === null) baselinePath = location.pathname;
    const result = site.extract();
    if (!site.isConversationPage()) rememberNewChat();
    const observed = metadata(result);
    const lastUser = observed.findLast((m) => m.role === 'user');
    const hasAnswer = lastUser && result.messages.some((m) => m.role === 'assistant' && observed.find((o) => o.id === m.id)?.replyTo === lastUser.id);
    // The stop indicator/bubble can appear later than the submitted question.
    const replyTo = result.capture?.pendingReplyTo ?? (!hasAnswer ? lastUser?.id : undefined);
    const waiting = !!replyTo && !excludedUsers.has(replyTo);
    let resolve!: (result: StopResult) => void;
    const promise = new Promise<StopResult>((done) => { resolve = done; });
    stopping = { path: location.pathname, ids: new Set(metadata(result).map((m) => m.id)),
      ...(waiting ? { replyTo } : {}), awaiting: waiting, deadline: Date.now() + STOP_WAIT_MS, resolve, promise, settled: false };
    // Freeze the accepted set before waiting. New questions during stopping are excluded.
    void sendFresh().then(() => { if (!stopping?.settled) void sendFresh(); });
    return promise;
  };
  ctx.onInvalidated(() => {
    invalidated = true; observer.disconnect();
    clearTimeout(timer); clearTimeout(pollTimer); clearTimeout(followTimer);
    settleStop({ ok: false, error: '페이지가 닫혀 마지막 답변 저장을 확인하지 못했어요.' });
  });
  return { markSeen, activityChanged, prepareStop };
}
