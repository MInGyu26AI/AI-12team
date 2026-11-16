"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { FileText, LogOut, User } from "lucide-react";
import { cn } from "@/lib/utils";

const item = "flex h-9 w-full items-center gap-2.5 px-3 text-left text-sm text-ink hover:bg-blush/50 focus-visible:bg-blush/50 focus-visible:outline-none [&_svg]:size-4 [&_svg]:text-ink-2";

/**
 * 헤더 오른쪽 프로필 동그라미. 누르면 마이페이지 · 서비스 소개 · 로그아웃.
 * 실제 모드만 로그아웃이 있다 (목업은 웹 로그인이 없다). 로그아웃은 LogoutButton 과 같은 요청을 보낸다
 */
export function ProfileMenu({ name, detail, myPage, canLogout }: {
  name: string;
  detail?: string; // 이름 아래 한 줄 (예: GitHub 계정, 예시 모드)
  myPage?: string; // 마이페이지 주소. 없으면 줄을 빼고 보여 준다
  canLogout: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); button.current?.focus(); } };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  const logout = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/onboarding", { method: "DELETE" });
      if (!response.ok) throw new Error("로그아웃하지 못했어요. 다시 시도해 주세요.");
      window.location.replace("/login"); // 전체 이동으로 화면에 남은 개인 카드도 지운다
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <div ref={box} className="relative">
      <button
        ref={button}
        type="button"
        aria-label="내 계정 메뉴"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex size-9 items-center justify-center rounded-full bg-blush text-sm font-medium text-ink outline-none focus-visible:ring-2 focus-visible:ring-ink",
          open && "ring-2 ring-ink ring-offset-2 ring-offset-canvas",
        )}
      >
        {name.trim().slice(0, 1) || "나"}
      </button>
      {open && (
        <div role="menu" aria-label="내 계정" className="absolute top-12 right-0 z-40 w-60 border border-card-border bg-white p-1 shadow-[0_8px_24px_rgb(29_26_20/0.08)]">
          <div className="border-b border-card-border px-3 py-3">
            <p className="truncate text-sm font-medium text-ink">{name}</p>
            {detail && <p className="mt-1 truncate font-mono text-xs text-ink-3">{detail}</p>}
          </div>
          <div className="py-1">
            {myPage && <Link role="menuitem" href={myPage} className={item} onClick={() => setOpen(false)}><User aria-hidden />마이페이지</Link>}
            <Link role="menuitem" href="/about" className={item} onClick={() => setOpen(false)}><FileText aria-hidden />서비스 소개</Link>
          </div>
          {canLogout && (
            <div className="border-t border-card-border pt-1">
              <button role="menuitem" type="button" className={item} disabled={busy} onClick={logout}>
                <LogOut aria-hidden />{busy ? "로그아웃 중…" : "로그아웃"}
              </button>
              {error && <p role="alert" className="px-3 pb-2 text-xs text-sensitive">{error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
