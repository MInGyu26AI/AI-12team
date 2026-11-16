import { NextRequest } from "next/server";
import { cookieOptions, failure, json, sameOrigin, session, SESSION, smallBody, upstream } from "@/lib/onboarding-server";
import { GRADES, toProfileBody, validateProfileInput } from "@/lib/profile";

const NEED_LOGIN = "GitHub로 다시 로그인해 주세요.";

// 내 프로필 읽기. 세션이 끝났으면(401) 브라우저 쿠키도 지운다
export async function GET(request: NextRequest) {
  const token = session(request);
  if (!token) return json({ error: NEED_LOGIN }, 401);
  try {
    const result = await upstream("/onboarding/profile", "GET", token);
    const response = json(result.data, result.status);
    if (result.status === 401) response.cookies.set(SESSION, "", { ...cookieOptions, maxAge: 0 });
    return response;
  } catch { return failure(); }
}

// 내 정보 저장. 알려진 다섯 필드만, 서버와 같은 한도로 먼저 검사해서 넘긴다
export async function PUT(request: NextRequest) {
  try {
    if (!sameOrigin(request)) return json({ error: "이 사이트에서 다시 시도해 주세요." }, 403);
    const token = session(request);
    if (!token) return json({ error: NEED_LOGIN }, 401);
    const body = await smallBody(request);
    const optional = (v: unknown) => v === null || typeof v === "string";
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.name !== "string" ||
        !optional(body.school) || !optional(body.major) || !optional(body.role) ||
        !(body.grade === null || (typeof body.grade === "string" && (GRADES as readonly string[]).includes(body.grade)))) {
      return json({ error: "입력한 내용을 확인하지 못했어요. 화면을 새로 고친 뒤 다시 시도해 주세요." }, 400);
    }
    const input = { name: body.name, school: body.school ?? "", major: body.major ?? "", grade: body.grade as string | null, role: body.role ?? "" };
    const problem = validateProfileInput(input);
    if (problem) return json({ error: problem }, 400);
    const result = await upstream("/onboarding/profile", "PUT", token, toProfileBody(input));
    return json(result.data, result.status);
  } catch { return failure(); }
}
