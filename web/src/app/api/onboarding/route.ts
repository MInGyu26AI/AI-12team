import { NextRequest } from "next/server";
import { cookieOptions, failure, json, sameOrigin, session, SESSION, upstream } from "@/lib/onboarding-server";

export async function GET(request: NextRequest) {
  const token = session(request);
  if (!token) return json({ error: "GitHub로 로그인해 주세요." }, 401);
  try {
    const result = await upstream("/onboarding", "GET", token);
    const response = json(result.data, result.status);
    if (result.status === 401) response.cookies.set(SESSION, "", { ...cookieOptions, maxAge: 0 });
    return response;
  } catch { return failure(); }
}

export async function DELETE(request: NextRequest) {
  try {
    if (!sameOrigin(request)) return json({ error: "이 사이트에서 다시 시도해 주세요." }, 403);
    const token = session(request);
    if (token) {
      const result = await upstream("/onboarding", "DELETE", token);
      if (result.status !== 200 && result.status !== 401) return json({ error: "로그아웃하지 못했어요. 다시 시도해 주세요." }, 503);
    }
    const response = json({ signed_out: true });
    response.cookies.set(SESSION, "", { ...cookieOptions, maxAge: 0 });
    return response;
  } catch { return failure(); }
}
