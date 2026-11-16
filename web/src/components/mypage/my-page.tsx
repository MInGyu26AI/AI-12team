"use client";

// 마이페이지: 가로 3단 (프로필 | 내 정보 | 계정). xl 미만(lg)은 왼쪽에 프로필·계정을 쌓고 오른쪽에 내 정보, lg 미만은 한 줄로 쌓는다.
// lg 이상에서는 세로 스크롤 없이 한 화면에 (시안 MyPage.dc.html). 안쪽 여백은 키 작은 창(높이 700 미만)에서 줄인다
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Camera } from "lucide-react";
import { useDashboard } from "@/components/dashboard/context";
import { input } from "@/components/ui/surface";
import { USE_MOCK } from "@/lib/api";
import { useTeam } from "@/lib/team";
import { GRADES, PROFILE_LIMITS, koreanDate, validateProfileInput, versionLabel, type Profile } from "@/lib/profile";
import { cn } from "@/lib/utils";
import { Avatar } from "./avatar";
import { cropToDataUrl } from "./crop-photo";
import { useProfile } from "./use-profile";
import { WithdrawDialog } from "./withdraw-dialog";

const SECTION = "flex min-h-0 flex-col border border-card-border bg-white";
const H2 = "text-[15px] font-bold text-ink";
const BTN = "inline-flex h-11 shrink-0 cursor-pointer items-center justify-center whitespace-nowrap border border-ink/16 bg-white px-4 text-[13px] text-ink outline-none hover:bg-blush focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-40";
const BTN_GHOST = "inline-flex h-11 shrink-0 cursor-pointer items-center justify-center whitespace-nowrap bg-transparent px-3 text-[13px] text-ink-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-40";
const FIELD = "flex flex-col gap-1.5 text-[13px] font-medium text-ink";
const ROW = "flex items-baseline justify-between gap-3 border-t border-card-border px-6 py-2.5 text-[13px] [@media(max-height:700px)]:py-1.5";

export function MyPage() {
  const { account, recheck } = useDashboard();
  const team = useTeam();
  const { state, save, uploadPhoto, clearPhoto, withdraw, reload } = useProfile(USE_MOCK ? undefined : recheck, team.me);

  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5 px-gutter py-8 md:px-8 lg:h-[calc(100dvh-4rem-1px)] lg:gap-4 lg:py-6 [@media(max-height:700px)]:lg:gap-3 [@media(max-height:700px)]:lg:py-4">
      {/* 제목 양식은 다른 화면과 같다 (영어 큰 제목 + 한국어 제목). 키 작은 창(lg, 높이 700 미만)에서는 한 줄에 놓아 세로 자리를 아낀다 */}
      <div className="space-y-2 [@media(max-height:700px)]:lg:flex [@media(max-height:700px)]:lg:items-baseline [@media(max-height:700px)]:lg:gap-3 [@media(max-height:700px)]:lg:space-y-0">
        <h1 className="title-display text-[clamp(38px,6vw,64px)] text-ink">My page.</h1>
        <p className="text-lg leading-[1.5] font-bold break-keep text-ink sm:text-xl">마이페이지</p>
      </div>
      {state.kind === "loading" && <p role="status" className="text-sm text-ink-2">내 정보를 불러오고 있어요…</p>}
      {state.kind === "error" && (
        <div className="space-y-3">
          <p role="alert" className="bg-sensitive-soft p-3 text-sm text-sensitive">{state.message}</p>
          <button type="button" className={BTN} onClick={reload}>다시 불러오기</button>
        </div>
      )}
      {state.kind === "ready" && (
        <Ready profile={state.profile} loggedIn={!!account}
          save={save} uploadPhoto={uploadPhoto} clearPhoto={clearPhoto} withdraw={withdraw} />
      )}
    </div>
  );
}

type Actions = Pick<ReturnType<typeof useProfile>, "save" | "uploadPhoto" | "clearPhoto" | "withdraw">;

function Ready({ profile, loggedIn, save, uploadPhoto, clearPhoto, withdraw }: { profile: Profile; loggedIn: boolean } & Actions) {
  return (
    <div className="grid min-h-0 grid-cols-1 gap-4 lg:flex-1 lg:grid-cols-[minmax(260px,300px)_minmax(0,1fr)] lg:grid-rows-[auto_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)_320px] xl:grid-rows-1">
      <PhotoSection profile={profile} uploadPhoto={uploadPhoto} clearPhoto={clearPhoto} />
      <InfoSection profile={profile} save={save} />
      <AccountSection profile={profile} loggedIn={loggedIn} withdraw={withdraw} />
    </div>
  );
}

