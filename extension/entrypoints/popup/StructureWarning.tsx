import { useState } from 'react';

// 화면 구조 변경 감지 결과 (갈래 6의 extract-health). 연결 전까지는 값이 없어 아무것도 그리지 않는다.
// message = 사용자에게 보일 안내, diagnostics = 복사해서 전달할 진단 글(전략별 개수 등, 대화 내용은 없음)
export interface StructureWarningInfo {
  message: string;
  diagnostics?: string;
}

export function StructureWarning({ warning }: { warning: StructureWarningInfo | null | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!warning) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(warning.diagnostics ?? '');
      setCopied(true);
    } catch {
      alert('복사하지 못했어요');
    }
  };

  return (
    <div className="space-y-1.5 rounded-lg bg-sensitive-soft px-3 py-2 text-xs text-sensitive">
      <p>{warning.message}</p>
      {warning.diagnostics && (
        <button type="button" className="rounded-md border bg-white px-2 py-0.5 text-gray-700" onClick={() => void copy()}>
          {copied ? '복사했어요' : '진단 복사'}
        </button>
      )}
    </div>
  );
}
