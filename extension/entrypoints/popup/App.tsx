import { useState } from 'react';
import { isConfigured } from '@/lib/settings';
import { MainScreen } from './MainScreen';
import { SetupForm } from './SetupForm';
import { useCollectorStatus } from './useCollectorStatus';

// 팝업: 설정 전이거나 "설정 수정"을 누르면 설정 화면, 아니면 수집 상태 화면
export default function App() {
  const { settings, collectState, pendingCount } = useCollectorStatus();
  const [editing, setEditing] = useState(false);
  if (!settings || !collectState) return null;

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
  return <MainScreen settings={settings} lastError={collectState.lastError} pendingCount={pendingCount} onEdit={() => setEditing(true)} />;
}
