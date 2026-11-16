"use client";

// 마이페이지 프로필 상태. 실제 모드는 /api/onboarding/profile 을, 목업(USE_MOCK)은 이 브라우저의 localStorage 를 쓴다 (네트워크 없음)
import { useCallback, useEffect, useRef, useState } from "react";
import { USE_MOCK } from "@/lib/api";
import { consentUrl, isConsentRefusal, loginUrl } from "@/lib/auth-navigation";
import { toProfileBody, readProfile, type Profile, type ProfileInput } from "@/lib/profile";

export const MOCK_PROFILE_KEY = "syncup:mock-profile";
// 목업의 기본 이름은 헤더 프로필과 같은 이름(수집기 상태의 사용자 이름)을 쓴다
const mockDefault = (name?: string): Profile =>
  ({ name: name || "하늘", school: null, major: null, grade: null, role: null, photo: null, github_avatar: null, updated_at: null });

export type ProfileState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; profile: Profile };

export function readMockProfile(raw: string | null, name?: string): Profile {
  const base = mockDefault(name);
  if (!raw) return base;
  try { return { ...base, ...readProfile({ ...base, ...JSON.parse(raw) }) }; } catch { return base; }
}
const loadMock = (name?: string) => { try { return readMockProfile(localStorage.getItem(MOCK_PROFILE_KEY), name); } catch { return mockDefault(name); } };
const saveMock = (profile: Profile) => { try { localStorage.setItem(MOCK_PROFILE_KEY, JSON.stringify(profile)); } catch { /* 저장소를 못 써도 이 화면에서는 보인다 */ } };
export const clearMockProfile = () => { try { localStorage.removeItem(MOCK_PROFILE_KEY); } catch { /* 없어도 된다 */ } };

/** 서버 응답에서 한국어 안내를 꺼낸다. 로그인 만료·동의 필요는 해당 화면으로 보낸다 */
async function call(path: string, method: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, { method, cache: "no-store", ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  } catch { throw new Error("연결하지 못했어요. 잠시 뒤 다시 시도해 주세요."); }
  let data: { error?: unknown } | null = null;
  try { data = await response.json(); } catch { /* 본문이 없으면 아래 기본 문구 */ }
  if (response.ok) return data;
  const message = typeof data?.error === "string" && data.error ? data.error : "처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.";
  if (response.status === 401) location.replace(loginUrl("/me"));
  else if (isConsentRefusal(response.status, message)) location.replace(consentUrl("/me"));
  throw new Error(message);
}

async function fetchProfile(mockName?: string): Promise<ProfileState> {
  if (USE_MOCK) { await Promise.resolve(); return { kind: "ready", profile: loadMock(mockName) }; } // 저장소는 브라우저에서만 읽는다
  try { return { kind: "ready", profile: readProfile(await call("/api/onboarding/profile", "GET")) }; }
  catch (e) { return { kind: "error", message: (e as Error).message }; }
}

/** mockName: 목업에서 저장한 프로필이 없을 때 쓸 이름 (실제 모드는 쓰지 않는다) */
export function useProfile(onSaved?: () => void, mockName?: string) {
  const [state, setState] = useState<ProfileState>({ kind: "loading" });
  const saved = useRef(onSaved);
  useEffect(() => { saved.current = onSaved; });
  const fallback = USE_MOCK ? mockName : undefined;

  useEffect(() => {
    let live = true;
    void fetchProfile(fallback).then((next) => { if (live) setState(next); });
    return () => { live = false; };
  }, [fallback]);
  const reload = useCallback(() => { setState({ kind: "loading" }); void fetchProfile(fallback).then(setState); }, [fallback]);

  const apply = (profile: Profile) => { setState({ kind: "ready", profile }); saved.current?.(); return profile; };

  /** 내 정보 저장 */
  const save = async (input: ProfileInput, current: Profile): Promise<Profile> => {
    const body = toProfileBody(input);
    if (USE_MOCK) { const next = { ...current, ...body, updated_at: new Date().toISOString() }; saveMock(next); return apply(next); }
    return apply(readProfile(await call("/api/onboarding/profile", "PUT", body)));
  };
  const uploadPhoto = async (image: string, current: Profile): Promise<Profile> => {
    if (USE_MOCK) { const next = { ...current, photo: image }; saveMock(next); return apply(next); }
    return apply(readProfile(await call("/api/onboarding/profile/photo", "PUT", { image })));
  };
  const clearPhoto = async (current: Profile): Promise<Profile> => {
    if (USE_MOCK) { const next = { ...current, photo: null }; saveMock(next); return apply(next); }
    return apply(readProfile(await call("/api/onboarding/profile/photo", "DELETE")));
  };
  /** 회원 탈퇴. 성공하면 호출한 쪽이 첫 화면으로 보낸다 */
  const withdraw = async (confirm: string) => {
    if (USE_MOCK) { clearMockProfile(); return; }
    await call("/api/onboarding/withdraw", "POST", { confirm });
  };
  return { state, reload, save, uploadPhoto, clearPhoto, withdraw };
}
