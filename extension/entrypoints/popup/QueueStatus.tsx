import { useState } from 'react';
import { TURNS_PER_BATCH } from '@shared/batch';
import { sendToBackground } from '@/lib/messages';
import type { Settings } from '@/lib/settings';

// 다음 분류까지 쌓인 대화 · "싱크 맞추기" · 검토 대기 카드 수 · 마지막 수집 시각
export function QueueStatus({ settings, pendingCount }: { settings: Settings; pendingCount: number }) {
  const [syncing, setSyncing] = useState(false);
  const bufferedTurns = settings.bufferedTurns ?? 0;
  // 쌓인 대화가 있으면 지금 분류에 넣고(flush), 없으면 수집기 상태만 다시 읽는다
  const sync = async () => {
    setSyncing(true);
    const result = await sendToBackground({ type: bufferedTurns ? 'flush' : 'refresh' }).catch(() => null);
    if (!result?.ok) alert(result?.error ?? '싱크 맞추기 실패');
    setSyncing(false);
  };

  return (
    <section className="space-y-1 rounded-lg bg-gray-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <p>
          다음 분류까지 대화 <b>{bufferedTurns}</b>/{TURNS_PER_BATCH}회
        </p>
        <button className="rounded-md border bg-white px-2 py-0.5 text-xs disabled:opacity-40" disabled={syncing} onClick={sync}>
          {syncing ? '맞추는 중…' : '싱크 맞추기'}
        </button>
      </div>
      <p>
        검토 대기 카드 <b className="text-tag-decision">{pendingCount}개</b>
      </p>
      <p className="text-xs text-gray-500">
        마지막 수집: {settings.lastCollectedAt ? new Date(settings.lastCollectedAt).toLocaleString('ko-KR') : '아직 없음'}
      </p>
    </section>
  );
}
