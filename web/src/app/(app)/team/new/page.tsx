"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { TEAM_KINDS } from "@shared/mock";
import { Avatar } from "@/components/avatar";
import { InvitePanel } from "@/components/invite-panel";
import { PageTitle, EnTitle } from "@/components/page-title";
import { RegisteredTeamNotice } from "@/components/registered-team-notice";
import { RepoLinkForm, isRepoUrl, type RepoCheck } from "@/components/repo-link-form";
import { buttonOutline, buttonPrimary, card, chip } from "@/components/ui/surface";
import { USE_MOCK } from "@/lib/api";
import { useDemoTeam } from "@/lib/team";
import { cn } from "@/lib/utils";

export default function NewTeamPage() {
  if (USE_MOCK) return <NewTeamForm />;
  return (
    <div className="mx-auto max-w-content space-y-6 py-10">
      <RegisteredTeamNotice title="팀원 초대" linkLabel="대화 수집으로 가기" className="">
        새 팀은 GitHub로 로그인해 직접 만들 수 있어요. 이미 연결된 팀에는 아래 초대 링크로 팀원을 초대하세요.
      </RegisteredTeamNotice>
      <div className="px-gutter"><Link href="/start" className="font-semibold text-brand underline">새 팀 만들기 / GitHub 로그인</Link></div>
      <div className="px-gutter">
        <InvitePanel />
      </div>
    </div>
  );
}

