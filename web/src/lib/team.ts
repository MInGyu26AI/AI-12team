"use client";
import { MOCK_TEAM, type Team } from "@shared/mock";
import { useLocal } from "./browser-store";
import { USE_MOCK } from "./api";
import { useCollectorStatus } from "./local-collector";

const TEAM_KEY = "syncup:team:v1";
const EMPTY: Team = { code: "", name: "팀 연결 확인 중", topic: "", deadline: "", kind: "", members: [], me: "" };

/** 지금 팀. 목업 모드는 이 브라우저에 저장한 예시 팀, 실제 모드는 로컬 수집기가 알려 준 등록된 팀 */
export function useTeam(): Team {
  const [demo] = useLocal<Team>(TEAM_KEY, MOCK_TEAM);
  const { status, available, checked } = useCollectorStatus();
  if (USE_MOCK) return demo;
  if (!checked) return EMPTY;
  if (!available || !status) return { ...EMPTY, name: "팀 연결 필요" };
  return { ...EMPTY, name: status.teamName, me: status.userName, topic: status.projectTopic ?? "" };
}

/** 목업 모드의 팀 만들기·참여 화면 전용. 실제 모드의 팀 구성은 관리자가 미리 등록한다 */
export const useDemoTeam = () => useLocal<Team>(TEAM_KEY, MOCK_TEAM);

export const memberOf = (team: Team, name: string | null | undefined) => team.members.find((m) => m.name === name) ?? null;
export const knownNamesOf = (team: Team) => [...new Set([team.me, ...team.members.map((m) => m.name)])];
