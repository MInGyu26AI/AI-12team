import { useEffect, useState } from 'react';
import { SUBTOPICS, type Subtopic } from '@shared/types';
import { WEB_URL } from '@/lib/config';
import { READ_FAIL_GUIDE, type TabPingResult } from '@/lib/messages';
import {
  collectStateItem,
  isConfigured,
  pendingItem,
  settingsItem,
  type CollectState,
  type Settings,
} from '@/lib/settings';
import { SITES } from '@/lib/sites';

type TabStatus =
  | { kind: 'checking' }
  | { kind: 'not-chat' } // ChatGPT 탭이 아님
  | { kind: 'no-script' } // 콘텐츠 스크립트 응답 없음 (설치 전에 열린 탭 등)
  | { kind: 'ok'; ping: TabPingResult };

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [state, setState] = useState<CollectState | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<TabStatus>({ kind: 'checking' });

  useEffect(() => {
    settingsItem.getValue().then(setSettings);
    collectStateItem.getValue().then(setState);
    pendingItem.getValue().then((p) => setPendingCount(p.length));
    const un = [
      settingsItem.watch(setSettings),
      collectStateItem.watch(setState),
      pendingItem.watch((p) => setPendingCount(p.length)),
    ];
    checkTab().then(setTab);
    return () => un.forEach((f) => f());
  }, []);

  if (!settings || !state) return null;

  if (!isConfigured(settings) || editing) {
    return (
      <Setup
        initial={settings}
        firstTime={!isConfigured(settings)}
        onSave={async (s) => {
          await settingsItem.setValue(s);
          setEditing(false);
        }}
        onCancel={isConfigured(settings) ? () => setEditing(false) : undefined}
      />
    );
  }

  const toggle = () => {
    const next = { ...settings, autoCollect: !settings.autoCollect };
    setSettings(next); // 화면은 바로 반영, 저장은 뒤따라
    void settingsItem.setValue(next);
  };

  return (
    <main className="w-[340px] space-y-3 p-4 font-sans text-sm text-gray-900">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-base font-bold">싱크업</h1>
          <p className="text-xs text-gray-500">
            {settings.teamName} · {settings.userName}
          </p>
        </div>
        <button className="text-xs text-gray-500 underline" onClick={() => setEditing(true)}>
          설정 수정
        </button>
      </header>

      <label className="flex cursor-pointer items-center justify-between rounded-lg border p-3">
        <span>
          <span className="block font-medium">자동 수집</span>
          <span className="text-xs text-gray-500">ChatGPT에서 새로 끝난 대화를 자동으로 가져와요</span>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={settings.autoCollect}
          onChange={toggle}
          className="peer sr-only"
        />
        <span className="relative h-6 w-11 shrink-0 rounded-full bg-gray-300 transition-colors peer-checked:bg-tag-decision after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5" />
      </label>

      <section className="space-y-1 rounded-lg bg-gray-50 p-3">
        <p>
          ChatGPT 대화 메시지 <b>{state.collectedCount}개</b> 수집됨
        </p>
        <p>
          검토 대기 카드 <b className="text-tag-decision">{pendingCount}개</b>
        </p>
        <p className="text-xs text-gray-500">
          마지막 수집: {state.lastCollectedAt ? new Date(state.lastCollectedAt).toLocaleString('ko-KR') : '아직 없음'}
          {state.lastClassifier && ` · ${state.lastClassifier === 'native' ? '로컬 수집기' : '목업 분류기'}`}
        </p>
      </section>

      <TabNotice tab={tab} autoCollect={settings.autoCollect} />
      {state.lastError && <Notice tone="error">{state.lastError}</Notice>}

      <button
        className="w-full rounded-lg bg-gray-900 px-3 py-2.5 font-medium text-white hover:bg-gray-800"
        onClick={() => browser.tabs.create({ url: `${WEB_URL}/review` })}
      >
        개인 검토함 열기{pendingCount ? ` (${pendingCount})` : ''}
      </button>
    </main>
  );
}

async function checkTab(): Promise<TabStatus> {
  const [active] = await browser.tabs.query({ active: true, currentWindow: true });
  const host = active?.url ? new URL(active.url).hostname : '';
  if (!active?.id || !SITES.some((s) => s.hosts.includes(host))) return { kind: 'not-chat' };
  try {
    const ping = (await browser.tabs.sendMessage(active.id, { type: 'ping' })) as TabPingResult;
    return ping ? { kind: 'ok', ping } : { kind: 'no-script' };
  } catch {
    return { kind: 'no-script' };
  }
}

