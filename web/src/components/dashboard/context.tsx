"use client";

import { createContext, useContext } from "react";
import type { Account } from "@/lib/auth-navigation";

/** 이 PC 연결 상태. off 는 확장 없음·수집기 꺼짐·다른 계정·팀 미선택을 모두 담고, 안내 문장을 함께 준다 */
export type PcState = { kind: "checking" } | { kind: "ok" } | { kind: "off"; message: string };

export type DashboardState = {
  account: Account | null; // 실제 모드의 로그인 계정. 목업·로컬 브리지는 null
  pc: PcState;
  recheck: () => void; // 로그인과 PC 연결을 다시 확인
  openInstall: () => void; // PC 연결하기 슬라이드
  openFlow: () => void; // 이용 방법(유저 플로우) 슬라이드
  openCreateTeam: () => void; // 팀 만들기 (실제 모드: 온보딩 팝업, 목업: /team/new)
};

const noop = () => {};
export const DashboardContext = createContext<DashboardState>({
  account: null,
  pc: { kind: "checking" },
  recheck: noop,
  openInstall: noop,
  openFlow: noop,
  openCreateTeam: noop,
});

export const useDashboard = () => useContext(DashboardContext);
