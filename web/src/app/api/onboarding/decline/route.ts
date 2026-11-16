import { NextRequest } from "next/server";
import { cookieOptions, failure, json, sameOrigin, session, SESSION, smallBody, upstream } from "@/lib/onboarding-server";

// 동의하지 않고 나가기: 서버가 방금 만든 계정을 지운다 (이미 동의했거나 팀이 있으면 409). 지워졌을 때만 브라우저 세션 쿠키도 지운다
export async function POST(request: NextRequest) {
  try {
    if (!sameOrigin(request)) return json({ error: "이 사이트에서 다시 시도해 주세요." }, 403);
    const token = session(request);
    if (!token) return json({ error: "GitHub로 다시 로그인해 주세요." }, 401);
    await smallBody(request); // 본문은 {} 만 오고 쓰지 않는다. 크기 제한과 JSON 형식만 확인한다
    const result = await upstream("/onboarding/decline", "POST", token, {});
    const response = json(result.data, result.status);
    if (result.status === 200 && result.data?.deleted === true) response.cookies.set(SESSION, "", { ...cookieOptions, maxAge: 0 });
    return response;
  } catch { return failure(); }
}
