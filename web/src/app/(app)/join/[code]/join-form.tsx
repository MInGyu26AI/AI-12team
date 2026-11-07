"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useTeam } from "@/lib/team";
import { useExtensionBridge } from "@/lib/use-extension-bridge";

const COLORS = ["#4F46E5", "#3B9AE1", "#C2407A", "#3F9D52", "#D9670B", "#7E22CE"];

// 초대 링크로 들어온 팀원 (서버 붙기 전에는 이 브라우저의 목업 팀에 참여)
export function JoinForm({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const router = useRouter();
  const [team, setTeam] = useTeam();
  const ext = useExtensionBridge();
  const [name, setName] = useState("");

  const join = () => {
    const n = name.trim();
    if (!n) return;
    const exists = team.members.find((m) => m.name === n);
    const members = exists
      ? team.members.map((m) => (m.name === n ? { ...m, status: "joined" as const } : m))
      : [...team.members, { name: n, initial: n.slice(1, 2) || n[0]!, color: COLORS[team.members.length % COLORS.length]!, ai: "ChatGPT", status: "joined" as const }];
    setTeam({ ...team, members, me: n });
    if (ext.available) ext.updateSettings({ teamName: team.name, projectTopic: team.topic, userName: n });
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
