// Real Next HTTP route + dedicated launcher, synthetic RPC and credentials only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'syncup-bridge-check-'));
  const token = randomBytes(32).toString('base64url');
  let calls = 0;
  const rpc = http.createServer(async (req,res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(req.headers.origin, undefined);
    let body=''; for await (const chunk of req) body+=chunk;
    assert.equal(JSON.parse(body).method, 'collection.status');
    calls++;
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({ok:true,result:{synthetic:true}}));
  });
  let child;
  try {
    const rpcPort=await listen(rpc);
    const file=path.join(temp,'connection.json');
    await fs.writeFile(file,JSON.stringify({url:`http://127.0.0.1:${rpcPort}/rpc`,token}),{mode:0o600});
    const reservation=http.createServer(); const port=await listen(reservation);
    await new Promise(resolve=>reservation.close(resolve));
    const origin=`http://127.0.0.1:${port}`;
    child=spawn(process.execPath,[path.join(__dirname,'local_web.cjs')],{
      cwd:__dirname,env:{...process.env,PORT:String(port),SYNCUP_CONNECTION_FILE:file,NEXT_TELEMETRY_DISABLED:'1'},
      stdio:['ignore','pipe','pipe'],
    });
    let output=''; child.stdout.on('data',chunk=>output+=chunk);
    child.stderr.on('data',()=>{});
    const deadline=Date.now()+60000;
    while(!output.includes('/local-session#') && child.exitCode===null && Date.now()<deadline)
      await new Promise(resolve=>setTimeout(resolve,100));
    const nonce=output.match(/\/local-session#([a-f0-9]{64})/)?.[1];
    assert.ok(nonce,'launcher ready with one-use nonce');
    if(process.platform==='darwin') {
      const sockets=execFileSync('lsof',['-nP','-a','-p',String(child.pid),'-iTCP','-sTCP:LISTEN'],{encoding:'utf8'});
      assert.ok(sockets.includes(`127.0.0.1:${port}`));
      assert.ok(!sockets.includes(`*:${port}`));
    }
    const body=JSON.stringify({version:1,method:'collection.status',params:{}});
    const call=(cookie,source=origin)=>fetch(origin+'/api/local',{method:'POST',headers:{Origin:source,...(cookie?{Cookie:cookie}:{})},body,signal:AbortSignal.timeout(45000)});
    assert.equal((await call()).status,403);
    assert.equal(calls,0);
    assert.equal((await call('syncup_local='+'0'.repeat(64))).status,403);
    const page=await fetch(origin+'/local-session');
    assert.equal(page.headers.get('referrer-policy'),'no-referrer');
    assert.ok((await page.text()).includes('history.replaceState'));
    const exchange=()=>fetch(origin+'/local-session',{method:'POST',headers:{Origin:origin},body:nonce});
    const response=await exchange(); assert.equal(response.status,204);
    const cookieHeader=response.headers.get('set-cookie');
    assert.ok(cookieHeader.includes('HttpOnly')); assert.ok(cookieHeader.includes('SameSite=Strict'));
    const cookie=cookieHeader.split(';')[0];
    assert.equal((await exchange()).status,403);
    assert.equal((await call(cookie,'https://untrusted.example')).status,403);
    const accepted=await call(cookie); assert.equal(accepted.status,200);
    assert.deepEqual(await accepted.json(),{ok:true,result:{synthetic:true}});
    assert.equal(calls,1);
    await fs.chmod(file,0o644);
    assert.equal((await call(cookie)).status,503);
    assert.equal(calls,1);
    console.log('PASS: loopback listener, no-cookie/forged-cookie/wrong-origin denial, one-use exchange, HttpOnly session, authenticated RPC, insecure file denied');
  } finally {
    if(child && child.exitCode===null) {
      child.kill('SIGTERM');
      const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
      await new Promise(resolve=>child.once('exit',resolve)); clearTimeout(timer);
    }
    await new Promise(resolve=>rpc.close(resolve));
    await fs.rm(temp,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
