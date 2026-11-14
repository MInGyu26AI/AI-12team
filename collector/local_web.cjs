// Local bridge entry point: the socket and browser session are owned by this process.
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const path = require('node:path');

// randomBytes(32) as hex; the session cookie lives as long as the server-side session.
const TOKEN_HEX = 64;
const SESSION_SECONDS = 8 * 3600;
const BOOTSTRAP_MS = 5 * 60 * 1000;

async function main() {
  if (!process.env.SYNCUP_CONNECTION_FILE) throw new Error('SYNCUP_CONNECTION_FILE is required');
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
  const origin = `http://127.0.0.1:${port}`;
  const session = randomBytes(32).toString('hex');
  let bootstrap = randomBytes(32).toString('hex');
  const expires = Date.now() + BOOTSTRAP_MS;
  Object.assign(process.env, {
    NEXT_PUBLIC_LOCAL_BRIDGE: 'true', NEXT_PUBLIC_USE_MOCK: 'false', SYNCUP_LOCAL_ORIGIN: origin,
    SYNCUP_LOCAL_SESSION: session, SYNCUP_LOCAL_EXPIRES: String(Date.now() + SESSION_SECONDS * 1000),
  });
  const app = require('../web/node_modules/next')({ dev: true, dir: path.join(__dirname, '..', 'web'), hostname: '127.0.0.1', port });
  await app.prepare();
  const handle = app.getRequestHandler();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(403).end(); return;
    }
    if (req.url === '/local-session' && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
      res.end(`<!doctype html><html lang="ko"><meta charset="utf-8"><title>로컬 연결</title><p id="status" role="status">연결 확인 중…</p><script>
        const key=location.hash.slice(1); history.replaceState(null,'','/local-session');
        fetch('/local-session',{method:'POST',body:key}).then(r=>{
          if(r.ok) location.replace('/review'); else document.getElementById('status').textContent='연결 링크가 만료되었거나 이미 사용되었습니다. 로컬 웹을 다시 실행하세요.';
        }).catch(()=>document.getElementById('status').textContent='로컬 연결에 실패했습니다.');
      </script></html>`); return;
    }
    if (req.url === '/local-session' && req.method === 'POST') {
      if (req.headers.origin !== origin || req.headers['transfer-encoding'] || Number(req.headers['content-length']) !== TOKEN_HEX) {
        res.writeHead(403).end(); return;
      }
      let body = '';
      try {
        for await (const chunk of req) { body += chunk; if (body.length > TOKEN_HEX) break; }
        if (!bootstrap || Date.now() > expires || body.length !== TOKEN_HEX || !timingSafeEqual(Buffer.from(body), Buffer.from(bootstrap))) {
          res.writeHead(403).end(); return;
        }
        bootstrap = '';
        res.setHeader('Set-Cookie', `syncup_local=${session}; HttpOnly; SameSite=Strict; Path=/api/local; Max-Age=${SESSION_SECONDS}`);
        res.writeHead(204).end(); return;
      } catch { res.writeHead(400).end(); return; }
    }
    try { await handle(req, res); } catch { if (!res.headersSent) res.writeHead(503); res.end(); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.setTimeout(30000, socket => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  console.log(`로컬 연결 (5분 내 1회): ${origin}/local-session#${bootstrap}`);
  // The link is one-time by design; a second open says it expired, which reads like a failure.
  console.log('이 링크는 한 번만 열 수 있습니다. 브라우저 세션이 끝났거나 다시 열어야 하면 이 실행기를 다시 시작해 새 링크를 받으세요.');
}

main().catch(() => { console.error('로컬 웹 실행 실패: 연결 파일·포트·설치 상태를 확인하세요.'); process.exit(1); });
