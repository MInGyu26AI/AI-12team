import { useState } from 'react';
import { sendToBackground } from '@/lib/messages';
import { sendBlockedReason, turnsOf, type Settings } from '@/lib/settings';

// 다음 분류까지 쌓인 대화 · "지금 분류하기" · 검토 대기 카드 수 · 마지막 수집 시각
export function QueueStatus({ settings, pendingCount }: { settings: Settings; pendingCount: number }) {
  const [flushing, setFlushing] = useState(false);
  const bufferedTurns = settings.bufferedTurns ?? 0;
  const nextBatchTurns = settings.nextBatchTurns ?? bufferedTurns; // 옛 수집기는 합계만 준다
  const flush = async () => {
    setFlushing(true);
    const result = await sendToBackground({ type: 'flush' }).catch(() => null);
    if (!result?.ok) alert(result?.error ?? '분류 요청 실패');
    setFlushing(false);
  };

  return (
    <section className="space-y-1 rounded-lg bg-gray-50 p-3">
      <div className="flex items-center justify-between gap-2">
        <p>
          다음 분류까지 대화 <b>{nextBatchTurns}</b>/{turnsOf(settings)}회
        </p>
        <button
          className="rounded-md border bg-white px-2 py-0.5 text-xs disabled:opacity-40"
          disabled={!bufferedTurns || flushing || !!sendBlockedReason(settings)}
          onClick={flush}
        >
          {flushing ? '분류 중…' : '지금 분류하기'}
        </button>
      </div>
      {!settings.autoCollect && bufferedTurns > 0 && (
        <p className="text-xs text-gray-500">쌓인 대화는 보관돼 있어요. 수집을 다시 켜면 다음 묶음에 합쳐요.</p>
      )}
      <p>
        검토 대기 카드 <b className="text-tag-decision">{pendingCount}개</b>
      </p>
      <p className="text-xs text-gray-500">
        마지막 수집: {settings.lastCollectedAt ? new Date(settings.lastCollectedAt).toLocaleString('ko-KR') : '아직 없음'}
      </p>
    </section>
  );
}
