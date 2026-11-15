// 화면 뒤에 깔리는 수채화 번짐 (시안 "로즈 & 올리브 수채화"). 부모는 relative + overflow-hidden, 콘텐츠는 relative 로 위에 둔다.
// 번짐 5개: 왼쪽 위 · 오른쪽 위 · 가운데 · 왼쪽 아래 · 오른쪽 아래. 덩어리마다 0.5s 시차로 피어나고(suBloom 2.8s)
// 그다음 천천히 모양이 바뀐다(suMorph 16s). 움직임 줄이기 설정이면 번진 상태로 멈춘다 (globals.css)
const BLOBS = [
  { color: "233 166 179", style: { left: "-12%", top: "-6%", width: "62%", height: "46%" } }, // 로즈
  { color: "185 196 138", style: { right: "-14%", top: "4%", width: "58%", height: "40%" } }, // 올리브
  { color: "245 205 190", style: { left: "18%", top: "34%", width: "50%", height: "30%" } }, // 복숭아
  { color: "160 176 110", style: { left: "-8%", bottom: "2%", width: "52%", height: "34%" } }, // 진올리브
  { color: "240 190 175", style: { right: "-6%", bottom: "-4%", width: "48%", height: "32%" } }, // 연살구
] as const;

export function WatercolorBg({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}>
      {BLOBS.map((b, i) => (
        <span
          key={i}
          className="wash-blob"
          style={{
            ...b.style,
            background: `radial-gradient(closest-side, rgb(${b.color} / 0.8), rgb(${b.color} / 0.3) 60%, transparent)`,
            animationDelay: `${i * 0.5}s, ${2.8 + i * 0.5}s`,
          }}
        />
      ))}
    </div>
  );
}
