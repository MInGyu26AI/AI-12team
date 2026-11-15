const el = id => document.getElementById(id);
let busy = false;
function message(text) { el('message').textContent = text; }
async function refresh() {
  const r = await fetch('/status', { cache: 'no-store' });
  const s = await r.json();
  if (!r.ok) throw new Error(s.error || '연결 상태를 확인하지 못했어요.');
  el('service').textContent = `연결할 웹: ${s.web_url} · 버전 ${s.version}`;
  el('collect').href = s.web_url + '/collect';
  el('connected').textContent = s.key_present ? '✓ 이 PC의 GitHub 연결을 확인했어요.' : '아직 이 PC에 연결 키가 없어요.';
  el('running').textContent = s.running ? '✓ 수집기가 실행 중이에요. 웹에서 연결을 확인하세요.' : '수집기가 꺼져 있어요.';
  const selected = el('team').value;
  el('team').replaceChildren();
  for (const t of s.teams) {
    const option = document.createElement('option'); option.value = t.id; option.textContent = t.name; el('team').append(option);
  }
  if (s.teams.some(t => t.id === selected)) el('team').value = selected;
}
async function action(path, body = {}) {
  if (busy) return;
  busy = true; document.querySelectorAll('button').forEach(b => b.disabled = true);
  message('확인하고 있어요…');
  try {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '작업을 완료하지 못했어요.');
    if (path === '/quit') { message('앱을 종료했어요. 이 탭을 닫아도 돼요.'); return; }
    if (path === '/folder') el('folder-path').textContent = data.folder;
    if (path === '/install') el('installed').textContent = data.backed_up ? '✓ 이전 설정을 백업하고 새 연결 프로그램을 설치했어요.' : '✓ 연결 프로그램을 설치했어요.';
    await refresh(); message('완료했어요. 다음 단계로 계속해 주세요.');
  } catch (e) { message(e.message); }
  finally { busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false); }
}
el('folder').onclick = () => action('/folder');
el('install').onclick = () => action('/install', { extension_id: el('extension').value.trim() });
el('connect').onclick = () => action('/connect');
el('refresh').onclick = () => refresh().catch(e => message(e.message));
el('start').onclick = () => { const key = el('api-key').value; el('api-key').value = ''; return action('/start', { team_id: el('team').value, api_key: key }); };
el('stop').onclick = () => action('/stop');
el('quit').onclick = () => action('/quit');
refresh().catch(e => message(e.message));
