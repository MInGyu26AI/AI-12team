import { useState } from 'react';
import { isConfigured } from '@/lib/settings';
import { MainScreen } from './MainScreen';
import { SetupForm } from './SetupForm';
import { useCollectorStatus } from './useCollectorStatus';
import { useSyncState } from './useSyncState';

// 팝업: 설정 전이거나 "설정 수정"을 누르면 설정 화면, 아니면 수집 상태 화면
export default function App() {
  const { settings, collectState, pendingCount } = useCollectorStatus();
  const syncState = useSyncState();
  const [editing, setEditing] = useState(false);
  if (!settings || !collectState || !syncState) return null;

  const configured = isConfigured(settings);
  if (!configured || editing) {
    return (
      <SetupForm
        initial={settings}
        firstTime={!configured}
        onSaved={() => setEditing(false)}
        onCancel={configured ? () => setEditing(false) : undefined}
      />
    );
  }
  return (
    <MainScreen
      settings={settings}
      syncState={syncState}
      lastError={collectState.lastError}
      pendingCount={pendingCount}
      structureWarning={null} // 갈래 6의 감지 결과가 생기면 여기에 연결 (리드)
      repoStatus={null} // GitHub 연동 데이터가 정해지면 여기에 연결 (docs/sync-contract.md 8장)
      onEdit={() => setEditing(true)}
    />
  );
}
