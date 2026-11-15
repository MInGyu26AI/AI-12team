// 자동 수집 켜기 · 종료 시각. 바꿀 때마다 로컬 수집기에 바로 저장한다
import { useEffect, useState } from 'react';
import type { ExtSettingsPatch } from '@shared/bridge';
import { sendToBackground } from '@/lib/messages';
import { collectionTransitionItem, endsAtOf, isEnded, type Settings } from '@/lib/settings';
import { deadlineCalendar, fromLocalInput, HOUR_MS, MAX_COLLECTION_DAYS, MAX_COLLECTION_MS, toLocalInput } from './datetime-local';
import { SwitchTrack } from './SwitchTrack';

async function save(patch: ExtSettingsPatch) {
  const result = await sendToBackground({ type: 'updateSettings', patch });
  if (!result?.ok) throw new Error(result?.error ?? '설정 저장 실패');
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : '설정 저장 실패';

// 종료 시각이 지난 뒤에 켜면 수집기가 '수집 종료 시각을 먼저 갱신하세요.'로 거절한다 (CollectionLimits 가 안내한다)
export function AutoCollectSwitch({ autoCollect }: { autoCollect: boolean }) {
  const [transition, setTransition] = useState<'stopping' | 'starting' | null>(null);
  useEffect(() => {
    void collectionTransitionItem.getValue().then(setTransition);
    return collectionTransitionItem.watch(setTransition);
  }, []);
  return (
    <label className="flex cursor-pointer items-center justify-between rounded-lg border p-3">
      <span>
        <span className="block font-medium">자동 수집</span>
        <span className="text-xs text-gray-500" role="status">{transition === 'stopping' ? '마지막 답변 저장 중… 완료되면 수집을 꺼요.' : transition === 'starting' ? '수집을 켜는 중…' : '켜 둔 동안 ChatGPT의 새 대화를 가져와요.'}</span>
      </span>
      <input type="checkbox" role="switch" disabled={!!transition} aria-busy={!!transition} checked={autoCollect} onChange={() => void save({ autoCollect: !autoCollect }).catch((error) => alert(errorMessage(error)))} className="peer sr-only" />
      <SwitchTrack />
    </label>
  );
}

const timers = [
  { label: '3시간', hours: 3 }, { label: '6시간', hours: 6 }, { label: '12시간', hours: 12 },
  { label: '1일', hours: 24 }, { label: '3일', hours: 72 }, { label: '7일', hours: MAX_COLLECTION_DAYS * 24 },
];
const deadlineFormat = new Intl.DateTimeFormat('ko-KR', {
  month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const keyboardFocus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand';

export function CollectionLimits({ settings }: { settings: Settings }) {
  const end = endsAtOf(settings);
  const now = Date.now();
  const ended = isEnded(settings, now);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { first, last, days } = deadlineCalendar(now);
  const chosenDate = draft?.slice(0, 10);
  const clamp = (value: string) => value < first ? first : value > last ? last : value;
  const cancel = () => {
    setDraft(null);
    setError(null);
  };
  const edit = () => {
    setError(null);
    setDraft(clamp(toLocalInput(end && !ended ? end : new Date(Date.now() + 3 * HOUR_MS))));
  };
  const commit = async (endsAt: string) => {
    setSaving(true);
    setError(null);
    try {
      await save({ endsAt });
      setDraft(null);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  const submitDate = () => {
    const endsAt = fromLocalInput(draft ?? '');
    const current = Date.now();
    if (!endsAt || Date.parse(endsAt) <= current || Date.parse(endsAt) > current + MAX_COLLECTION_MS) {
      setError(`현재 시각 이후, ${MAX_COLLECTION_DAYS}일 이내로 설정해 주세요.`);
      return;
    }
    void commit(endsAt);
  };

  return (
    <section className="space-y-3 rounded-xl border border-gray-200 p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">수집 종료 시각</h2>
        <span className="text-[11px] text-gray-500">최대 {MAX_COLLECTION_DAYS}일</span>
      </div>
      <button type="button" aria-expanded={draft !== null} aria-controls={draft ? 'collection-calendar' : undefined} aria-label="종료 날짜와 시각 선택"
        disabled={saving} onClick={draft ? cancel : edit}
        className={`flex w-full items-center justify-between gap-2 rounded-lg bg-brand-soft px-3 py-2.5 text-left text-brand-hover hover:bg-indigo-100 disabled:opacity-60 ${keyboardFocus}`}>
        <span className="font-semibold tabular-nums">{end ? deadlineFormat.format(end) : '날짜와 시각 선택'}</span>
        <span className="shrink-0 text-xs font-medium">{draft ? '닫기' : '달력'} <span aria-hidden="true">{draft ? '▴' : '▾'}</span></span>
      </button>
      {draft !== null && (
        <form id="collection-calendar" className="space-y-2 rounded-lg bg-gray-50 p-2" noValidate onSubmit={(e) => { e.preventDefault(); submitDate(); }}>
          <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="종료 날짜">
            {days.map(({ date, weekday, day, month }) => (
              <button key={date} type="button" aria-label={`${month}월 ${day}일 ${weekday}요일`} aria-pressed={chosenDate === date}
                onClick={() => setDraft(clamp(`${date}T${draft.slice(11) || '12:00'}`))} disabled={saving}
                className={`rounded-md border border-gray-200 bg-white py-1.5 text-xs tabular-nums hover:border-brand aria-pressed:border-brand aria-pressed:bg-brand aria-pressed:text-white ${keyboardFocus}`}>
                <span className="block font-medium">{weekday}</span>
                <span>{month}.{day}</span>
              </button>
            ))}
          </div>
          <div className="flex items-end gap-2">
            <label className="min-w-0 flex-1 text-xs font-medium text-gray-600">종료 시간
              <input type="time" required value={draft.slice(11)} disabled={saving}
                onChange={(e) => setDraft(`${chosenDate}T${e.target.value}`)}
                className={`mt-1 block w-full rounded-md border border-gray-200 bg-white px-2 py-1.5 text-gray-900 ${keyboardFocus}`} />
            </label>
            <button type="submit" disabled={saving}
              className={`rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-hover disabled:opacity-60 ${keyboardFocus}`}>설정</button>
          </div>
        </form>
      )}
      <div className="space-y-1.5" role="group" aria-label="지금부터 종료까지">
        <p className="text-xs font-medium text-gray-600">지금부터</p>
        <div className="grid grid-cols-3 gap-1.5">
          {timers.map(({ label, hours }) => (
            <button key={hours} type="button" aria-label={`지금부터 ${label}`} disabled={saving}
              onClick={() => void commit(new Date(Date.now() + hours * HOUR_MS).toISOString())}
              className={`rounded-md border border-gray-200 px-1 py-1.5 text-xs font-medium hover:border-indigo-300 hover:bg-brand-soft hover:text-brand-hover disabled:opacity-60 ${keyboardFocus}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {saving && <p role="status" className="text-xs text-gray-500">저장 중이에요…</p>}
      {error && <p role="alert" className="text-xs text-sensitive">{error}</p>}
      {!error && ended && <p className="text-xs text-sensitive">수집이 종료됐어요. 시간을 설정하고 자동 수집을 켜세요.</p>}
    </section>
  );
}
