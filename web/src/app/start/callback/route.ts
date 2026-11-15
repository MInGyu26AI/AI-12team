import { NextRequest, NextResponse } from "next/server";
import { cookieOptions, failure, FLOW, privateHeaders, readFlow, SESSION, upstream, webOrigin } from "@/lib/onboarding-server";

export async function GET(request: NextRequest) {
  let origin: string;
  try { origin = webOrigin(); } catch { return failure(); }
  let response: NextResponse;
  try {
    const flow = readFlow(request);
    const code = request.nextUrl.searchParams.get("code");
    if (!code || !/^[0-9a-f-]{36}$/.test(code) || request.nextUrl.searchParams.has("error")) throw new Error("login");
    const result = await upstream("/onboarding/login", "POST", undefined, { code, verifier: flow.verifier, name: flow.name });
    if (result.status !== 200 || typeof result.data.session !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(result.data.session)) throw new Error("login");
    response = NextResponse.redirect(new URL("/start", origin), 303);
    response.cookies.set(SESSION, result.data.session, { ...cookieOptions, maxAge: 1800 });
  } catch {
    response = NextResponse.redirect(new URL("/start?error=login", origin), 303);
  }
  response.cookies.set(FLOW, "", { ...cookieOptions, maxAge: 0 });
  for (const [key, value] of Object.entries(privateHeaders)) response.headers.set(key, value);
  return response;
}
