import { cn } from "@/lib/utils";

// 실제 모드의 팀 만들기·참여 화면. 사용자와 팀 소속은 관리자가 미리 등록하므로 웹에서 만들지 않는다
export function RegisteredTeamNotice({ title, linkLabel, className, children }: {
  title: string;
  linkLabel: string;
  className: string; // 화면 폭·여백 (팀 만들기와 참여 화면이 다르다)
  children: React.ReactNode;
}) {
  return (
    <div className={cn("mx-auto space-y-4 px-gutter", className)}>
      <h1 className="text-2xl font-bold">{title}</h1>
      <p>{children}</p>
      <a href="/collect" className="underline">
        {linkLabel}
      </a>
    </div>
  );
}
