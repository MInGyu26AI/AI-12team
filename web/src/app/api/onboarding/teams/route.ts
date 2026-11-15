import { NextRequest } from "next/server";
import { failure, json, sameOrigin, session, smallBody, upstream } from "@/lib/onboarding-server";

export async function POST(request: NextRequest) {
  try {
    if (!sameOrigin(request)) return json({ error: "이 사이트에서 다시 시도해 주세요." }, 403);
    const token = session(request);
    if (!token) return json({ error: "GitHub로 다시 로그인해 주세요." }, 401);
    const result = await upstream("/onboarding/teams", "POST", token, await smallBody(request));
    return json(result.data, result.status);
  } catch { return failure(); }
}
