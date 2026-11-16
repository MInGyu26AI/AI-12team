"use client";

import { useState } from "react";
import { DialogFrame, slidePrimary, slideSecondary } from "@/components/dashboard/dialog-frame";
import { input } from "@/components/ui/surface";
import { confirmsName } from "@/lib/profile";
import { cn } from "@/lib/utils";

export const WITHDRAW_POINTS = [
  "계정·프로필 사진·내 정보가 지워져요",
  "내가 승인해 올린 카드는 팀 기록에 남고, 이름만 '탈퇴한 팀원'으로 바뀌어요",
  "나 혼자 있는 팀은 함께 지워져요",
  "이 PC의 연결 키도 끊겨요",
  "이미 GitHub 레포·노션에 반영된 내용은 그곳에 남아요",
];

/** 회원 탈퇴 확인 팝업. 지금 이름을 그대로 입력해야 탈퇴하기가 켜진다. 성공하면 onDone 이 첫 화면으로 보낸다 */
export function WithdrawDialog({ open, name, onClose, onWithdraw, onDone }: {
  open: boolean;
  name: string;
  onClose: () => void;
  onWithdraw: (confirm: string) => Promise<void>;
  onDone: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ok = confirmsName(typed, name);

  const close = () => { if (busy) return; setTyped(""); setError(""); onClose(); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ok || busy) return;
    setBusy(true); setError("");
    try { await onWithdraw(typed.trim()); onDone(); }
    catch (e) { setError((e as Error).message || "탈퇴하지 못했어요. 잠시 뒤 다시 시도해 주세요."); setBusy(false); }
  };

  return (
    <DialogFrame
      open={open}
      onClose={close}
      title="회원 탈퇴"
      labelledBy="withdraw-title"
      bodyClassName="px-8 py-6"
      footer={
        <div className="flex h-[72px] shrink-0 items-center justify-end gap-2 border-t border-card-border px-8">
          <button type="button" className={slideSecondary} onClick={close} disabled={busy}>취소</button>
          <button type="submit" form="withdraw-form" className={slidePrimary} disabled={!ok || busy}>{busy ? "탈퇴하는 중…" : "탈퇴하기"}</button>
        </div>
      }
    >
      <h2 id="withdraw-title" className="text-xl font-bold text-ink">정말 탈퇴할까요?</h2>
      <ul className="list-disc space-y-1 pl-5 text-[13px] leading-[1.7] text-ink-body">
        {WITHDRAW_POINTS.map((point) => <li key={point}>{point}</li>)}
      </ul>
      <p className="text-[13px] font-medium text-ink">되돌릴 수 없어요.</p>
      <form id="withdraw-form" onSubmit={submit} className="space-y-2">
        <label className="block text-[13px] font-medium text-ink">
          확인을 위해 지금 이름을 그대로 입력해 주세요: <span className="font-bold">{name}</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy} autoComplete="off" spellCheck={false}
            className={cn(input, "mt-2 h-11 border-input")} />
        </label>
        {error && <p role="alert" className="bg-sensitive-soft p-3 text-sm text-sensitive">{error}</p>}
      </form>
    </DialogFrame>
  );
}
