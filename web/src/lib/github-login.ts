// 웹 GitHub 로그인으로 이 PC의 팀 연결 키 받기 (docs/running.md 'GitHub로 연결 키 받기').
// 웹은 Supabase 로그인 주소로 이동하고, 돌아온 일회용 code 만 확장을 거쳐 이 PC의 연결 프로그램(native host)에 넘긴다.
// PKCE verifier 와 연결 키는 연결 프로그램(collector/key_setup.py)이 만들고 갖고 있어서 이 페이지는 둘 다 보지 않는다.
// code 는 verifier 없이 쓸 수 없고 한 번만 바꿀 수 있다. Supabase 토큰 교환은 팀 서버가 한다(server/key_issue.py).

export const CALLBACK_PATH = "/auth/callback";
// 연결 프로그램은 팀 서버 등록을 한 번 다시 시도하고 /me 로 확인하므로 기본 25초보다 오래 기다린다 (key_setup.py POST_SECONDS)
export const CONNECT_TIMEOUT_MS = 45000;
const CODE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/; // S256: SHA-256 의 base64url (패딩 없음)

/** setup.status: 이 PC에 연결 키가 있는지와 만료 시각 */
export type SetupStatus = { hostReady: boolean; keyPresent: boolean; expiresAt: string | null };
/** setup.connect: 받은 키의 사용자·팀 이름과 만료 시각 (키·경로는 오지 않는다) */
export type ConnectResult = { name: string; teams: string[]; expiresAt: string };

/** NEXT_PUBLIC_SUPABASE_URL 의 출처. https://<프로젝트>.supabase.co 만 받고(시험용 로컬 Supabase 는 http://127.0.0.1), 아니면 null */
export function supabaseOrigin(value: string | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    const hosted = url.protocol === "https:" && url.hostname.endsWith(".supabase.co") && !url.port;
    const local = url.protocol === "http:" && url.hostname === "127.0.0.1";
    if (!(hosted || local) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Supabase GitHub 로그인 시작 주소. supabase-js signInWithOAuth 의 PKCE 인자와 같다 (provider·redirect_to·code_challenge·s256) */
export function authorizeUrl(supabase: string, pageOrigin: string, challenge: string): string {
  if (!CHALLENGE.test(challenge)) throw new Error("연결 프로그램의 응답 형식이 맞지 않습니다. 확장과 수집기를 최신으로 바꾸세요.");
  const url = new URL("/auth/v1/authorize", supabase);
  url.search = new URLSearchParams({
    provider: "github",
    redirect_to: pageOrigin + CALLBACK_PATH,
    code_challenge: challenge,
    code_challenge_method: "s256",
  }).toString();
  return url.toString();
}

/** /auth/callback 의 주소 query: Supabase 가 돌려준 code, 아니면 보여 줄 고정 문구 (Supabase 가 보낸 오류 문장은 화면에 옮기지 않는다) */
export function callbackResult(search: string): { code: string } | { error: string } {
  const query = new URLSearchParams(search);
  const code = query.get("code");
  if (code && CODE.test(code)) return { code };
  if (query.get("error")) return { error: "GitHub 로그인이 취소되었거나 실패했어요. 처음부터 다시 시도하세요." };
  return { error: "로그인 결과가 없어요. 팀 연결 화면에서 처음부터 다시 시도하세요." };
}

/** "2026-12-14T…" → "12월 14일" (한국 시간) */
export function expiryText(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", timeZone: "Asia/Seoul" }).format(date);
}
