import { useId, useState } from 'react';
import { turnsOf, type Settings } from '@/lib/settings';
import { Notice } from './Notice';
import { runSyncNow } from './sync-actions';
import { syncNowBlockedReason, type PopupNotice } from './sync-status';

// 다음 분류까지 쌓인 대화 · "싱크 맞추기" · 검토 대기 카드 수 · 마지막 수집 시각
export function QueueStatus({ settings, pendingCount, syncEnabled }: { settings: Settings; pendingCount: number; syncEnabled: boolean }) {
  const tooltipId = useId();
  const [dismissed, setDismissed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<PopupNotice | null>(null);
  const bufferedTurns = settings.bufferedTurns ?? 0;
  const nextBatchTurns = settings.nextBatchTurns ?? bufferedTurns; // 옛 수집기는 합계만 준다
  const blocked = syncNowBlockedReason(settings, syncEnabled);
  const syncNow = async () => {
    setSyncing(true);
    setResult(null);
    setResult(await runSyncNow());
    setSyncing(false);
  };

  return (
    <section className="space-y-1 rounded-lg bg-surface-soft p-3">
      <div className="flex items-center justify-between gap-2">
        <p>
          다음 분류까지 대화 <b>{nextBatchTurns}</b>/{turnsOf(settings)}회
        </p>
        <div
          className="group relative shrink-0 p-1 -m-1"
          tabIndex={syncing || !!blocked ? 0 : -1}
          onKeyDown={(event) => { if (event.key === 'Escape') setDismissed(true); }}
          onMouseLeave={() => setDismissed(false)}
          onBlur={() => setDismissed(false)}
        >
          <button
            className="flex h-9 w-9 items-center justify-center rounded-md text-gray-700 hover:bg-gray-200 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-55"
            disabled={syncing || !!blocked}
            aria-label="지금까지 모은 대화 넣기"
            aria-describedby={tooltipId}
            aria-busy={syncing}
            onClick={syncNow}
          >
            {/* Lucian refresh 2.0.13 outline, rendered statically without its animation runtime. */}
            <svg className="block shrink-0" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <path d="M4 12a8 8 0 0 1 13.66-5.66L20 8.5" />
              <path d="M20 3.5v5h-5" />
              <path d="M20 12a8 8 0 0 1-13.66 5.66L4 15.5" />
              <path d="M4 20.5v-5h5" />
            </svg>
          </button>
          <span
            id={tooltipId}
            role="tooltip"
            className={`absolute right-0 bottom-full z-10 mb-1 w-56 rounded-lg bg-gray-900 px-3 py-2 text-xs text-white shadow-lg ${dismissed ? 'hidden' : 'invisible group-hover:visible group-focus-within:visible'}`}
          >
            <strong className="block">지금까지 모은 대화 넣기</strong>
            {(syncing || blocked) && <span className="mt-1 block text-gray-200">{syncing ? '처리 요청 중…' : blocked}</span>}
          </span>
        </div>
      </div>
      <p className="text-xs text-gray-500">연결한 프로젝트의 새 대화를 확인하고, 다른 대화를 포함한 수집 대기분을 처리해요. 프로젝트 연결이 꺼져 있으면 대기분만 처리해요.</p>
      {result && <Notice tone={result.tone}>{result.text}</Notice>}
      {!settings.autoCollect && bufferedTurns > 0 && (
        <p className="text-xs text-muted-foreground">쌓인 대화는 보관돼 있어요. 수집을 다시 켜면 다음 묶음에 합쳐요.</p>
      )}
      <p>
        검토 대기 카드 <b className="text-brand">{pendingCount}개</b>
      </p>
      <p className="text-xs text-muted-foreground">
        마지막 수집: {settings.lastCollectedAt ? new Date(settings.lastCollectedAt).toLocaleString('ko-KR') : '아직 없음'}
      </p>
    </section>
  );
}
