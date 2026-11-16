import Link from "next/link";

// 로고 (시안 "로즈 & 올리브 수채화"): 진갈색 사각형 + 흰 Orbitron "S" + 오른쪽 위 4각 반짝이 별. 색은 currentColor (토큰을 따른다)
export const SPARK_PATH = "M 97 14 C 99 28 102 31 114 33 C 102 35 99 38 97 52 C 95 38 92 35 80 33 C 92 31 95 28 97 14 Z";

export function LogoMark({ className = "size-10", style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 120 120" aria-hidden className={`shrink-0 text-ink ${className}`} style={style}>
      <rect width="120" height="120" rx="14" fill="currentColor" />
      <text x="54" y="88" textAnchor="middle" fill="#ffffff" style={{ fontFamily: "var(--font-brand)", fontWeight: 900, fontSize: 72 }}>
        S
      </text>
      <path d={SPARK_PATH} fill="#ffffff" />
    </svg>
  );
}

// 첫 화면용 큰 워드마크 (viewBox 820×280): 궤도 선 + Orbitron "SyncUp" + 별. orbitStyle·sparkStyle 로 첫 화면 애니메이션을 건다
export const ORBIT_PATH = "M 92 196 C 30 240, 300 262, 520 220 C 640 196, 718 140, 742 70";
export const BIG_SPARK_PATH = "M 748 18 C 752 50 760 58 792 62 C 760 66 752 74 748 106 C 744 74 736 66 704 62 C 736 58 744 50 748 18 Z";

export function BigWordmark({ className = "", orbitProps, sparkProps }: {
  className?: string;
  orbitProps?: React.SVGProps<SVGPathElement>;
  sparkProps?: React.SVGProps<SVGPathElement>;
}) {
  return (
    <svg viewBox="0 0 820 280" role="img" aria-label="SyncUp" className={`text-ink ${className}`}>
      <path d={ORBIT_PATH} fill="none" stroke="currentColor" strokeWidth="5.5" strokeLinecap="round" {...orbitProps} />
      <text x="410" y="182" textAnchor="middle" fill="currentColor" style={{ fontFamily: "var(--font-brand)", fontWeight: 900, fontSize: 128 }}>
        SyncUp
      </text>
      <path d={BIG_SPARK_PATH} fill="currentColor" style={{ transformBox: "fill-box", transformOrigin: "center" }} {...sparkProps} />
    </svg>
  );
}

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex shrink-0 items-center gap-2.5 text-ink">
      <LogoMark />
      <span className="flex flex-col gap-1">
        <span className="font-brand text-[20px] leading-none font-black tracking-[0.02em]">SyncUp</span>
        <span className="label-mono hidden text-[9.5px] leading-[1.2] text-ink-3 sm:block">Shared Memory for Students</span>
      </span>
    </Link>
  );
}
