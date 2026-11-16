"use client";

import { useEffect, useState } from "react";
import { USE_MOCK } from "@/lib/api";
import { readAccount, type Account } from "@/lib/auth-navigation";

/** 실제 모드에서 웹 로그인 여부. 목업은 웹 로그인이 없어 늘 null (로그인 전 화면을 보인다) */
export function useSignedIn(): Account | null {
  const [account, setAccount] = useState<Account | null>(null);
  useEffect(() => {
    if (USE_MOCK) return;
    const controller = new AbortController();
    fetch("/api/onboarding", { cache: "no-store", signal: controller.signal })
      .then(async (r) => { if (r.ok) setAccount(readAccount(await r.json())); })
      .catch(() => { /* 확인하지 못하면 로그인 전 화면 그대로 */ });
    return () => controller.abort();
  }, []);
  return account;
}
