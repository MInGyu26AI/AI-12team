import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  const session = process.env.SYNCUP_LOCAL_SESSION;
  const cookie = request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith('syncup_local='))?.slice(13);
  if (process.env.NEXT_PUBLIC_LOCAL_BRIDGE !== 'true' || !session || !cookie ||
      !Number.isFinite(Number(process.env.SYNCUP_LOCAL_EXPIRES)) || Date.now() >= Number(process.env.SYNCUP_LOCAL_EXPIRES) ||
      Buffer.byteLength(cookie) !== Buffer.byteLength(session) || !timingSafeEqual(Buffer.from(cookie), Buffer.from(session)) ||
      !host || origin !== process.env.SYNCUP_LOCAL_ORIGIN || origin !== `http://${host}` ||
      !/^http:\/\/127\.0\.0\.1:\d+$/.test(origin) || !process.env.SYNCUP_CONNECTION_FILE) {
    return Response.json({ ok: false, error: '로컬 연결만 허용됩니다.' }, { status: 403 });
  }
  try {
    const file = await open(process.env.SYNCUP_CONNECTION_FILE, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let connection;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 4096 || (process.platform !== 'win32' &&
          ((info.mode & 0o077) || info.uid !== process.getuid?.()))) throw new Error('연결 파일 권한 오류');
      connection = JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
    const { url, token } = connection;
    if (!/^http:\/\/127\.0\.0\.1:\d+\/rpc$/.test(url)) throw new Error('연결 주소 오류');
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('연결 인증 오류');
    const body = await request.text();
    if (Buffer.byteLength(body) > 4*1024*1024) throw new Error('요청 크기 오류');
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body, redirect: 'error', signal: AbortSignal.timeout(20000) });
    return Response.json(await response.json(), { status: response.status, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ ok: false, error: '로컬 수집기 실행 상태와 연결 파일을 확인하세요.' }, { status: 503 });
  }
}
