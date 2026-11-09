// 로컬 전용 웹 서버(collector/local_web.cjs)가 띄운 페이지의 요청만 로컬 수집기 RPC 로 중계한다.
// 세션 쿠키·루프백 출처·연결 파일 권한을 모두 확인한 뒤에만 수집기에 닿는다 (check_local_bridge.cjs 가 검사).
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { timingSafeEqual } from "node:crypto";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const COLLECTOR_TIMEOUT_MS = 20000;
const UNREACHABLE = "로컬 수집기 실행 상태와 연결 파일을 확인하세요.";
// 화면에 그대로 보여도 되는 실패 이유. 그 밖의 오류(수집기 꺼짐·시간 초과·잘못된 JSON)는 UNREACHABLE 로 묶는다
const KNOWN_ERRORS = new Set(["연결 파일 권한 오류", "연결 주소 오류", "연결 인증 오류", "요청 크기 오류"]);

function sessionCookie(request: Request) {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith("syncup_local="))
    ?.slice("syncup_local=".length);
}

// collector/local_web.cjs 가 심은 HttpOnly 세션 쿠키가 있고 아직 만료되지 않았는지 (상수 시간 비교)
function hasValidSession(request: Request) {
  const session = process.env.SYNCUP_LOCAL_SESSION;
  const cookie = sessionCookie(request);
  const expires = Number(process.env.SYNCUP_LOCAL_EXPIRES);
  if (!session || !cookie || !Number.isFinite(expires) || Date.now() >= expires) return false;
  return Buffer.byteLength(cookie) === Buffer.byteLength(session) && timingSafeEqual(Buffer.from(cookie), Buffer.from(session));
}

// 요청이 로컬 웹 서버 자신의 루프백 출처(http://127.0.0.1:포트)에서 왔는지
function isLocalOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!host || !origin || origin !== process.env.SYNCUP_LOCAL_ORIGIN || origin !== `http://${host}`) return false;
  return /^http:\/\/127\.0\.0\.1:\d+$/.test(origin);
}

// 사용자 전용 권한의 일반 파일만 믿는다 (링크·다른 사용자 소유·그룹/기타 권한이 있으면 거절)
async function readConnection(path: string) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await file.stat();
    const unsafeMode = process.platform !== "win32" && ((info.mode & 0o077) || info.uid !== process.getuid?.());
    if (!info.isFile() || info.size > 4096 || unsafeMode) throw new Error("연결 파일 권한 오류");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}

async function relay(request: Request, connectionFile: string) {
  const { url, token } = await readConnection(connectionFile);
  if (!/^http:\/\/127\.0\.0\.1:\d+\/rpc$/.test(url)) throw new Error("연결 주소 오류");
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("연결 인증 오류");
  const body = await request.text();
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("요청 크기 오류");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(COLLECTOR_TIMEOUT_MS),
  });
  return Response.json(await response.json(), { status: response.status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const connectionFile = process.env.SYNCUP_CONNECTION_FILE;
  if (process.env.NEXT_PUBLIC_LOCAL_BRIDGE !== "true" || !hasValidSession(request) || !isLocalOrigin(request) || !connectionFile) {
    return Response.json({ ok: false, error: "로컬 연결만 허용됩니다." }, { status: 403 });
  }
  try {
    return await relay(request, connectionFile);
  } catch (error) {
    const message = error instanceof Error && KNOWN_ERRORS.has(error.message) ? error.message : UNREACHABLE;
    return Response.json({ ok: false, error: message }, { status: message === "요청 크기 오류" ? 413 : 503 });
  }
}
