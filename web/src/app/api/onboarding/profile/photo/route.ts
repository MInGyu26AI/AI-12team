import { NextRequest } from "next/server";
import { boundedBody, failure, json, sameOrigin, session, upstream } from "@/lib/onboarding-server";
import { PHOTO_BODY_LIMIT, validatePhotoDataUrl } from "@/lib/profile";

const NEED_LOGIN = "GitHub로 다시 로그인해 주세요.";

// 프로필 사진 올리기. 큰 본문을 받는 곳은 여기뿐이다 (256×256 로 줄인 사진, 디코딩 300KB 이하)
export async function PUT(request: NextRequest) {
  try {
    if (!sameOrigin(request)) return json({ error: "이 사이트에서 다시 시도해 주세요." }, 403);
    const token = session(request);
    if (!token) return json({ error: NEED_LOGIN }, 401);
    let body;
    try { body = await boundedBody(request, PHOTO_BODY_LIMIT); }
    catch { return json({ error: "사진이 너무 커요. 더 작은 사진을 골라 주세요." }, 413); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "사진을 확인하지 못했어요." }, 400);
    const problem = validatePhotoDataUrl(body.image);
    if (problem) return json({ error: problem }, 400);
    const result = await upstream("/onboarding/profile/photo", "PUT", token, { image: body.image });
    return json(result.data, result.status);
  } catch { return failure(); }
}

// 사진 지우기 (이름 첫 글자 또는 GitHub 사진으로 돌아간다)
export async function DELETE(request: NextRequest) {
  try {
    if (!sameOrigin(request)) return json({ error: "이 사이트에서 다시 시도해 주세요." }, 403);
    const token = session(request);
    if (!token) return json({ error: NEED_LOGIN }, 401);
    const result = await upstream("/onboarding/profile/photo", "DELETE", token);
    return json(result.data, result.status);
  } catch { return failure(); }
}