/* ── 1. 프로필: 사진 · 이름 ── */
function PhotoSection({ profile, uploadPhoto, clearPhoto }: { profile: Profile } & Pick<Actions, "uploadPhoto" | "clearPhoto">) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const pick = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files?.[0];
    event.target.value = ""; // 같은 파일을 다시 골라도 반응하게
    if (!chosen) return;
    setBusy(true); setError("");
    try { await uploadPhoto(await cropToDataUrl(chosen), profile); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const clear = async () => {
    setBusy(true); setError("");
    try { await clearPhoto(profile); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const hasPhoto = !!profile.photo;

  return (
    <section aria-labelledby="mp-profile" className={cn(SECTION, "gap-3 p-5 lg:col-start-1 lg:row-start-1 xl:items-center xl:gap-3.5 xl:p-6 [@media(max-height:700px)]:xl:gap-2.5 [@media(max-height:700px)]:xl:p-5")}>
      <h2 id="mp-profile" className={cn(H2, "xl:self-stretch")}>프로필</h2>
      <div className="flex items-center gap-4 xl:flex-col xl:gap-3.5">
        <div className="relative shrink-0">
          <Avatar name={profile.name} photo={profile.photo} githubAvatar={profile.github_avatar} className="size-[72px] text-[28px] xl:size-28 xl:text-[40px] [@media(max-height:700px)]:xl:size-24 [@media(max-height:700px)]:xl:text-[34px]" />
          <button type="button" aria-label="사진 바꾸기" disabled={busy} onClick={() => file.current?.click()}
            className="absolute -right-1.5 -bottom-1.5 flex size-11 cursor-pointer items-center justify-center rounded-full border-2 border-white bg-ink text-white outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-40">
            <Camera aria-hidden className="size-4" strokeWidth={1.5} />
          </button>
        </div>
        <div className="min-w-0 xl:text-center">
          <p className="truncate text-lg font-bold text-ink">{profile.name}</p>
          <p className="mt-1 font-mono text-xs text-ink-3">GitHub 로그인</p>
        </div>
      </div>
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" tabIndex={-1} aria-label="프로필 사진 파일" onChange={pick} />
      <p className="text-xs leading-[1.6] text-ink-3 max-xl:hidden xl:text-center">PNG·JPG·WebP 사진을 가운데 정사각형으로 줄여서 올려요. 올리지 않으면 GitHub 사진, 그것도 없으면 이름 첫 글자를 보여 줘요.</p>
      <div className="flex gap-2 xl:mt-auto">
        <button type="button" className={BTN} disabled={busy} onClick={() => file.current?.click()}>{busy ? "처리 중…" : "사진 올리기"}</button>
        <button type="button" className={BTN_GHOST} disabled={busy || !hasPhoto} onClick={clear}>지우기</button>
      </div>
      <p role="alert" className={cn("text-xs text-sensitive", !error && "hidden")}>{error}</p>
    </section>
  );
}

/* ── 2. 내 정보 ── */
function InfoSection({ profile, save }: { profile: Profile } & Pick<Actions, "save">) {
  const [name, setName] = useState(profile.name);
  const [school, setSchool] = useState(profile.school ?? "");
  const [major, setMajor] = useState(profile.major ?? "");
  const [grade, setGrade] = useState(profile.grade ?? "");
  const [role, setRole] = useState(profile.role ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const form = { name, school, major, grade: grade || null, role };
  const problem = validateProfileInput(form);
  const dirty = name.trim() !== profile.name || school.trim() !== (profile.school ?? "") || major.trim() !== (profile.major ?? "") ||
    grade !== (profile.grade ?? "") || role.trim() !== (profile.role ?? "");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (problem || busy) return;
    setBusy(true); setMessage(null);
    try {
      await save(form, profile); // 새 프로필이 내려오면 '바뀐 것 없음' 상태가 된다
      setMessage({ kind: "ok", text: "저장했어요" });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setMessage(null), 4000);
    } catch (e) { setMessage({ kind: "error", text: (e as Error).message }); }
    finally { setBusy(false); }
  };

  return (
    <section aria-labelledby="mp-info" className={cn(SECTION, "p-5 lg:col-start-2 lg:row-span-2 lg:row-start-1 xl:row-span-1 xl:p-6 [@media(max-height:700px)]:lg:p-4")}>
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col gap-3.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <h2 id="mp-info" className={H2}>내 정보</h2>
          <span className="text-xs text-ink-3">이름만 꼭 필요해요 · 내 정보는 나만 볼 수 있어요</span>
        </div>
        <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <label className={FIELD}>이름
            <input required value={name} maxLength={PROFILE_LIMITS.name} onChange={(e) => setName(e.target.value)} className={cn(input, "h-11 border-input font-normal")} />
          </label>
          <label className={FIELD}>학교
            <input value={school} maxLength={PROFILE_LIMITS.school} onChange={(e) => setSchool(e.target.value)} className={cn(input, "h-11 border-input font-normal")} />
          </label>
          <label className={FIELD}>전공
            <input value={major} maxLength={PROFILE_LIMITS.major} onChange={(e) => setMajor(e.target.value)} className={cn(input, "h-11 border-input font-normal")} />
          </label>
          <label className={FIELD}>학년
            <select value={grade} onChange={(e) => setGrade(e.target.value)} className={cn(input, "h-11 border-input font-normal")}>
              <option value="">선택 안 함</option>
              {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </label>
          <label className={cn(FIELD, "sm:col-span-2")}>팀에서 맡는 역할 한 줄
            <input value={role} maxLength={PROFILE_LIMITS.role} onChange={(e) => setRole(e.target.value)} placeholder="예: 프론트엔드 · 확장 프로그램" className={cn(input, "h-11 border-input font-normal")} />
          </label>
        </div>
        <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-card-border pt-3.5">
          <div className="min-w-0 text-xs">
            {message
              ? <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "text-sensitive" : "font-medium text-ok"}>{message.text}</p>
              : <p role="status" className="text-ink-3">{dirty && problem ? problem : "저장하기 전에는 바뀌지 않아요"}</p>}
          </div>
          <button type="submit" disabled={busy || !dirty || !!problem}
            className="inline-flex h-11 cursor-pointer items-center justify-center border-0 bg-ink px-6 text-sm font-medium text-white outline-none hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-40">
            {busy ? "저장하는 중…" : "저장"}
          </button>
        </div>
      </form>
    </section>
  );
}

/* ── 3. 계정 ── */
function AccountSection({ profile, loggedIn, withdraw }: { profile: Profile; loggedIn: boolean } & Pick<Actions, "withdraw">) {
  const { account } = useDashboard();
  const demoTeam = useTeam();
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const teams = account ? account.teams.map((t) => t.name) : USE_MOCK && demoTeam.name ? [demoTeam.name] : [];
  const consent = account?.consent;
  const consentText = !consent ? (USE_MOCK ? "예시 모드 · 기록 없음" : "기록 없음")
    : `${consent.terms === consent.privacy ? versionLabel(consent.terms) : `약관 ${versionLabel(consent.terms)} · 처리방침 ${versionLabel(consent.privacy)}`} · ${koreanDate(consent.at)}`;

  const logout = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/onboarding", { method: "DELETE" });
      if (!response.ok) throw new Error("로그아웃하지 못했어요. 다시 시도해 주세요.");
      location.replace("/login"); // 프로필 메뉴의 로그아웃과 같은 곳으로. 전체 이동으로 화면에 남은 개인 카드도 지운다
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <section aria-labelledby="mp-account" className={cn(SECTION, "lg:col-start-1 lg:row-start-2 xl:col-start-3 xl:row-start-1")}>
      <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-2.5 [@media(max-height:700px)]:pt-3 [@media(max-height:700px)]:pb-1.5">
        <h2 id="mp-account" className={H2}>계정</h2>
        {loggedIn && !USE_MOCK && <button type="button" className={cn(BTN, "h-11")} disabled={busy} onClick={logout}>{busy ? "로그아웃 중…" : "로그아웃"}</button>}
      </div>
      {error && <p role="alert" className="px-6 pb-2 text-xs text-sensitive">{error}</p>}
      <dl>
        <div className={ROW}><dt className="shrink-0 text-ink-2">내 팀</dt><dd className="min-w-0 text-right break-keep">{teams.length ? teams.join(" · ") : "아직 없어요"}</dd></div>
        <div className={ROW}><dt className="shrink-0 text-ink-2">약관 동의</dt><dd className="min-w-0 text-right break-keep">{consentText}</dd></div>
        <div className={ROW}><dt className="shrink-0 text-ink-2">문서</dt>
          <dd className="text-right"><Link href="/terms" className="underline underline-offset-2">이용약관</Link> · <Link href="/privacy" className="underline underline-offset-2">개인정보 처리방침</Link></dd>
        </div>
      </dl>
      <div className="mt-auto flex flex-col gap-2 border-t border-card-border bg-blush/40 px-6 py-4 [@media(max-height:700px)]:py-2">
        <p className="text-sm font-bold text-ink">회원 탈퇴</p>
        <p className="text-xs leading-[1.6] text-ink-body">계정과 내 정보가 지워지고, 내가 올린 카드에는 이름만 &lsquo;탈퇴한 팀원&rsquo;으로 남아요. 되돌릴 수 없어요.</p>
        <button type="button" className={cn(BTN, "self-start border-ink bg-transparent font-medium")} onClick={() => setLeaving(true)}>탈퇴하기</button>
      </div>
      <WithdrawDialog open={leaving} name={profile.name} onClose={() => setLeaving(false)} onWithdraw={withdraw} onDone={() => location.replace("/")} />
    </section>
  );
}
