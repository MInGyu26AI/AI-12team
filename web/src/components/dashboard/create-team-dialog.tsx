"use client";

import { useRef, useState } from "react";
import { Check } from "lucide-react";
import { input } from "@/components/ui/surface";
import { cn } from "@/lib/utils";
import { DialogFrame, slidePrimary, slideSecondary } from "./dialog-frame";

export const ONBOARDING_SKIP_KEY = "syncup:onboarding-skipped";

/**
 * 첫 로그인 온보딩 · 새 팀 만들기 (손그림: 대시보드 위에 뜨는 팝업).
 * ① GitHub 가입(끝남) → ② 팀 만들기(여기) → ③ PC 연결(만들고 나면 PC 연결하기 슬라이드로 이어진다). 건너뛸 수 있다.
 * 팀 만들기 요청은 /start 화면과 같다: 응답이 불확실한 실패에는 같은 request_id 로 다시 보내 팀이 두 번 생기지 않게 한다
 */
export function CreateTeamDialog({ open, name, onClose, onCreated }: {
  open: boolean;
  name: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [team, setTeam] = useState("");
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<{ id: string; name: string; topic: string } | null>(null);

  const skip = () => {
    try { localStorage.setItem(ONBOARDING_SKIP_KEY, "1"); } catch { /* 저장소를 못 써도 닫기는 된다 */ }
    onClose();
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    if (!request.current) request.current = { id: crypto.randomUUID(), name: team.trim(), topic: topic.trim() };
    setRetrying(true);
    try {
      const r = await fetch("/api/onboarding/teams", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: request.current.id, name: request.current.name, topic: request.current.topic }) });
      const data = await r.json();
      if (!r.ok) {
        if (r.status === 401) location.replace("/login?next=%2Fdashboard");
        if (r.status < 500) { request.current = null; setRetrying(false); } // 거절은 팀을 만들지 않았다: 고쳐서 다시
        throw new Error(data.error);
      }
      request.current = null; setRetrying(false);
      setTeam(""); setTopic("");
      onCreated();
    } catch (e) { setError(e instanceof Error && e.message ? e.message : "팀을 만들지 못했어요. 같은 내용으로 다시 시도해 주세요."); }
    finally { setBusy(false); }
  };

  return (
    <DialogFrame
      open={open}
      onClose={skip}
      title="팀 만들기"
      labelledBy="create-team-title"
      size="large"
      bodyClassName="px-8 py-7"
      footer={
        // 슬라이드 팝업의 아래 줄처럼 구분선과 안쪽 여백을 둔다 (전에는 가장자리에 붙어 답답했다)
        <div className="flex min-h-20 shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-card-border px-8 py-4">
          <p className="text-[13px] text-ink-3">건너뛰어도 사이드바 &lsquo;이용 방법&rsquo;에서 다시 열 수 있어요</p>
          <div className="flex gap-2">
            <button type="button" className={slideSecondary} onClick={skip}>건너뛰기</button>
            <button type="submit" form="create-team-form" className={slidePrimary} disabled={busy || !team.trim() || !topic.trim()}>
              {busy ? "팀을 만들고 있어요…" : retrying ? "같은 요청 다시 확인하기" : "팀 만들고 계속하기"}
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <p aria-hidden className="title-display text-[36px] text-ink">Let&apos;s get started.</p>
        <ol aria-label="시작 단계" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
          <li className="flex items-center gap-2 text-ok"><span aria-hidden className="flex size-5 items-center justify-center bg-ok-soft"><Check className="size-3" /></span>GitHub 가입</li>
          <li aria-hidden className="h-px w-4 bg-ink/25" />
          <li aria-current="step" className="flex items-center gap-2 font-medium text-ink"><span aria-hidden className="flex size-5 items-center justify-center bg-ink font-mono text-[11px] text-white">2</span>팀 만들기</li>
          <li aria-hidden className="h-px w-4 bg-ink/25" />
          <li className="flex items-center gap-2 text-ink-3"><span aria-hidden className="flex size-5 items-center justify-center border border-ink/25 font-mono text-[11px]">3</span>PC 연결</li>
        </ol>
        <div className="space-y-1">
          <h2 id="create-team-title" className="text-xl font-bold text-ink">{name}님, 함께할 팀을 만드세요</h2>
          <p className="text-[13px] text-ink-2">팀원에게 초대받았다면 받은 초대 링크를 열어 참여하면 돼요</p>
        </div>
        {error && <p role="alert" className="bg-sensitive-soft p-3 text-sm text-sensitive">{error}</p>}
        <form id="create-team-form" onSubmit={create} className="space-y-3">
          <label className="block space-y-2 text-[13px] font-medium text-ink">팀 이름
            <input required maxLength={80} value={team} disabled={busy || retrying} onChange={(e) => setTeam(e.target.value)} className={cn(input, "mt-2 border-input")} placeholder="예: 캠퍼스 길잡이" />
          </label>
          <label className="block space-y-2 text-[13px] font-medium text-ink">프로젝트 주제
            <textarea required maxLength={1200} rows={2} value={topic} disabled={busy || retrying} onChange={(e) => setTopic(e.target.value)}
              className={cn(input, "mt-2 h-auto resize-none border-input py-2 leading-normal")} placeholder="어떤 일을 함께 하나요? 수집할 대화를 구분하는 기준이 돼요" />
          </label>
          <p className="text-xs text-ink-3">계정당 팀을 3개까지 만들 수 있어요. 팀원은 PC 연결 후 초대할 수 있어요.</p>
        </form>
      </div>
    </DialogFrame>
  );
}
