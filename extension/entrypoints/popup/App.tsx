import { useEffect, useState } from 'react';
import { isShareable } from '@shared/labels';
import { SUBTOPICS, type Subtopic } from '@shared/types';
import { LOCAL_WEB_URL, PRODUCTION_WEB_URL, bridgeSupported, normalizeWebUrl } from '@/lib/config';
import { READ_FAIL_GUIDE, type TabPingResult } from '@/lib/messages';
import {
  collectStateItem,
  endsAtOf,
  isConfigured,
  isEnded,
  pendingItem,
  settingsItem,
  turnsOf,
  webUrlOf,
  type CollectState,
  type Settings,
} from '@/lib/settings';

// <input type="datetime-local"> 값 ↔ ISO
const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
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
  const [flushing, setFlushing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<TabStatus>({ kind: 'checking' });

  useEffect(() => {
    const countShareable = (p: Parameters<Parameters<typeof pendingItem.watch>[0]>[0]) =>
      setPendingCount(p.filter(isShareable).length); // '해당 없음'은 세지 않음
    settingsItem.getValue().then(setSettings);
    collectStateItem.getValue().then(setState);
    pendingItem.getValue().then(countShareable);
    const un = [
      settingsItem.watch(setSettings),
      collectStateItem.watch(setState),
      pendingItem.watch(countShareable),
    ];
    checkTab().then(setTab);
    browser.runtime.sendMessage({ type: 'refresh' }).catch(() => {});
    return () => un.forEach((f) => f());
  }, []);

  if (!settings || !state) return null;

  if (!isConfigured(settings) || editing) {
    return (
      <Setup
        initial={settings}
        firstTime={!isConfigured(settings)}
        onSave={async (s) => {
          const result = await browser.runtime.sendMessage({ type: 'updateSettings', patch: { projectTopic: s.projectTopic, enabledSubtopics: s.enabledSubtopics, turnsPerBatch: turnsOf(s), autoCollect: s.autoCollect, ...(s.endsAt ? { endsAt: s.endsAt } : {}) } });
          if (result?.ok) { await settingsItem.setValue({ ...await settingsItem.getValue(), webUrl: s.webUrl }); setEditing(false); }
          else alert(result?.error ?? '로컬 수집기 연결 실패');
        }}
        onCancel={isConfigured(settings) ? () => setEditing(false) : undefined}
      />
    );
  }

  const save = async (patch: Partial<Settings>) => {
    const result = await browser.runtime.sendMessage({ type: 'updateSettings', patch });
    if (!result?.ok) alert(result?.error ?? '설정 저장 실패');
  };
  // 종료 시각이 지난 뒤에는 종료 시각을 먼저 갱신해야 다시 수집된다(아래 안내문)
  const toggle = () => save({ autoCollect: !settings.autoCollect });
  const turns = turnsOf(settings);
  const bufferedTurns = settings.bufferedTurns ?? 0;
  const end = endsAtOf(settings);
  const flush = async () => {
    setFlushing(true);
    const result = await browser.runtime.sendMessage({ type: 'flush' }).catch(() => null);
    if (!result?.ok) alert(result?.error ?? '분류 요청 실패');
    setFlushing(false);
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

      <section className="space-y-2 rounded-lg border p-3">
        <div className="flex items-center justify-between gap-2">
          <span>대화</span>
          <span className="flex items-center rounded-md border">
            <button className="px-2 py-0.5 text-gray-500" onClick={() => save({ turnsPerBatch: Math.max(1, turns - 1) })} aria-label="줄이기">
              −
            </button>
            <b className="w-7 text-center text-brand">{turns}</b>
            <button className="px-2 py-0.5 text-gray-500" onClick={() => save({ turnsPerBatch: Math.min(50, turns + 1) })} aria-label="늘리기">
              +
            </button>
          </span>
          <span className="flex-1 text-xs text-gray-600">회마다 분류해 검토함에 올려요</span>
        </div>
        <label className="flex items-center justify-between gap-2 text-xs">
          <span className="text-gray-600">수집 종료 시각</span>
          <input
            type="datetime-local"
            value={end ? toLocalInput(end) : ''}
            onChange={(e) => save({ endsAt: e.target.value ? new Date(e.target.value).toISOString() : null })}
            className="rounded-md border px-1.5 py-1"
          />
        </label>
        {end && (
          <p className={`text-xs ${isEnded(settings) ? 'text-sensitive' : 'text-gray-500'}`}>
            {isEnded(settings)
              ? '수집이 종료됐어요. 종료 시각을 갱신한 뒤 다시 켜세요.'
              : `${end.toLocaleString('ko-KR')}에 수집과 AI 요청을 멈춰요`}
          </p>
        )}
      </section>

      <section className="space-y-1 rounded-lg bg-gray-50 p-3">
        <div className="flex items-center justify-between gap-2">
          <p>
            다음 분류까지 대화 <b>{bufferedTurns}</b>/{turns}회
          </p>
          <button
            className="rounded-md border bg-white px-2 py-0.5 text-xs disabled:opacity-40"
            disabled={!bufferedTurns || flushing}
            onClick={flush}
          >
            {flushing ? '분류 중…' : '지금 분류하기'}
          </button>
        </div>
        <p>
          검토 대기 카드 <b className="text-tag-decision">{pendingCount}개</b>
        </p>
        <p className="text-xs text-gray-500">
          마지막 수집: {settings.lastCollectedAt ? new Date(settings.lastCollectedAt).toLocaleString('ko-KR') : '아직 없음'}
          {settings.lastClassifier && ` · ${settings.lastClassifier === 'native' ? '로컬 수집기' : '목업 분류기'}`}
        </p>
      </section>

      <TabNotice tab={tab} autoCollect={settings.autoCollect} />
      {state.lastError && <Notice tone="error">{state.lastError}</Notice>}

      <div className="space-y-1">
        <button
          className="w-full rounded-lg bg-gray-900 px-3 py-2.5 font-medium text-white hover:bg-gray-800"
          onClick={() => browser.tabs.create({ url: `${webUrlOf(settings)}/review` })}
        >
          개인 검토함 열기{pendingCount ? ` (${pendingCount})` : ''}
        </button>
        <p className="truncate text-center text-xs text-gray-400" title={webUrlOf(settings)}>
          {webUrlOf(settings).replace(/^https?:\/\//, '')}
        </p>
      </div>
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
  const [webUrlInput, setWebUrlInput] = useState(webUrlOf(initial));
  const webUrl = normalizeWebUrl(webUrlInput); // null = 잘못된 주소
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((p) => ({ ...p, [k]: v }));
  const canSave = isConfigured(s) && !!webUrl;
  const toggleSub = (t: Subtopic) =>
    set('enabledSubtopics', s.enabledSubtopics.includes(t) ? s.enabledSubtopics.filter((x) => x !== t) : [...s.enabledSubtopics, t]);

  return (
    <form
      className="w-[340px] space-y-3 p-4 font-sans text-sm text-gray-900"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave)
          onSave({
            ...s,
            teamName: s.teamName.trim(),
            projectTopic: s.projectTopic.trim(),
            userName: s.userName.trim(),
            webUrl: webUrl!,
          });
      }}
    >
      <h1 className="text-base font-bold">{firstTime ? '싱크업 처음 설정' : '설정 수정'}</h1>
      {firstTime && <Notice tone="error">설정 안 됨: 아래 정보를 입력해야 수집을 시작할 수 있어요.</Notice>}

      <Field label="등록된 팀 이름" readOnly value={s.teamName} onChange={(v) => set('teamName', v)} placeholder="로컬 수집기 연결 필요" />
      <Field label="프로젝트 주제" value={s.projectTopic} onChange={(v) => set('projectTopic', v)} placeholder="예: 팀 AI 메모리 서비스" />
      <Field label="연결된 사용자" readOnly value={s.userName} onChange={(v) => set('userName', v)} placeholder="로컬 수집기 연결 필요" />

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

      <div className="space-y-1">
        <Field
          label="개인 검토함 주소"
          value={webUrlInput}
          onChange={setWebUrlInput}
          placeholder="https://syncup-xxxx.vercel.app"
        />
        <div className="flex gap-3 text-xs">
          <button type="button" className="text-gray-500 underline" onClick={() => setWebUrlInput(PRODUCTION_WEB_URL)}>
            배포 주소 쓰기
          </button>
          <button type="button" className="text-gray-500 underline" onClick={() => setWebUrlInput(LOCAL_WEB_URL)}>
            로컬 개발 주소 쓰기
          </button>
        </div>
        {!webUrl ? (
          <p className="text-xs text-sensitive">http:// 또는 https:// 로 시작하는 주소를 넣어 주세요.</p>
        ) : !bridgeSupported(webUrl) ? (
          <p className="text-xs text-warn">
            이 주소에서는 “확장에서 가져온 카드” 넘기기가 동작하지 않아요. localhost:3000 또는 *.vercel.app 주소를 써 주세요.
          </p>
        ) : (
          <p className="text-xs text-gray-500">Vercel 배포 주소를 붙여넣으면 “개인 검토함 열기”가 그 주소로 열려요.</p>
        )}
      </div>

      {/* CLAUDE.md §9: 수집 범위와 외부 AI 전송 안내 */}
      <div className="space-y-1 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
        <p className="font-medium text-gray-800">수집 범위 안내</p>
        <p>· 자동 수집을 켜면 chatgpt.com 에서 새로 끝난 대화(내 말·AI 답변)를 읽어요.</p>
        <p>· 선택한 발화는 로컬에 저장하고, 민감정보를 가린 뒤 외부 AI로 보내 분류합니다.</p>
        <p>· 팀 관련 후보만 검토함에 표시하고, 승인한 카드만 팀에 공유합니다.</p>
      </div>

      <div className="flex gap-2">
        {onCancel && (
          <button type="button" className="flex-1 rounded-lg border px-3 py-2" onClick={onCancel}>
            취소
          </button>
        )}
        <button
          type="submit"
          disabled={!canSave}
          className="flex-1 rounded-lg bg-gray-900 px-3 py-2 font-medium text-white disabled:opacity-40"
        >
          저장
        </button>
      </div>
    </form>
  );
}

function Field({ label, value, onChange, placeholder, readOnly=false }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; readOnly?: boolean }) {
  return (
    <label className="block space-y-1">
      <span className="font-medium">{label}</span>
      <input
        readOnly={readOnly}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border px-2.5 py-1.5 outline-none focus:border-tag-decision"
      />
    </label>
  );
}
