import type { SyncState } from '@/lib/chatgpt-sync/state';
import type { Settings } from '@/lib/settings';
import { webUrlOf } from '@/lib/web-url';
import { AutoCollectSwitch, CollectionLimits } from './CollectionControls';
import { Notice } from './Notice';
import { QueueStatus } from './QueueStatus';
import { RepoStatus, type RepoStatusInfo } from './RepoStatus';
import { StructureWarning, type StructureWarningInfo } from './StructureWarning';
import { SyncSwitch } from './SyncSwitch';
import { TabNotice } from './TabNotice';

interface MainScreenProps {
  settings: Settings;
  syncState: SyncState;
  lastError: string | null;
  pendingCount: number;
  structureWarning?: StructureWarningInfo | null; // 화면 구조 변경 감지 결과. 없으면 그리지 않는다
  repoStatus?: RepoStatusInfo | null; // GitHub 레포 상태. 없으면 그리지 않는다
  onEdit: () => void;
}

// 설정을 마친 뒤의 팝업: 수집 설정 · 프로젝트만 수집 · 분류 대기 상태 · 지금 탭 안내 · 개인 검토함 열기
export function MainScreen({ settings, syncState, lastError, pendingCount, structureWarning, repoStatus, onEdit }: MainScreenProps) {
  const webUrl = webUrlOf(settings);
  return (
    <main className="w-[340px] space-y-3 p-4 font-sans text-sm text-gray-900">
      <header className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-base font-bold">싱크업</h1>
          <p className="text-xs text-gray-500">
            {settings.teamName} · {settings.userName}
          </p>
        </div>
        <button className="text-xs text-gray-500 underline" onClick={onEdit}>
          설정 수정
        </button>
      </header>
      {settings.configured === false && (
        <Notice tone="error">등록된 팀에 접근할 수 없어요. 개인 검토함의 대화 수집 화면에서 승인 대상 팀을 확인해 주세요.</Notice>
      )}

      <AutoCollectSwitch autoCollect={settings.autoCollect} />
      <SyncSwitch sync={syncState} />
      <CollectionLimits settings={settings} />
      <QueueStatus settings={settings} pendingCount={pendingCount} syncEnabled={syncState.enabled} />
      <StructureWarning warning={structureWarning} />
      <TabNotice autoCollect={settings.autoCollect} />
      {lastError && <Notice tone="error">{lastError}</Notice>}
      <RepoStatus repo={repoStatus} />

      <div className="space-y-1">
        <button
          className="w-full rounded-lg bg-gray-900 px-3 py-2.5 font-medium text-white hover:bg-gray-800"
          onClick={() => browser.tabs.create({ url: `${webUrl}/review` })}
        >
          개인 검토함 열기{pendingCount ? ` (${pendingCount})` : ''}
        </button>
        <p className="truncate text-center text-xs text-gray-400" title={webUrl}>
          {webUrl.replace(/^https?:\/\//, '')}
        </p>
      </div>
    </main>
  );
}
