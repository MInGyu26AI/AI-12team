// Server-only BFF: provider tokens and permanent PC connection keys never reach the web.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { loginDestination } from "./auth-navigation";

const production = process.env.NODE_ENV === "production";
export const SESSION = production ? "__Host-syncup_onboarding" : "syncup_onboarding";
export const FLOW = production ? "__Host-syncup_signup_flow" : "syncup_signup_flow";
export const cookieOptions = { httpOnly: true, secure: production, sameSite: "lax" as const, path: "/" };
export const privateHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function configuredOrigin(value: string | undefined): string {
  const url = new URL(value ?? "");
  const local = !production && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new Error("configuration");
  return url.origin;
}

export function webOrigin() { return configuredOrigin(process.env.SYNCUP_WEB_ORIGIN); }
export function sameOrigin(request: Request) { return request.headers.get("origin") === webOrigin(); }
export function session(request: NextRequest) {
  const value = request.cookies.get(SESSION)?.value;
  return value && TOKEN.test(value) ? value : undefined;
}

export function json(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: privateHeaders });
}

export async function smallBody(request: Request) {
  // Read bounded bytes even for chunked bodies; Content-Length alone is not a limit.
  const reader = request.body?.getReader();
  if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); throw new Error("body"); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}

type UpstreamPath = "/onboarding" | "/onboarding/login" | "/onboarding/teams" | "/onboarding/consent" | "/onboarding/decline";

export async function upstream(path: UpstreamPath, method: string, token?: string, body?: unknown) {
  const response = await fetch(configuredOrigin(process.env.SYNCUP_TEAM_API_URL) + path, {
    method, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20000),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  return { status: response.status, data };
}

export function beginFlow(name?: string, next?: string) {
  const verifier = randomBytes(48).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const supabase = configuredOrigin(process.env.NEXT_PUBLIC_SUPABASE_URL);
  if (!new URL(supabase).hostname.endsWith(".supabase.co")) throw new Error("configuration");
  const callback = new URL("/start/callback", webOrigin());
  callback.searchParams.set("flow", state);
  const url = new URL("/auth/v1/authorize", supabase);
  url.search = new URLSearchParams({ provider: "github", redirect_to: callback.toString(),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "s256" }).toString();
  const value = Buffer.from(JSON.stringify({ verifier, state, name, next: loginDestination(next), created: Date.now() })).toString("base64url");
  return { url: url.toString(), value };
}

export function readFlow(request: NextRequest) {
  const value = request.cookies.get(FLOW)?.value;
  const state = request.nextUrl.searchParams.get("flow") ?? "";
  if (!value || value.length > 2048 || !TOKEN.test(state)) throw new Error("flow");
  const flow = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (typeof flow.state !== "string" || !TOKEN.test(flow.state) ||
      !timingSafeEqual(Buffer.from(flow.state), Buffer.from(state)) ||
      typeof flow.verifier !== "string" || !/^[A-Za-z0-9_-]{64}$/.test(flow.verifier) ||
      (flow.name !== undefined && (typeof flow.name !== "string" || !flow.name.trim() || flow.name.length > 40 || /[\u0000-\u001f\u007f]/.test(flow.name))) ||
      flow.next !== undefined && loginDestination(flow.next) !== flow.next ||
      !Number.isFinite(flow.created) || Date.now() - flow.created > 600000 || flow.created > Date.now()) throw new Error("flow");
  return { ...flow, next: loginDestination(flow.next) } as { verifier: string; name?: string; next: string };
}

export function failure() { return json({ error: "연결하지 못했어요. 잠시 뒤 다시 시도해 주세요." }, 503); }
