"use client";

// 팀 정보 (서버 붙기 전에는 이 브라우저에만 저장). 처음에는 피그마 시안의 목업 팀.
import { MOCK_TEAM, type Team } from "@shared/mock";
import { useLocal } from "./local-store";

export const TEAM_KEY = "syncup:team:v1";

export function useTeam(): [Team, (t: Team) => void] {
  return useLocal<Team>(TEAM_KEY, MOCK_TEAM);
}

export const memberOf = (team: Team, name: string | null | undefined) =>
  team.members.find((m) => m.name === name) ?? null;

export const knownNamesOf = (team: Team) => [...new Set([team.me, ...team.members.map((m) => m.name)])];
