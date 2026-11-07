// 싱크업 ChatGPT 화면 진단 코드 — ChatGPT 대화 탭에서 F12 → Console 에 통째로 붙여넣고 Enter.
// 결과 표 3개를 캡처해서 공유하거나, 끝에 클립보드로 복사된 JSON 을 붙여넣어 주세요.
// (대화 앞 50자가 표에 나오니, 공유 전에 민감한 내용은 가려 주세요)
(() => {
  const CANDIDATES = [
    '[data-message-author-role]',
    '[data-turn]',
    'article',
    '[data-testid*="conversation-turn"]',
    '[data-message-id]',
    '.markdown',
    '[class*="prose"]',
    '.whitespace-pre-wrap',
    '[class*="message"]',
    '[class*="turn"]',
    'main [dir="auto"]',
    'main h5, main h6, main .sr-only',
  ];
  const clip = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const describe = (el) => {
    if (!el) return '';
    const data = [...el.attributes]
      .filter((a) => a.name.startsWith('data-') || a.name === 'role' || a.name === 'id')
      .map((a) => `${a.name}=${clip(a.value, 25)}`)
      .join(' ');
    const cls = typeof el.className === 'string' ? clip(el.className, 40) : '';
    return `<${el.tagName.toLowerCase()}> ${data}${cls ? ` .${cls}` : ''} | "${clip(el.innerText || el.textContent, 50)}"`;
  };

  // 1) 셀렉터별 개수 + 첫 2개 요소
  const selectorRows = CANDIDATES.map((sel) => {
    let nodes = [];
    try { nodes = [...document.querySelectorAll(sel)]; } catch {}
    return { 셀렉터: sel, 개수: nodes.length, 첫번째: describe(nodes[0]), 두번째: describe(nodes[1]) };
  });
  console.log('%c[싱크업 진단] 1) 셀렉터별로 잡히는 요소', 'font-weight:bold;color:#1d4ed8');
  console.table(selectorRows);

  // 2) main 안에서 많이 쓰이는 data-* 속성 (화자·메시지 표시 속성 찾기)
  const main = document.querySelector('main') || document.body;
  const attrCount = {};
  main.querySelectorAll('*').forEach((el) => {
    for (const a of el.attributes) {
      if (!a.name.startsWith('data-')) continue;
      const key = /role|turn|author|message|testid/.test(a.name) ? `${a.name}=${clip(a.value, 30)}` : a.name;
      attrCount[key] = (attrCount[key] || 0) + 1;
    }
  });
  const attrRows = Object.entries(attrCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([속성, 개수]) => ({ 속성, 개수 }));
  console.log('%c[싱크업 진단] 2) main 안의 data-* 속성 TOP 25', 'font-weight:bold;color:#1d4ed8');
  console.table(attrRows);

  // 3) 반복 블록 + iframe / shadow DOM
  let best = { parent: null, tag: '', kids: [] };
  main.querySelectorAll('*').forEach((p) => {
    const groups = {};
    for (const c of p.children) if ((c.textContent || '').trim()) (groups[c.tagName] = groups[c.tagName] || []).push(c);
    for (const [tag, kids] of Object.entries(groups)) if (kids.length > best.kids.length) best = { parent: p, tag, kids };
  });
  const shadowHosts = [...document.querySelectorAll('*')].filter((el) => el.shadowRoot && el.id !== 'syncup-root');
  const iframes = [...document.querySelectorAll('iframe')];
  const envRows = [
    { 항목: '주소', 값: location.href },
    { 항목: 'main 요소 있음', 값: !!document.querySelector('main') },
    { 항목: '반복 블록 부모', 값: describe(best.parent).slice(0, 120) },
    { 항목: '반복 블록 (태그 × 개수)', 값: `${best.tag.toLowerCase()} × ${best.kids.length}` },
    { 항목: '반복 블록 1', 값: describe(best.kids[0]) },
    { 항목: '반복 블록 2', 값: describe(best.kids[1]) },
    { 항목: 'iframe 수', 값: `${iframes.length} ${iframes.map((f) => clip(f.src, 40)).join(', ')}` },
    { 항목: 'shadow DOM 호스트 수 (싱크업 제외)', 값: `${shadowHosts.length} ${shadowHosts.slice(0, 3).map((h) => h.tagName.toLowerCase()).join(', ')}` },
    { 항목: '싱크업 버튼 주입됨', 값: !!document.getElementById('syncup-root') },
  ];
  console.log('%c[싱크업 진단] 3) 반복 블록 · iframe · shadow DOM', 'font-weight:bold;color:#1d4ed8');
  console.table(envRows);

  const summary = { selectors: selectorRows, attrs: attrRows, env: envRows };
  if (typeof copy === 'function') {
    copy(JSON.stringify(summary, null, 2));
    console.log('%c[싱크업 진단] 결과 JSON 이 클립보드에 복사됐어요. 그대로 붙여넣어 보내 주세요.', 'color:#0f766e');
  }
  return summary;
})();
