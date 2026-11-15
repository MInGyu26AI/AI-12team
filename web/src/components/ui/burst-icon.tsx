// 초신성(burst) 모양: 첫 화면 별의 일생 마지막 단계, 충돌 배너·승인 전 미리 알림 아이콘에 같이 쓴다. 색은 currentColor
export const BURST_PATH =
  "M50 2 C54 34 60 40 72 44 C80 34 88 22 96 10 C84 26 76 40 70 50 C80 54 90 54 98 54 C88 56 78 58 70 60 C76 70 84 80 92 92 C80 82 68 72 58 66 C56 76 52 88 50 98 C48 88 44 76 42 66 C32 72 20 82 8 92 C16 80 24 70 30 60 C22 58 12 56 2 54 C10 54 20 54 30 50 C24 40 16 26 4 10 C12 22 20 34 28 44 C40 40 46 34 50 2 Z";

export function BurstIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden className={`shrink-0 ${className}`}>
      <path d={BURST_PATH} fill="currentColor" />
    </svg>
  );
}