function TabNotice({ tab, autoCollect }: { tab: TabStatus; autoCollect: boolean }) {
  if (tab.kind === 'checking') return null;
  if (tab.kind === 'not-chat') return <Notice tone="info">지금 탭은 ChatGPT가 아니에요. 수집은 chatgpt.com 탭에서 동작해요.</Notice>;
  if (tab.kind === 'no-script') return <Notice tone="error">ChatGPT 페이지와 연결이 안 됐어요. 페이지를 새로고침해 주세요.</Notice>;
  const { ping } = tab;
  if (!ping.selector && ping.onConversation)
    return (
      <Notice tone="error">
        {READ_FAIL_GUIDE}. (드래그 후 오른쪽 아래 “선택한 내용 보내기” 또는 우클릭 메뉴)
      </Notice>
    );
  if (!ping.onConversation) return <Notice tone="info">대화를 시작하면 {autoCollect ? '자동으로' : '“싱크업에 보내기” 버튼으로'} 수집해요.</Notice>;
  return (
    <Notice tone="ok">
      이 대화에서 메시지 {ping.messageCount}개를 읽을 수 있어요
      {ping.guessedRoles > 0 && ` (그중 ${ping.guessedRoles}개는 누가 말했는지 순서로 추정)`}.
      {!autoCollect && ' 화면 오른쪽 아래 버튼으로 보낼 수 있어요.'}
    </Notice>
  );
}

function Notice({ tone, children }: { tone: 'info' | 'ok' | 'error'; children: React.ReactNode }) {
  const color = {
    info: 'bg-gray-50 text-gray-600',
    ok: 'bg-tag-todo-soft text-tag-todo',
    error: 'bg-sensitive-soft text-sensitive',
  }[tone];
  return <p className={`rounded-lg px-3 py-2 text-xs ${color}`}>{children}</p>;
}

function Setup({
  initial,
  firstTime,
  onSave,
  onCancel,
}: {
  initial: Settings;
  firstTime: boolean;
  onSave: (s: Settings) => void;
  onCancel?: () => void;
}) {
  const [s, setS] = useState(initial);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((p) => ({ ...p, [k]: v }));
  const toggleSub = (t: Subtopic) =>
    set('enabledSubtopics', s.enabledSubtopics.includes(t) ? s.enabledSubtopics.filter((x) => x !== t) : [...s.enabledSubtopics, t]);

  return (
    <form
      className="w-[340px] space-y-3 p-4 font-sans text-sm text-gray-900"
      onSubmit={(e) => {
        e.preventDefault();
        if (isConfigured(s)) onSave({ ...s, teamName: s.teamName.trim(), projectTopic: s.projectTopic.trim(), userName: s.userName.trim() });
      }}
    >
      <h1 className="text-base font-bold">{firstTime ? '싱크업 처음 설정' : '설정 수정'}</h1>
      {firstTime && <Notice tone="error">설정 안 됨: 아래 정보를 입력해야 수집을 시작할 수 있어요.</Notice>}

      <Field label="팀 이름" value={s.teamName} onChange={(v) => set('teamName', v)} placeholder="예: 싱크업" />
      <Field label="프로젝트 주제" value={s.projectTopic} onChange={(v) => set('projectTopic', v)} placeholder="예: 팀 AI 메모리 서비스" />
      <Field label="내 이름" value={s.userName} onChange={(v) => set('userName', v)} placeholder="예: 김단비" />

      <fieldset className="space-y-1.5">
        <legend className="mb-1 font-medium">켤 소주제</legend>
        <div className="grid grid-cols-2 gap-1.5">
          {SUBTOPICS.map((t) => (
            <label key={t} className="flex items-center gap-1.5 text-xs">
              <input type="checkbox" checked={s.enabledSubtopics.includes(t)} onChange={() => toggleSub(t)} />
              {t}
            </label>
          ))}
        </div>
        <p className="text-xs text-gray-500">꺼 둔 소주제 내용은 ‘기타’로 분류돼요.</p>
      </fieldset>

      {/* CLAUDE.md §9: 수집 범위와 외부 AI 전송 안내 */}
      <div className="space-y-1 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
        <p className="font-medium text-gray-800">수집 범위 안내</p>
        <p>· 자동 수집을 켜면 chatgpt.com 에서 새로 끝난 대화(내 말·AI 답변)를 읽어요.</p>
        <p>· 분류를 위해 필요한 발췌가 외부 AI로 보내질 수 있어요 (지금은 목업이라 기기 밖으로 나가지 않아요).</p>
        <p>· 개인 내용은 버리고, 전화번호 등 민감정보는 가려요. 팀에는 내가 승인한 카드만 올라가요.</p>
      </div>

      <div className="flex gap-2">
        {onCancel && (
          <button type="button" className="flex-1 rounded-lg border px-3 py-2" onClick={onCancel}>
            취소
          </button>
        )}
        <button
          type="submit"
          disabled={!isConfigured(s)}
          className="flex-1 rounded-lg bg-gray-900 px-3 py-2 font-medium text-white disabled:opacity-40"
        >
          저장
        </button>
      </div>
    </form>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="block space-y-1">
      <span className="font-medium">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border px-2.5 py-1.5 outline-none focus:border-tag-decision"
      />
    </label>
  );
}
