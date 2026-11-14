"use client";

import { use, useState } from "react";
import { toast } from "sonner";
import { JoinDone } from "@/components/join-done";
import { RegisteredTeamNotice } from "@/components/registered-team-notice";
import { buttonPrimary, card } from "@/components/ui/surface";
import { USE_MOCK } from "@/lib/api";
import { useDemoTeam } from "@/lib/team";
import { cn } from "@/lib/utils";

const COLORS = ["#cde9f4", "#eadfcf", "#e3dcf2", "#fff3a6"]; // 새 디자인 아바타 파스텔 4색 (돌려가며 배정)

export function JoinForm({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  if (USE_MOCK) return <DemoJoin code={code} />;
  return (
    <RegisteredTeamNotice title="팀 연결 확인" linkLabel="등록된 팀 확인하기" className="max-w-md py-16">
      현재 내부 시연은 관리자가 사용자와 팀 소속을 등록합니다. 초대 코드만으로 소속이나 권한을 만들지 않습니다.
    </RegisteredTeamNotice>
  );
}

// 초대 링크로 들어온 팀원 (목업 모드 전용, 이 브라우저의 목업 팀에 참여). 참여하면 피그마 Page 9 '팀 참여 완료'(318:3)를 보여 준다
function DemoJoin({ code }: { code: string }) {
  const [team, setTeam] = useDemoTeam();
  const [name, setName] = useState("");
  const [joined, setJoined] = useState<string | null>(null);

  const join = () => {
    const n = name.trim();
    if (!n) return;
    const exists = team.members.find((m) => m.name === n);
    const members = exists
      ? team.members.map((m) => (m.name === n ? { ...m, status: "joined" as const } : m))
      : [...team.members, { name: n, initial: n.slice(1, 2) || n[0]!, color: COLORS[team.members.length % COLORS.length]!, ai: "ChatGPT", status: "joined" as const }];
    setTeam({ ...team, members, me: n });
    toast.success(`${team.name}에 참여했어요`);
    setJoined(n);
  };

  if (joined) return <JoinDone team={team} me={joined} />;

  return (
    <div className="mx-auto max-w-[460px] space-y-6 px-gutter py-16">
      <div className="space-y-2 text-center">
        <p className="text-[13px] font-medium text-muted-foreground">초대 코드 {decodeURIComponent(code)}</p>
        <h1 className="text-2xl font-medium">{team.name}에 참여하기</h1>
        <p className="text-sm text-muted-foreground">{team.topic}</p>
      </div>
      <div className={cn(card, "space-y-4 rounded-2xl p-6")}>
        <label className="block space-y-2">
          <span className="text-sm font-medium">내 이름</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && join()}
            placeholder="예: 윤채원"
            className="h-[46px] w-full rounded-[10px] border border-card-border bg-white px-3.5 text-[15px] outline-none focus:border-brand"
          />
        </label>
        <button type="button" className={cn(buttonPrimary, "w-full rounded-[10px] py-[13px] text-[15px]")} disabled={!name.trim()} onClick={join}>
          팀 참여하기
        </button>
      </div>
    </div>
  );
}
