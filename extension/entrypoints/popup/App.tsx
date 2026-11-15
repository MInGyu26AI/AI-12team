import { useState } from 'react';
import { isConfigured } from '@/lib/settings';
import { MainScreen } from './MainScreen';
import { SetupForm } from './SetupForm';
import { useCollectorStatus } from './useCollectorStatus';
import { useRepoStatus } from './useRepoStatus';
import { useStructureWarning } from './useStructureWarning';
import { useSyncState } from './useSyncState';

// 팝업: 설정 전이거나 "설정 수정"을 누르면 설정 화면, 아니면 수집 상태 화면
export default function App() {
  const { settings, collectState, pendingCount, preAlerts } = useCollectorStatus();
  const syncState = useSyncState();
  const structureWarning = useStructureWarning();
  const repoStatus = useRepoStatus();
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
      preAlerts={preAlerts}
      structureWarning={structureWarning} // 지금 탭의 화면 읽기 점검 결과 (lib/extract-health.ts)
      repoStatus={repoStatus} // 로컬 수집기 team.repo 로 읽은 레포 저장 상태 (useRepoStatus.ts)
      onEdit={() => setEditing(true)}
    />
  );
}
