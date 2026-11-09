// 자동 수집 켜기 · 묶음 크기 · 종료 시각. 바꿀 때마다 로컬 수집기에 바로 저장한다
import { sendToBackground, type CollectorSettingsPatch } from '@/lib/messages';
import { clampTurns, endsAtOf, isEnded, turnsOf, type Settings } from '@/lib/settings';
import { fromLocalInput, toLocalInput } from './datetime-local';

async function save(patch: CollectorSettingsPatch) {
  const result = await sendToBackground({ type: 'updateSettings', patch });
  if (!result?.ok) alert(result?.error ?? '설정 저장 실패');
}

// 종료 시각이 지난 뒤에 켜면 수집기가 '수집 종료 시각을 먼저 갱신하세요.'로 거절한다 (CollectionLimits 가 안내한다)
export function AutoCollectSwitch({ autoCollect }: { autoCollect: boolean }) {
  return (
    <label className="flex cursor-pointer items-center justify-between rounded-lg border p-3">
      <span>
        <span className="block font-medium">자동 수집</span>
        <span className="text-xs text-gray-500">ChatGPT에서 새로 끝난 대화를 자동으로 가져와요</span>
      </span>
      <input type="checkbox" role="switch" checked={autoCollect} onChange={() => void save({ autoCollect: !autoCollect })} className="peer sr-only" />
      <span className="relative h-6 w-11 shrink-0 rounded-full bg-gray-300 transition-colors peer-checked:bg-tag-decision after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5" />
    </label>
  );
}

// 몇 번의 대화마다 분류할지와 수집 종료 시각
export function CollectionLimits({ settings }: { settings: Settings }) {
  const turns = turnsOf(settings);
  const end = endsAtOf(settings);
  return (
    <section className="space-y-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <span>대화</span>
        <span className="flex items-center rounded-md border">
          <button className="px-2 py-0.5 text-gray-500" onClick={() => void save({ turnsPerBatch: clampTurns(turns - 1) })} aria-label="줄이기">
            −
          </button>
          <b className="w-7 text-center text-brand">{turns}</b>
          <button className="px-2 py-0.5 text-gray-500" onClick={() => void save({ turnsPerBatch: clampTurns(turns + 1) })} aria-label="늘리기">
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
          onChange={(e) => {
            const endsAt = fromLocalInput(e.target.value);
            if (endsAt) void save({ endsAt });
          }}
          className="rounded-md border px-1.5 py-1"
        />
      </label>
      {end && (
        <p className={`text-xs ${isEnded(settings) ? 'text-sensitive' : 'text-gray-500'}`}>
          {isEnded(settings) ? '수집이 종료됐어요. 종료 시각을 갱신한 뒤 다시 켜세요.' : `${end.toLocaleString('ko-KR')}에 수집과 AI 요청을 멈춰요`}
        </p>
      )}
    </section>
  );
}
