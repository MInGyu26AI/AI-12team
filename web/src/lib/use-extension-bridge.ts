"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { ExtSettingsPatch, ExtStatus, PrivacyList } from '@shared/bridge';
import type { RelatedCard } from '@shared/types';
import { rpc } from './rpc';
import { USE_MOCK } from './api';

export function useExtensionBridge() {
  const [state, setState] = useState({ available: false, checked: false, cards: [] as RelatedCard[], userName: null as string|null, status: null as ExtStatus|null, error: null as string|null });
  const [privacy, setPrivacy] = useState({ list: null as PrivacyList|null, error: null as string|null });
  // Only the newest refresh may update the screen, so a late answer (e.g. from before a team switch) is dropped.
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (USE_MOCK) { setState(s => ({ ...s, checked: true })); return; }
    const mine = ++generation.current;
    try {
      const result = await rpc<{cards: RelatedCard[]; status: ExtStatus}>('candidates.list');
      if (mine !== generation.current) return;
      setState({ ...result, available: true, checked: true, userName: result.status.userName, error: null });
      try {
        const list = await rpc<PrivacyList>('privacy.list');
        if (mine !== generation.current) return;
        if (list.teamId === result.status.teamId) setPrivacy({ list, error: null });
      } catch (error) {
        // Keep the last list on screen and show the failure; an empty list would hide held items.
        if (mine === generation.current) setPrivacy(p => ({ ...p, error: (error as Error).message }));
      }
    } catch (error) {
      if (mine === generation.current) setState(s => ({ ...s, available: false, checked: true, error: (error as Error).message }));
    }
  }, []);
  useEffect(() => { void refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer); }, [refresh]);
  const action = useCallback(async (method: string, params: Record<string,unknown> = {}) => {
    if (USE_MOCK) { toast.info('예시 모드에서는 실제 수집기에 요청하지 않습니다.'); return; }
    try { await rpc(method, params); await refresh(); } catch (error) { toast.error((error as Error).message); }
  }, [refresh]);
  // Privacy actions return the server answer or throw, so a failure is never shown as success.
  // {queued:true} only means the batch is checked again on the next run, not that the check finished.
  const privacyAction = useCallback(async (method: 'privacy.recheck'|'privacy.exclude', params: { id: string; teamId: string; messageId?: string }) => {
    const result = await rpc<{queued: boolean}>(method, params);
    await refresh();
    return result;
  }, [refresh]);
  const remove = useCallback(async (ids: string[], reason: 'approved'|'dismissed') => {
    if (reason === 'dismissed') for (const id of ids) await action('candidates.dismiss', { id });
    await refresh();
  }, [action, refresh]);
  const updateSettings = useCallback((patch: ExtSettingsPatch) => action('collection.configure', patch as Record<string,unknown>), [action]);
  const flush = useCallback(() => action('collection.flush'), [action]);
  const teamId = state.status?.teamId;
  return { ...state, privacy: { list: privacy.list && privacy.list.teamId === teamId ? privacy.list : null, error: privacy.error },
           refresh, action, privacyAction, remove, updateSettings, flush };
}
