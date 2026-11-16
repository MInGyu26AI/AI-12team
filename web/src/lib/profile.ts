// 마이페이지 프로필: 서버 계약(GET·PUT /onboarding/profile)과 같은 모양·한도. 순수 함수만 둔다 (화면·API 경로·시험이 같이 쓴다)

export const GRADES = ["1학년", "2학년", "3학년", "4학년", "5학년 이상", "대학원", "기타"] as const;
export type Grade = (typeof GRADES)[number];

export const PROFILE_LIMITS = { name: 40, school: 60, major: 60, role: 80 } as const;
/** 사진: 디코딩한 크기 한도(바이트)와 허용 형식. 화면은 256×256 으로 줄여서 올린다 */
export const PHOTO_MAX_BYTES = 300_000;
export const PHOTO_SIZE = 256;
export const PHOTO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
/** 사진 요청 본문 한도: base64(약 4/3 배) + JSON 포장 */
export const PHOTO_BODY_LIMIT = Math.ceil((PHOTO_MAX_BYTES * 4) / 3) + 1024;

export type Profile = {
  name: string;
  school: string | null;
  major: string | null;
  grade: string | null;
  role: string | null;
  photo: string | null; // data URL
  github_avatar: string | null;
  updated_at: string | null;
};

/** 저장할 입력. 빈 문자열은 '비움'(null) 으로 보낸다 */
export type ProfileInput = { name: string; school: string; major: string; grade: string | null; role: string };

const text = (v: unknown) => v === null || typeof v === "string";

/** 서버 응답을 엄격하게 확인한다 (readAccount 와 같은 방식). 모양이 다르면 던진다 */
export function readProfile(data: unknown): Profile {
  const v = data as Profile | null;
  if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.name !== "string" ||
      !text(v.school) || !text(v.major) || !text(v.grade) || !text(v.role) || !text(v.photo) || !text(v.github_avatar) || !text(v.updated_at) ||
      (v.photo != null && !/^data:image\//.test(v.photo))) {
    throw new Error("프로필을 확인하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
  }
  const { name, school, major, grade, role, photo, github_avatar, updated_at } = v;
  return { name, school, major, grade, role, photo, github_avatar, updated_at };
}

const SINGLE_LINE = /[\u0000-\u001f\u007f]|[\u2028\u2029]/;

/** 저장 전 검사. 문제가 있으면 한국어 안내 한 줄, 없으면 null */
export function validateProfileInput(input: ProfileInput): string | null {
  const name = input.name.trim();
  if (!name) return "이름을 입력해 주세요.";
  if (name.length > PROFILE_LIMITS.name) return `이름은 ${PROFILE_LIMITS.name}자까지 쓸 수 있어요.`;
  const fields: [string, string, number][] = [["학교", input.school, PROFILE_LIMITS.school], ["전공", input.major, PROFILE_LIMITS.major], ["역할", input.role, PROFILE_LIMITS.role]];
  for (const [label, value, max] of fields) {
    if (value.trim().length > max) return `${label}은(는) ${max}자까지 쓸 수 있어요.`;
  }
  if ([input.name, input.school, input.major, input.role].some((v) => SINGLE_LINE.test(v))) return "줄바꿈 없이 한 줄로 입력해 주세요.";
  if (input.grade !== null && !(GRADES as readonly string[]).includes(input.grade)) return "학년을 목록에서 골라 주세요.";
  return null;
}

/** 서버로 보낼 본문: 앞뒤 공백을 지우고 빈 값은 null */
export function toProfileBody(input: ProfileInput) {
  const blank = (v: string) => v.trim() || null;
  return { name: input.name.trim(), school: blank(input.school), major: blank(input.major), grade: input.grade, role: blank(input.role) };
}

/** 이름 첫 글자 (사진이 없을 때 동그라미에 쓴다) */
export function initialOf(name: string | null | undefined): string {
  const first = Array.from((name ?? "").trim())[0];
  return first ?? "나";
}

/** 사진 data URL 검사: png·jpeg·webp 이고 디코딩한 크기가 한도 이하. 문제가 있으면 안내, 없으면 null */
export function validatePhotoDataUrl(value: unknown): string | null {
  if (typeof value !== "string") return "사진을 확인하지 못했어요.";
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!m) return "PNG·JPG·WebP 사진만 올릴 수 있어요.";
  if (decodedBytes(m[2]) > PHOTO_MAX_BYTES) return "사진이 너무 커요. 더 작은 사진을 골라 주세요.";
  return null;
}

export function decodedBytes(base64: string): number {
  const pad = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - pad;
}

/** 탈퇴 확인: 입력한 이름이 지금 이름과 같아야 한다 (앞뒤 공백만 무시) */
export function confirmsName(typed: string, current: string): boolean {
  return typed.trim() !== "" && typed.trim() === current.trim();
}

/** 약관 동의 시각을 '2026. 11. 16.' 꼴로 (Intl 없이 고정 형식, 시간대는 한국) */
export function koreanDate(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const d = new Date(time + 9 * 3600_000);
  return `${d.getUTCFullYear()}. ${d.getUTCMonth() + 1}. ${d.getUTCDate()}.`;
}

/** 약관 버전 'beta-0.1' → '베타 0.1' (알 수 없는 꼴은 그대로) */
export function versionLabel(version: string): string {
  const m = /^beta-(.+)$/.exec(version);
  return m ? `베타 ${m[1]}` : version;
}
