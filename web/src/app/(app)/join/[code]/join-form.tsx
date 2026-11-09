"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RegisteredTeamNotice } from "@/components/registered-team-notice";
import { Button } from "@/components/ui/button";
import { USE_MOCK } from "@/lib/api";
import { useDemoTeam } from "@/lib/team";

const COLORS = ["#4F46E5", "#3B9AE1", "#C2407A", "#3F9D52", "#D9670B", "#7E22CE"];

export function JoinForm({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  if (USE_MOCK) return <DemoJoin code={code} />;
  return (
    <RegisteredTeamNotice title="팀 연결 확인" linkLabel="등록된 팀 확인하기" className="max-w-md py-16">
      현재 내부 시연은 관리자가 사용자와 팀 소속을 등록합니다. 초대 코드만으로 소속이나 권한을 만들지 않습니다.
    </RegisteredTeamNotice>
  );
}

// 초대 링크로 들어온 팀원 (목업 모드 전용, 이 브라우저의 목업 팀에 참여)
function DemoJoin({ code }: { code: string }) {
  const router = useRouter();
  const [team, setTeam] = useDemoTeam();
  const [name, setName] = useState("");

  const join = () => {
    const n = name.trim();
    if (!n) return;
    const exists = team.members.find((m) => m.name === n);
    const members = exists
      ? team.members.map((m) => (m.name === n ? { ...m, status: "joined" as const } : m))
      : [...team.members, { name: n, initial: n.slice(1, 2) || n[0]!, color: COLORS[team.members.length % COLORS.length]!, ai: "ChatGPT", status: "joined" as const }];
    setTeam({ ...team, members, me: n });
    toast.success(`${team.name}에 참여했어요`);
    router.push("/collect");
  };

  return (
    <div className="mx-auto max-w-md space-y-6 px-gutter py-16">
      <div className="space-y-2 text-center">
        <p className="text-sm font-semibold text-brand">초대 코드 {decodeURIComponent(code)}</p>
        <h1 className="text-2xl font-bold">{team.name}에 참여하기</h1>
        <p className="text-sm text-muted-foreground">{team.topic}</p>
      </div>
      <div className="space-y-3 rounded-xl border bg-card p-6">
        <label className="block space-y-2">
          <span className="text-sm font-semibold">내 이름</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && join()}
            placeholder="예: 정하린"
            className="h-11 w-full rounded-lg border bg-background px-3.5 outline-none focus:border-brand"
          />
        </label>
        <Button className="h-11 w-full bg-brand hover:bg-brand-hover" disabled={!name.trim()} onClick={join}>
          팀 참여하기
        </Button>
      </div>
    </div>
  );
}
