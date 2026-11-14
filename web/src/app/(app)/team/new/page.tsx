"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { cleanCriteria, rulesFromText } from "@shared/criteria";
import { TEAM_KINDS } from "@shared/mock";
import { Avatar } from "@/components/avatar";
import { RegisteredTeamNotice } from "@/components/registered-team-notice";
import { Button } from "@/components/ui/button";
import { USE_MOCK } from "@/lib/api";
import { useDemoTeam } from "@/lib/team";
import { cn } from "@/lib/utils";

export default function NewTeamPage() {
  if (USE_MOCK) return <NewTeamForm />;
  return (
    <RegisteredTeamNotice title="등록된 팀으로 연결" linkLabel="팀 연결 확인하기" className="max-w-content py-10">
      현재 내부 시연은 관리자가 미리 등록한 사용자와 팀으로 연결합니다. 수집 화면에서 소속 팀을 선택하세요.
    </RegisteredTeamNotice>
  );
}

// 피그마 2번: 새 팀 만들기 (목업 모드 전용, 이 브라우저에 저장)
function NewTeamForm() {
  const router = useRouter();
  const [team, setTeam] = useDemoTeam();
  const [form, setForm] = useState({
    name: team.name,
    topic: team.topic,
    deadline: team.deadline,
    kind: team.kind,
    goal: team.criteria?.teamGoal ?? "",
    scope: team.criteria?.teamScope ?? "",
    rules: (team.criteria?.teamRules ?? []).join("\n"),
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  // 서버 렌더링 땐 주소를 모르므로 빈 값 → 브라우저에서 채움 (hydration 불일치 방지)
  const host = useSyncExternalStore(noop, () => window.location.host, () => "");
  const inviteUrl = `${host}/join/${team.code}`;
  const valid = form.name.trim() && form.topic.trim();

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/join/${team.code}`);
      toast.success("초대 링크를 복사했어요. 카카오톡·디스코드에 붙여넣으세요");
    } catch {
      toast.error("복사에 실패했어요");
    }
  };

  const create = () => {
    if (!valid) return;
    const criteria = cleanCriteria({ teamGoal: form.goal, teamScope: form.scope, teamRules: rulesFromText(form.rules) });
    setTeam({ ...team, name: form.name.trim(), topic: form.topic.trim(), deadline: form.deadline, kind: form.kind, criteria });
    toast.success("팀을 만들었어요");
    router.push("/collect");
  };

  return (
    <div className="mx-auto max-w-content space-y-6 px-gutter py-10">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">새 팀 만들기</h1>
        <p className="text-muted-foreground break-keep">
          팀플이 시작되면 팀을 만들고 팀원을 초대하세요. 프로젝트 주제와 마감일은 AI가 대화를 분류하고 충돌을 찾는 기준이 돼요.
        </p>
      </div>

      <section className="space-y-5 rounded-xl border bg-card p-6">
        <h2 className="font-semibold">팀 정보</h2>
        <Field label="팀 이름">
          <input value={form.name} onChange={set("name")} className={inputCls} placeholder="예: AI 해커톤 12팀" />
        </Field>
        <Field label="프로젝트 주제" hint="이 주제와 관련된 내용만 내 승인함에 후보로 보여 줘요.">
          <input value={form.topic} onChange={set("topic")} className={inputCls} placeholder="예: 대학생 팀용 AI 결정 기록 서비스" />
        </Field>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="마감일">
            <input type="date" value={form.deadline} onChange={set("deadline")} className={inputCls} />
          </Field>
          <Field label="팀 종류">
            <select value={form.kind} onChange={set("kind")} className={inputCls}>
              {TEAM_KINDS.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </Field>
        </div>
      </section>

      <section className="space-y-5 rounded-xl border bg-card p-6">
        <div className="space-y-1">
          <h2 className="font-semibold">팀 목표·범위·규칙 <span className="text-sm font-normal text-muted-foreground">(선택)</span></h2>
          <p className="text-sm text-muted-foreground break-keep">팀 결정 기록 맨 위에 고정되고, AI가 프로젝트 대화를 고르는 기준이 돼요.</p>
        </div>
        <Field label="팀 목표">
          <input value={form.goal} onChange={set("goal")} className={inputCls} placeholder="예: 11/16까지 시연 가능한 MVP 제출" />
        </Field>
        <Field label="범위">
          <input value={form.scope} onChange={set("scope")} className={inputCls} placeholder="예: ChatGPT 웹 수집 + 팀 보드까지, 결제는 제외" />
        </Field>
        <Field label="규칙" hint="한 줄에 하나씩 적어 주세요.">
          <textarea
            value={form.rules}
            onChange={set("rules")}
            rows={3}
            className={cn(inputCls, "h-auto py-2.5")}
            placeholder={"예: 결정은 팀장 승인 후 확정\n개인 일정·연락처는 올리지 않기"}
          />
        </Field>
      </section>

      <section className="space-y-4 rounded-xl border bg-card p-6">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">팀원 초대</h2>
          <span className="rounded-full bg-brand-soft px-2.5 py-1 text-xs font-semibold text-brand">초대 코드 {team.code}</span>
        </div>
        <div className="flex gap-2">
          <input readOnly value={inviteUrl} className={cn(inputCls, "bg-muted/60 text-muted-foreground")} aria-label="초대 링크" />
          <Button variant="outline" className="h-11 shrink-0 px-4" onClick={copyLink}>
            <Copy />
            링크 복사
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">카카오톡이나 디스코드에 링크를 보내면 팀원이 바로 참여할 수 있어요.</p>
        <ul className="divide-y">
          {team.members.map((m) => (
            <li key={m.name} className="flex flex-wrap items-center gap-3 py-3">
              <Avatar name={m.name} />
              <span className="font-medium">{m.name}</span>
              {m.leader && <span className="rounded-full bg-tag-todo-soft px-2 py-0.5 text-xs font-semibold text-tag-todo">팀장</span>}
              <span className="ml-auto rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">주로 쓰는 AI · {m.ai}</span>
              <span
                className={cn(
                  "w-16 text-center text-xs font-semibold",
                  m.status === "joined" ? "rounded-full bg-ok-soft py-1 text-ok" : "text-muted-foreground",
                )}
              >
                {m.status === "joined" ? "참여함" : "초대 대기"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="flex justify-end gap-2">
        <Button variant="outline" className="h-11 px-5" onClick={() => router.push("/")}>
          취소
        </Button>
        <Button className="h-11 bg-brand px-5 hover:bg-brand-hover" disabled={!valid} onClick={create}>
          팀 만들고 시작하기
        </Button>
      </div>
    </div>
  );
}

const noop = () => () => {};

const inputCls =
  "h-11 w-full rounded-lg border bg-background px-3.5 text-[15px] outline-none focus:border-brand focus:ring-3 focus:ring-brand/15";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-semibold">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
