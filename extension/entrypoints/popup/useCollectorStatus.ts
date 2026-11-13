import { useEffect, useState } from 'react';
import { sendToBackground } from '@/lib/messages';
import { collectStateItem, pendingCountItem, settingsItem, type CollectState, type Settings } from '@/lib/settings';

// background 가 확장 저장소에 옮겨 둔 로컬 수집기 상태(설정 · 마지막 오류 · 검토 대기 카드 수)를 읽고 바뀌면 다시 그린다.
// 팝업을 열 때 background 에 새로 고침을 한 번 부탁한다
export function useCollectorStatus() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [collectState, setCollectState] = useState<CollectState | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    settingsItem.getValue().then(setSettings);
    collectStateItem.getValue().then(setCollectState);
    pendingCountItem.getValue().then(setPendingCount);
    const unwatch = [settingsItem.watch(setSettings), collectStateItem.watch(setCollectState), pendingCountItem.watch(setPendingCount)];
    sendToBackground({ type: 'refresh' }).catch(() => {});
    return () => unwatch.forEach((stop) => stop());
  }, []);

  return { settings, collectState, pendingCount };
}
