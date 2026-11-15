import { healthWarning } from '@/lib/extract-health';
import type { StructureWarningInfo } from './StructureWarning';
import { checkTab, useTabStatus } from './TabNotice';

/** 지금 탭의 화면 읽기가 이상하면 안내와 복사용 진단 글, 정상이거나 ChatGPT 탭이 아니면 null (TabNotice 와 같은 ping) */
export async function loadStructureWarning(): Promise<StructureWarningInfo | null> {
  const tab = await checkTab();
  return tab.kind === 'ok' ? healthWarning(tab.ping) : null;
}

// 경고도 현재 화면에 맞춰 갱신한다. 실제 빈 본문이 남으면 경고를 계속 표시한다.
export function useStructureWarning(): StructureWarningInfo | null {
  const tab = useTabStatus();
  return tab.kind === 'ok' ? healthWarning(tab.ping) : null;
}
