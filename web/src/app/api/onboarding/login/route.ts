import { NextRequest } from "next/server";
import { beginFlow, cookieOptions, failure, FLOW, json, sameOrigin, smallBody } from "@/lib/onboarding-server";

export async function POST(request: NextRequest) {
  try {
    if (!sameOrigin(request)) return json({ error: "이 사이트에서 다시 시작해 주세요." }, 403);
    const body = await smallBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !["name", "next"].includes(k))) return json({ error: "로그인을 다시 시작해 주세요." }, 400);
    if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 40 || /[\u0000-\u001f\u007f]/.test(body.name))) return json({ error: "팀에 보일 이름을 40자 이내로 입력해 주세요." }, 400);
    const flow = beginFlow(body.name?.trim(), body.next);
    const response = json({ url: flow.url });
    response.cookies.set(FLOW, flow.value, { ...cookieOptions, maxAge: 600 });
    return response;
  } catch { return failure(); }
}
