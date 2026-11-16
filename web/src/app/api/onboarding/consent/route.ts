import { NextRequest } from "next/server";
import { failure, json, sameOrigin, session, smallBody, upstream } from "@/lib/onboarding-server";

// 문서 버전은 짧은 소문자·숫자·점·붙임표만 (서버 DB 와 같은 규칙). 서버가 지금 버전과 같은지 따로 검사한다 (다르면 409)
const VERSION = /^[a-z0-9.-]{1,20}$/;

// 약관·개인정보 처리방침 동의 기록. 알려진 네 필드만 서버로 넘기고, 두 확인(만 14세 이상·국외 이전 안내)은 true 일 때만 보낸다
export async function POST(request: NextRequest) {
  try {
    if (!sameOrigin(request)) return json({ error: "이 사이트에서 다시 시도해 주세요." }, 403);
    const token = session(request);
    if (!token) return json({ error: "GitHub로 다시 로그인해 주세요." }, 401);
    const body = await smallBody(request);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        typeof body.terms !== "string" || !VERSION.test(body.terms) ||
        typeof body.privacy !== "string" || !VERSION.test(body.privacy) ||
        body.age14 !== true || body.transfer !== true) {
      return json({ error: "동의 내용을 확인하지 못했어요. 화면을 새로 고친 뒤 다시 시도해 주세요." }, 400);
    }
    const result = await upstream("/onboarding/consent", "POST", token,
      { terms: body.terms, privacy: body.privacy, age14: true, transfer: true });
    return json(result.data, result.status);
  } catch { return failure(); }
}
