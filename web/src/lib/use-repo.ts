"use client";
// 팀 상태 파일의 GitHub 저장 상태(로컬 수집기 RPC team.repo)와 레포의 syncup.json.
// 상태는 REPO_POLL_MS 마다 다시 읽고, syncup.json 은 마지막 커밋이 바뀔 때만 raw.githubusercontent.com 에서 읽는다
import { useEffect, useState } from "react";
import { rawFileUrl, type RepoStatus, type SyncupState } from "@shared/repo";
import { api } from "./api";

const REPO_POLL_MS = 15_000;

export function useRepo() {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [state, setState] = useState<SyncupState | null>(null);

  useEffect(() => {
    let alive = true;
    const read = () =>
      api.getRepo().then(
        (s) => alive && (setStatus(s), setUnreachable(false)),
        () => alive && setUnreachable(true),
      );
    void read();
    const timer = setInterval(read, REPO_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const sha = status?.linked ? status.commit?.sha : undefined;
  useEffect(() => {
    if (!sha || !status) return;
    let alive = true;
    fetch(rawFileUrl(status, "syncup.json"), { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<SyncupState>) : null))
      .then((s) => alive && setState(s))
      .catch(() => alive && setState(null)); // 파일을 못 읽어도 보드는 그대로 (배지만 빠짐)
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 커밋이 바뀔 때만 다시 읽는다
  }, [sha]);

  return { status, unreachable, state };
}
