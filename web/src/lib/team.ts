"use client";
import { useEffect, useState } from 'react';
import { MOCK_TEAM, type Team } from '@shared/mock';
import type { ExtStatus } from '@shared/bridge';
import { useLocal } from './local-store';
import { USE_MOCK } from './api';
import { rpc } from './rpc';

export const TEAM_KEY = 'syncup:team:v1';
const EMPTY: Team = { code: '', name: '팀 연결 확인 중', topic: '', deadline: '', kind: '', members: [], me: '' };
export function useTeam(): [Team, (t: Team) => void] {
  const [demo, setDemo] = useLocal<Team>(TEAM_KEY, MOCK_TEAM);
  const [team, setTeam] = useState(EMPTY);
  useEffect(() => {
    if (USE_MOCK) return;
    let alive = true;
    const refresh = () => rpc<ExtStatus>('collection.status').then(s => {
      if (alive) setTeam({ ...EMPTY, name: s.teamName, me: s.userName, topic: s.projectTopic ?? '' });
    }).catch(() => { if (alive) setTeam({ ...EMPTY, name: '팀 연결 필요' }); });
    void refresh(); const timer = setInterval(refresh, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return USE_MOCK ? [demo, setDemo] : [team, () => { throw new Error('팀 구성은 관리자가 사전 등록합니다.'); }];
}
export const memberOf = (team: Team, name: string|null|undefined) => team.members.find(m => m.name === name) ?? null;
export const knownNamesOf = (team: Team) => [...new Set([team.me, ...team.members.map(m => m.name)])];
