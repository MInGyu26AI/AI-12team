"use client";
import { useEffect, useState } from 'react';
import { MOCK_TEAM, type Team } from '@shared/mock';
import type { ExtStatus } from '@shared/bridge';
import { useLocal } from './local-store';
import { USE_MOCK } from './api';
import { rpc } from './rpc';

export const TEAM_KEY = 'syncup:team:v1';
const EMPTY: Team = { code: '', name: '팀 연결 확인 중', topic: '', deadline: '', kind: '', members: [], me: '' };

// useTeam 을 쓰는 화면·아바타가 몇 개든 collection.status 는 5초마다 한 번만 부른다 (구독자가 있을 때만)
let shared: Team = EMPTY;
const listeners = new Set<(t: Team) => void>();
let timer: ReturnType<typeof setInterval> | null = null;
const poll = () => rpc<ExtStatus>('collection.status')
  .then((s): Team => ({ ...EMPTY, name: s.teamName, me: s.userName, topic: s.projectTopic ?? '' }), (): Team => ({ ...EMPTY, name: '팀 연결 필요' }))
  .then(t => { shared = t; listeners.forEach(l => l(t)); });
function subscribe(listener: (t: Team) => void) {
  listeners.add(listener);
  if (!timer) { void poll(); timer = setInterval(poll, 5000); }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) { clearInterval(timer); timer = null; }
  };
}

export function useTeam(): [Team, (t: Team) => void] {
  const [demo, setDemo] = useLocal<Team>(TEAM_KEY, MOCK_TEAM);
  const [team, setTeam] = useState(shared);
  useEffect(() => (USE_MOCK ? undefined : subscribe(setTeam)), []);
  return USE_MOCK ? [demo, setDemo] : [team, () => { throw new Error('팀 구성은 관리자가 사전 등록합니다.'); }];
}
export const memberOf = (team: Team, name: string|null|undefined) => team.members.find(m => m.name === name) ?? null;
export const knownNamesOf = (team: Team) => [...new Set([team.me, ...team.members.map(m => m.name)])];