// 피그마 2번: 새 팀 만들기 (152:2) → '다음' → 2-2 GitHub 레포 연결 단계 (174:47, 선택). 목업 모드 전용, 이 브라우저에 저장
function NewTeamForm() {
  const router = useRouter();
  const [team, setTeam] = useDemoTeam();
  const [step, setStep] = useState<1 | 2>(1);
  const [form, setForm] = useState({
    name: team.name,
    topic: team.topic,
    deadline: team.deadline,
    kind: team.kind,
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

  const create = (message = "팀을 만들었어요") => {
    if (!valid) return;
    setTeam({ ...team, name: form.name.trim(), topic: form.topic.trim(), deadline: form.deadline, kind: form.kind });
    toast.success("팀을 만들었어요");
    router.push("/collect");
  };

  if (step === 2) return <RepoStep onBack={() => setStep(1)} onSkip={() => create()} onDone={() => create("팀을 만들었어요. 예시 모드라 레포 연결은 저장하지 않았어요")} />;

  return (
    <div className="mx-auto max-w-[760px] space-y-5 px-gutter py-10">
      <PageTitle display="Start a team." title="새 팀 만들기">
        팀플이 시작되면 팀을 만들고 팀원을 초대하세요. 프로젝트 주제와 마감일은 AI가 대화를 분류하고 충돌을 찾는 기준이 돼요.
      </PageTitle>

      <section className={cn(card, "space-y-4 p-6")}>
        <h2 className="text-base font-bold">팀 정보</h2>
        <Field label="팀 이름">
          <input value={form.name} onChange={set("name")} className={inputCls} placeholder="예: AI 해커톤 12팀" />
        </Field>
        <Field label="프로젝트 주제" hint="AI가 이 주제와 관련된 대화만 팀 결정 후보로 골라요.">
          <input value={form.topic} onChange={set("topic")} className={inputCls} placeholder="예: 대학생 팀용 AI 결정 기록 서비스" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
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

      <section className="space-y-4 rounded-xl border bg-card p-6">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-bold">팀원 초대</h2>
          <span className={cn(chip, "bg-brand-soft")}>초대 코드 {team.code}</span>
        </div>
        <div className="flex gap-2.5">
          <input readOnly value={inviteUrl} className={cn(inputCls, "bg-brand-soft/60 text-muted-foreground")} aria-label="초대 링크" />
          <button type="button" className={cn(buttonOutline, "h-[46px] rounded-[10px] px-4 py-0")} onClick={copyLink}>
            <Copy />
            링크 복사
          </button>
        </div>
        <p className="text-xs text-muted-foreground">카카오톡이나 디스코드에 링크를 보내면 팀원이 바로 참여할 수 있어요.</p>
        <ul>
          {team.members.map((m, i) => (
            <li key={m.name} className={cn("flex flex-wrap items-center gap-3 py-3", i > 0 && "border-t border-card-border")}>
              <Avatar name={m.name} className="size-7 text-xs" />
              <span className="text-[15px] font-medium">{m.name}</span>
              {m.leader && <span className={cn(chip, "bg-tag-todo-soft text-tag-todo")}>팀장</span>}
              <span className={cn(chip, "ml-auto bg-brand-soft text-muted-foreground")}>주로 쓰는 AI · {m.ai}</span>
              <span className={cn("w-16 text-center text-xs font-medium", m.status === "joined" ? cn(chip, "justify-center bg-ok-soft text-ok") : "text-muted-foreground")}>
                {m.status === "joined" ? "참여함" : "초대 대기"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="flex justify-end gap-2.5">
        <button type="button" className={buttonOutline} onClick={() => router.push("/")}>
          취소
        </button>
        <button type="button" className={buttonPrimary} disabled={!valid} onClick={() => setStep(2)}>
          다음
        </button>
      </div>
    </div>
  );
}

// 2-2 레포 연결 단계 (선택). 목업 모드에는 팀 서버가 없어 주소 형식만 확인하고, 연결은 저장하지 않는다고 그대로 알린다
function RepoStep({ onBack, onSkip, onDone }: { onBack: () => void; onSkip: () => void; onDone: () => void }) {
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [check, setCheck] = useState<RepoCheck>({ state: "idle" });
  const verify = () =>
    setCheck(
      isRepoUrl(url)
        ? { state: "info", detail: "주소 형식이 맞아요. 예시 모드에는 팀 서버가 없어서 실제 권한 확인과 저장은 하지 않아요." }
        : { state: "error", label: "주소 확인", detail: "github.com/소유자/레포 형식으로 적어 주세요" },
    );
  return (
    <div className="mx-auto max-w-[720px] space-y-5 px-gutter py-10">
      <div className="space-y-1.5">
        <button type="button" onClick={onBack} className="text-[13px] text-muted-foreground hover:text-foreground">
          새 팀 만들기 · 2/2 단계 (선택)
        </button>
        <EnTitle>Link your repo.</EnTitle><h1 className="text-2xl font-bold sm:text-[28px]">GitHub 레포도 연결할까요?</h1>
        <p className="text-[13px] text-muted-foreground break-keep">
          연결하면 팀이 승인한 결정과 할 일이 레포의 SYNCUP.md에도 저장돼요. 나중에 팀 결정 기록에서 연결해도 돼요.
        </p>
      </div>
      <RepoLinkForm
        url={url}
        branch={branch}
        check={check}
        onUrlChange={(v) => (setUrl(v), setCheck({ state: "idle" }))}
        onBranchChange={setBranch}
        onVerify={verify}
        footer={
          <div className="ml-auto flex gap-2.5">
            <button type="button" className={cn(buttonOutline, "h-[42px] py-0")} onClick={onSkip}>
              나중에 할게요
            </button>
            <button type="button" className={cn(buttonPrimary, "h-[42px] py-0")} disabled={!isRepoUrl(url)} onClick={onDone}>
              연결하고 팀 만들기 완료
            </button>
          </div>
        }
      />
    </div>
  );
}

const noop = () => () => {};

// 피그마 2번 입력창: 높이 46 · 모서리 10 · 테두리 #e2d6c3 · 글자 15px
const inputCls =
  "h-[46px] w-full rounded-[10px] border border-card-border bg-white px-3.5 text-[15px] outline-none focus:border-brand focus:ring-3 focus:ring-brand/15";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}
