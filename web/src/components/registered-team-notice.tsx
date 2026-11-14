import Link from "next/link";
import { buttonPrimary, card } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

// 실제 모드의 팀 만들기·참여 화면. 사용자와 팀 소속은 관리자가 미리 등록하므로 웹에서 만들지 않는다.
// 새 피그마의 흰 카드(로그인·참여 완료 카드와 같은 모양)로 안내만 한다
export function RegisteredTeamNotice({ title, linkLabel, className, children }: {
  title: string;
  linkLabel: string;
  className: string; // 화면 폭·여백 (팀 만들기와 참여 화면이 다르다)
  children: React.ReactNode;
}) {
  return (
    <div className={cn("mx-auto px-gutter", className)}>
      <section className={cn(card, "space-y-4 rounded-2xl p-6 sm:p-10")}>
        <h1 className="text-2xl font-medium">{title}</h1>
        <p className="text-sm leading-[1.6] text-muted-foreground break-keep">{children}</p>
        <Link href="/collect" className={buttonPrimary}>
          {linkLabel}
        </Link>
      </section>
    </div>
  );
}
