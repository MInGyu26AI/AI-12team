import { useEffect, useState } from 'react';
import { healthWarning } from '@/lib/extract-health';
import type { StructureWarningInfo } from './StructureWarning';
import { checkTab } from './TabNotice';

/** 지금 탭의 화면 읽기가 이상하면 안내와 복사용 진단 글, 정상이거나 ChatGPT 탭이 아니면 null (TabNotice 와 같은 ping) */
export async function loadStructureWarning(): Promise<StructureWarningInfo | null> {
  const tab = await checkTab();
  return tab.kind === 'ok' ? healthWarning(tab.ping) : null;
}

// 팝업을 열 때 한 번 점검한다. 배지 `!` 는 30초 점검 뒤에 걸리지만 팝업은 연 순간의 화면으로 바로 판정한다
export function useStructureWarning(): StructureWarningInfo | null {
  const [warning, setWarning] = useState<StructureWarningInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadStructureWarning().then((found) => {
      if (!cancelled) setWarning(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return warning;
}
