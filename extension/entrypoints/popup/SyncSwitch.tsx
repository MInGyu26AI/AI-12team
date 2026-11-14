// '프로젝트만 수집' 스위치 · 동의 문구 · 프로젝트 고르기 · 상태 한 줄 (docs/sync-contract.md 5장).
// 기본은 꺼짐이다. 켜려면 동의 문구를 보고 프로젝트를 골라야 한다. 켜고 끄는 일은 백그라운드(syncSet)가 한다
import { useEffect, useState } from 'react';
import type { SyncState } from '@/lib/chatgpt-sync/state';
import type { SyncProject } from '@/lib/messages';
import { Notice } from './Notice';
import { SwitchTrack } from './SwitchTrack';
import { setProjectSync } from './sync-actions';
import { syncSkippedLine, syncStatusLine } from './sync-status';
import { useSyncProjects } from './useSyncState';

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function SyncSwitch({ sync }: { sync: SyncState }) {
  const [choosing, setChoosing] = useState(false); // 동의 문구와 프로젝트 고르기를 보여 주는 중
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const line = syncStatusLine(sync, useNow());
  const skipped = syncSkippedLine(sync);

  const change = async (enabled: boolean, project?: SyncProject) => {
    setBusy(true);
    setError(null);
    const result = await setProjectSync(enabled, project);
    if (result.ok) setChoosing(false);
    else setError(result.error);
    setBusy(false);
  };
  const toggle = () => {
    setError(null);
    if (sync.enabled) void change(false);
    else setChoosing((open) => !open);
  };

  return (
    <section className="space-y-2 rounded-lg border p-3">
      <label className="flex cursor-pointer items-center justify-between">
        <span>
          <span className="block font-medium">프로젝트만 수집</span>
          <span className="text-xs text-gray-500">고른 ChatGPT 프로젝트의 대화만 가져와요</span>
        </span>
        <input type="checkbox" role="switch" checked={sync.enabled} disabled={busy} onChange={toggle} className="peer sr-only" />
        <SwitchTrack />
      </label>
      {line && <Notice tone={line.tone}>{line.text}</Notice>}
      {skipped && <p className="text-xs text-warn">{skipped}</p>}
      {choosing && !sync.enabled && <ConsentPanel busy={busy} onConfirm={(project) => void change(true, project)} onCancel={() => setChoosing(false)} />}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}

// 켜기 전에 보여 주는 안내. 이용약관 판단에 따라 동의 없이는 켜지 않는다
export function ConsentText() {
  return (
    <div className="space-y-1 rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
      <p className="font-medium text-gray-800">고른 프로젝트 대화만 가져오고, 승인한 것만 공유해요</p>
      <p>· 앱·다른 기기에서 나눈 대화도 포함돼요. 동기화에서는 임시 채팅이 빠져요.</p>
      <p>· 민감정보를 가린 일부만 외부 AI로 보내 분류해요.</p>
      <p>· 켠 뒤 새로 생긴 대화만 가져와요. ChatGPT에서 지워도 이미 가져온 건 남아요.</p>
    </div>
  );
}

function ConsentPanel({ busy, onConfirm, onCancel }: { busy: boolean; onConfirm: (project: SyncProject) => void; onCancel: () => void }) {
  const projects = useSyncProjects();
  const [gizmoId, setGizmoId] = useState('');
  const list = projects.kind === 'done' && projects.ok ? projects.projects : [];
  const picked = list.find((p) => p.gizmoId === gizmoId);

  return (
    <div className="space-y-2">
      <ConsentText />
      {projects.kind === 'loading' && <p className="text-xs text-gray-500">프로젝트 목록을 불러오는 중…</p>}
      {projects.kind === 'done' && !projects.ok && <Notice tone="error">{projects.error}</Notice>}
      {projects.kind === 'done' && projects.ok && !list.length && (
        <Notice tone="info">고를 수 있는 프로젝트가 없어요. ChatGPT에서 프로젝트를 먼저 만들어 주세요.</Notice>
      )}
      {list.length > 0 && (
        <label className="block space-y-1 text-xs">
          <span className="font-medium">가져올 프로젝트</span>
          <select value={gizmoId} onChange={(e) => setGizmoId(e.target.value)} className="w-full rounded-md border px-2 py-1.5 text-sm">
            <option value="">프로젝트를 고르세요</option>
            {list.map((p) => (
              <option key={p.gizmoId} value={p.gizmoId}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex gap-2">
        <button type="button" className="flex-1 rounded-lg border px-3 py-1.5" onClick={onCancel}>
          취소
        </button>
        <button
          type="button"
          disabled={!picked || busy}
          className="flex-1 rounded-lg bg-gray-900 px-3 py-1.5 font-medium text-white disabled:opacity-40"
          onClick={() => picked && onConfirm(picked)}
        >
          {busy ? '켜는 중…' : '동의하고 켜기'}
        </button>
      </div>
    </div>
  );
}
