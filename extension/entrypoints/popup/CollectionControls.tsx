// 자동 수집 켜기 · 종료 시각. 바꿀 때마다 로컬 수집기에 바로 저장한다
import { useState } from 'react';
import type { ExtSettingsPatch } from '@shared/bridge';
import { sendToBackground } from '@/lib/messages';
import { endsAtOf, isEnded, type Settings } from '@/lib/settings';
import { fromLocalInput, toLocalInput } from './datetime-local';
import { SwitchTrack } from './SwitchTrack';

async function save(patch: ExtSettingsPatch) {
  const result = await sendToBackground({ type: 'updateSettings', patch });
  if (!result?.ok) alert(result?.error ?? '설정 저장 실패');
}

// 종료 시각이 지난 뒤에 켜면 수집기가 '수집 종료 시각을 먼저 갱신하세요.'로 거절한다 (CollectionLimits 가 안내한다)
export function AutoCollectSwitch({ autoCollect }: { autoCollect: boolean }) {
  return (
    <label className="flex cursor-pointer items-center justify-between rounded-lg border p-3">
      <span>
        <span className="block font-medium">자동 수집</span>
        <span className="text-xs text-gray-500">켜 둔 동안 ChatGPT의 새 대화를 가져와요. 프로젝트 대화를 할 때만 켜 주세요</span>
      </span>
      <input type="checkbox" role="switch" checked={autoCollect} onChange={() => void save({ autoCollect: !autoCollect })} className="peer sr-only" />
      <SwitchTrack />
    </label>
  );
}

// 수집 종료 시각. 몇 회마다 분류할지는 팀 고정값이라 고르지 않는다 (회의록 3장 ①)
export function CollectionLimits({ settings }: { settings: Settings }) {
  const end = endsAtOf(settings);
  // 입력하는 동안은 화면 값만 바꾸고, 칸을 벗어나거나 Enter 를 누를 때 한 번 저장한다
  // (예전에는 저장된 값에 묶여 있어 입력 중 덜 찬 값이 되돌아가고, 숫자마다 저장했다)
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const endsAt = draft ? fromLocalInput(draft) : null;
    if (endsAt && endsAt !== end?.toISOString()) void save({ endsAt });
    setDraft(null);
  };
  return (
    <section className="space-y-2 rounded-lg border p-3">
      <label className="flex items-center justify-between gap-2 text-xs">
        <span className="text-gray-600">수집 종료 시각</span>
        <input
          type="datetime-local"
          value={draft ?? (end ? toLocalInput(end) : '')}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && commit()}
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
