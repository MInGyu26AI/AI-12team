"use client";

import { useState } from "react";
import { buttonOutline } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

export function LogoutButton({ className }: { className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <span className="inline-flex flex-col gap-1">
    <button type="button" className={cn(buttonOutline, className)} disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try {
        const response = await fetch("/api/onboarding", { method: "DELETE" });
        if (!response.ok) throw new Error("로그아웃하지 못했어요. 다시 시도해 주세요.");
        // A full navigation clears in-memory personal cards as well as the web session cookie.
        window.location.replace("/login");
      } catch (e) { setError((e as Error).message); setBusy(false); }
    }}>{busy ? "로그아웃 중…" : "로그아웃"}</button>
    {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
  </span>;
}
