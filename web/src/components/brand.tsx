import Image from "next/image";
import Link from "next/link";

// 새 피그마 로고 (노드 182:6 아이콘 · 240:38 워드마크): 남색 둥근 사각형 + 흰 "S" + 작은 쉐브론, 옆에 "SyncUp" 워드마크(올라가는 밑줄)와 한 줄 소개.
// 밑줄·쉐브론 모양은 피그마가 내려 준 SVG 그대로 public/brand 에 둔다 (모양을 다시 그리지 않는다).
// 모든 치수는 피그마 px 값: 아이콘 40, 모서리 9.6, S 28px, 워드마크 88.42×29.24, 글꼴 Fredoka Bold 22px.
function LogoMark() {
  return (
    <span aria-hidden className="relative block size-10 shrink-0 rounded-[9.6px] bg-brand">
      <Image
        src="/brand/logo-chevron.svg"
        alt=""
        width={10.4}
        height={6.4}
        loading="eager"
        unoptimized
        className="absolute top-[8.8px] left-[24.8px] max-w-none"
      />
      {/* 글자 상자는 왼쪽 36px 안에 가운데 맞춤: 오른쪽 위 쉐브론 자리를 비우려고 S 가 2px 왼쪽으로 치우친다.
          top 은 피그마 값(3.2px)에서 0.8px 내렸다: 브라우저의 줄 높이 계산이 피그마와 달라 그대로 두면 S 가 1px 위로 뜬다 (피그마 렌더와 겹쳐 비교) */}
      <span className="absolute top-[4px] left-0 block h-[33.333px] w-9 text-center text-[28px] leading-[33.333px] font-medium text-white">S</span>
    </span>
  );
}

function Wordmark() {
  return (
    <span className="relative block h-[29.24px] w-[88.42px]">
      <Image
        src="/brand/wordmark-underline.svg"
        alt=""
        aria-hidden
        width={88.42}
        height={26.16}
        loading="eager"
        unoptimized
        className="absolute top-[3.08px] left-0 max-w-none"
      />
      <span className="absolute top-0 left-0 font-brand text-[22px] leading-[normal] font-bold whitespace-nowrap text-brand">SyncUp</span>
    </span>
  );
}

export function Brand({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex shrink-0 items-center gap-2.5">
      <LogoMark />
      <span className="flex flex-col gap-1">
        <Wordmark />
        <span className="hidden text-[11px] leading-[1.2] font-medium whitespace-nowrap text-muted-foreground sm:block">Shared Memory for Students</span>
      </span>
    </Link>
  );
}
