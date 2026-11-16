// 약관(/terms)·처리방침(/privacy)·푸터를 서버 렌더로 그려 구조와 개인 연락처를 확인한다 (react-dom/server, 브라우저 없이)
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from './load-ts.mjs';

const render = (specifier, exportName = 'default') => renderToStaticMarkup(createElement(load(specifier)[exportName]));
const legal = load('@/lib/legal');
const terms = render('@/app/(marketing)/terms/page');
const privacy = render('@/app/(marketing)/privacy/page');
const footer = render('@/components/site-footer', 'SiteFooter');
const count = (html, pattern) => (html.match(pattern) ?? []).length;

test('legal versions the server expects are one place, and the screens show the same date and version', () => {
  assert.equal(legal.TERMS_VERSION, 'beta-0.1');
  assert.equal(legal.PRIVACY_VERSION, 'beta-0.1');
  for (const html of [terms, privacy]) {
    assert.match(html, /초안 · 법률 검토 전/);
    assert.match(html, /시행일: <time datetime="2026-11-16">2026\. 11\. 16\.<\/time> · 버전: 베타 0\.1/i);
  }
});

test('terms are real headings and lists: 14 articles and the contact section', () => {
  assert.equal(count(terms, /<h1[ >]/g), 1);
  assert.equal(count(terms, /<h2[ >]/g), 15); // 제1~14조 + 문의
  for (let n = 1; n <= 14; n++) assert.match(terms, new RegExp(`<h2[^>]*>제${n}조 `));
  assert.ok(count(terms, /<ol[ >]/g) >= 10);
  assert.match(terms, /aria-current="page"[^>]*>이용약관</);
});

test('privacy policy keeps its 12 sections and the data tables with accessible names', () => {
  assert.equal(count(privacy, /<h1[ >]/g), 1);
  assert.equal(count(privacy, /<h2[ >]/g), 12);
  assert.equal(count(privacy, /<h3[ >]/g), 9);
  assert.equal(count(privacy, /<table[ >]/g), 5);
  assert.equal(count(privacy, /<th scope="col"/g), 17);
  assert.equal(count(privacy, /<caption class="sr-only">/g), 5);
  assert.match(privacy, /aria-current="page"[^>]*>개인정보 처리방침</);
});

test('the personal phone number is not published; the officer name and email come from the constants', () => {
  assert.equal(legal.CONTACT.phone, null);
  for (const html of [terms, privacy, footer]) {
    assert.doesNotMatch(html, /전화:/);
    assert.doesNotMatch(html, /01\d-\d{3,4}-\d{4}/); // 휴대전화 번호 꼴
    assert.ok(html.includes(legal.CONTACT.email));
  }
  assert.ok(terms.includes(legal.CONTACT.privacyOfficer));
  assert.match(privacy, /개인정보침해신고센터\(privacy\.kisa\.or\.kr, 국번 없이 118\)/);
});

test('footer: service line, beta chip, three links, operator line and the OpenAI trademark sentence', () => {
  assert.match(footer, /SyncUp · Shared Memory for Students/);
  assert.match(footer, />BETA 0\.1</);
  assert.match(footer, /베타 서비스이며 무료예요/);
  assert.match(footer, /<nav aria-label="약관과 문의"/);
  assert.match(footer, /href="\/terms"[^>]*>이용약관</);
  assert.match(footer, /href="\/privacy"[^>]*>개인정보 처리방침</);
  assert.match(footer, new RegExp(`href="mailto:${legal.CONTACT.email}"[^>]*>문의<`));
  assert.match(footer, /운영 SyncUp · 개인정보 보호책임자 김동균 · /);
  assert.match(footer, /ChatGPT는 OpenAI의 상표이며, SyncUp은 OpenAI와 제휴 관계가 없습니다/);
});
