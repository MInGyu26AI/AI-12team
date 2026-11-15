import Link from "next/link";
import { Brand } from "@/components/brand";

// 로그인 화면 (피그마 Page 9 · 300:2): 헤더는 로고와 오른쪽 '로그인'(현재 화면 · 2px 밑줄)만 둔다
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-canvas">
      <header className="border-b bg-canvas">
        <div className="mx-auto flex h-16 max-w-wide items-center justify-between px-gutter md:px-8">
          <Brand />
          <Link href="/login" aria-current="page" className="flex flex-col items-center gap-1 text-sm leading-[1.5] font-medium text-brand">
            로그인
            <span aria-hidden className="h-0.5 w-full bg-brand" />
          </Link>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
