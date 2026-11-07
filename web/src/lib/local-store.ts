"use client";

// 브라우저 localStorage 를 React 에서 쓰는 작은 도구 (탭 사이 변경도 반영).
// 읽기·쓰기 실패(시크릿 창 등)는 조용히 기본값으로.
import { useCallback, useSyncExternalStore } from "react";

const EVENT = "syncup:local-store";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeLocal<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
  window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
}

const cache = new Map<string, { raw: string | null; value: unknown }>();

/** key 의 값을 구독. 서버 렌더링 때는 fallback */
export function useLocal<T>(key: string, fallback: T): [T, (value: T) => void] {
  const subscribe = useCallback(
    (cb: () => void) => {
      const onChange = (e: Event) => {
        if (e instanceof StorageEvent ? e.key === key : (e as CustomEvent).detail === key) cb();
      };
      window.addEventListener("storage", onChange);
      window.addEventListener(EVENT, onChange);
      return () => {
        window.removeEventListener("storage", onChange);
        window.removeEventListener(EVENT, onChange);
      };
    },
    [key],
  );
  const getSnapshot = () => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {}
    const hit = cache.get(key);
    if (hit && hit.raw === raw) return hit.value as T; // 같은 값이면 같은 객체 (무한 렌더 방지)
    const value = raw ? read(key, fallback) : fallback;
    cache.set(key, { raw, value });
    return value;
  };
  const value = useSyncExternalStore(subscribe, getSnapshot, () => fallback);
  const set = useCallback((v: T) => writeLocal(key, v), [key]);
  return [value, set];
}
