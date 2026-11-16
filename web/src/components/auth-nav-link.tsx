"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 인증 화면 헤더 오른쪽의 현재 화면 표시. 로그인 화면에서만 '로그인'(2px 밑줄)을 보이고,
// 가입 동의 같은 다른 화면에서는 로고만 둔다 (그 화면에서 '로그인'이 현재 쪽으로 표시되면 안 된다)
export function AuthNavLink() {
  if (usePathname() !== "/login") return null;
  return (
    <Link href="/login" aria-current="page" className="flex flex-col items-center gap-1 text-sm leading-[1.5] font-medium text-brand">
      로그인
      <span aria-hidden className="h-0.5 w-full bg-brand" />
    </Link>
  );
}
