import { useEffect, useState } from 'react';
import type { Card } from '@shared/types';
import { settings, type Settings } from '@/lib/settings';

// 세팅 확인용 임시 팝업. 다음 작업에서 가입·설정·상태 화면으로 교체 (CLAUDE.md §7-A)
export default function App() {
  const [s, setS] = useState<Settings | null>(null);
  const [candidates, setCandidates] = useState<Card[]>([]);

  useEffect(() => {
    settings.getValue().then(setS);
    browser.runtime.sendMessage({ type: 'getCandidates' }).then(setCandidates);
    return settings.watch(setS);
  }, []);

  if (!s) return null;
  const toggle = () => settings.setValue({ ...s, collecting: !s.collecting });

  return (
    <main className="w-80 p-4 space-y-3 font-sans">
      <h1 className="text-lg font-bold">싱크업</h1>
      <p className="text-sm">
        상태: <b>{s.collecting ? '수집 중' : '일시중지'}</b> · 미검토 카드 {candidates.length}장
      </p>
      <div className="flex gap-2">
        <button className="flex-1 rounded-md bg-black px-3 py-2 text-sm text-white" onClick={toggle}>
          {s.collecting ? '일시중지' : '수집 시작'}
        </button>
        <button
          className="flex-1 rounded-md border px-3 py-2 text-sm"
          onClick={() => browser.tabs.create({ url: browser.runtime.getURL('/review.html') })}
        >
          개인 검토함
        </button>
      </div>
    </main>
  );
}
