import Link from "next/link";
import { Brand } from "@/components/brand";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function LandingHeader() {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
      <div className="relative mx-auto flex h-16 max-w-wide items-center gap-4 px-gutter">
        <Brand />
        <nav className="ml-auto hidden gap-8 text-[15px] text-foreground/80 md:flex lg:absolute lg:left-1/2 lg:-translate-x-1/2">
          <Link href="/#features" className="hover:text-foreground">서비스 소개</Link>
          <Link href="/#how" className="hover:text-foreground">이용 방법</Link>
          <Link href="/install" className="hover:text-foreground">브라우저 확장</Link>
        </nav>
        <div className="ml-auto flex gap-2 md:ml-0 lg:ml-auto">
          <Link href="/collect" className={cn(buttonVariants({ variant: "outline" }), "h-9 px-3.5")}>
            로그인
          </Link>
          <Link href="/team/new" className={cn(buttonVariants(), "h-9 bg-brand px-3.5 hover:bg-brand-hover")}>
            팀 만들기
          </Link>
        </div>
      </div>
    </header>
  );
}
