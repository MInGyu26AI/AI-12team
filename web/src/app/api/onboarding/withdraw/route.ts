import { NextRequest } from "next/server";
import { cookieOptions, failure, json, sameOrigin, session, SESSION, smallBody, upstream } from "@/lib/onboarding-server";
import { PROFILE_LIMITS } from "@/lib/profile";

// 회원 탈퇴: 지금 이름을 그대로 입력했을 때만 서버로 넘긴다. 지워졌을 때만 브라우저 세션 쿠키도 지운다
export async function POST(request: NextRequest) {
  try {
    if (!sameOrigin(request)) return json({ error: "이 사이트에서 다시 시도해 주세요." }, 403);
    const token = session(request);
    if (!token) return json({ error: "GitHub로 다시 로그인해 주세요." }, 401);
    const body = await smallBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.confirm !== "string" ||
        !body.confirm.trim() || body.confirm.length > PROFILE_LIMITS.name * 2) {
      return json({ error: "확인을 위해 지금 이름을 입력해 주세요." }, 400);
    }
    const result = await upstream("/onboarding/withdraw", "POST", token, { confirm: body.confirm });
    const response = json(result.data, result.status);
    if (result.status === 200 && result.data?.deleted === true) response.cookies.set(SESSION, "", { ...cookieOptions, maxAge: 0 });
    return response;
  } catch { return failure(); }
}
