// 가입 동의 화면의 첫 모습 (목업 모드: 서버 없이 바로 양식). react-dom/server 로 그린 첫 화면과, 항목 데이터·안내 문구를 확인한다
import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

process.env.NEXT_PUBLIC_USE_MOCK = 'true';
const { load } = await import('./load-ts.mjs');
const items = load('@/lib/consent-items');
const html = renderToStaticMarkup(createElement(load('@/components/signup/consent-form').ConsentForm));
const page = load('@/app/(auth)/signup/consent/page');

test('the consent form starts with nothing checked and a disabled start button that explains why', () => {
  assert.match(html, /<h1[^>]*>시작하기 전에 확인해 주세요<\/h1>/);
  assert.equal((html.match(/type="checkbox"/g) ?? []).length, 5); // 모두 동의 + 필수 4개
  assert.doesNotMatch(html, /checked=""/);
  assert.match(html, /<button[^>]*disabled=""[^>]*aria-describedby="consent-hint"[^>]*>동의하고 시작하기<\/button>/);
  assert.match(html, /id="consent-hint"[^>]*>필수 항목 4개가 남았어요\. 모두 체크해야 시작할 수 있어요\./);
  assert.match(html, /<ol aria-label="가입 단계"/);
  assert.match(html, /aria-current="step"[^>]*>.*약관 동의/);
  assert.match(html, /동의하지 않고 나가기/);
});

test('four required items: age, terms, privacy and the overseas-transfer notice, each with its summary text', () => {
  assert.deepEqual(items.CONSENT_ITEMS.map(item => item.id), ['age', 'terms', 'privacy', 'transfer']);
  assert.deepEqual(items.CONSENT_ITEMS.filter(item => item.points).map(item => item.id), ['terms', 'privacy', 'transfer']);
  assert.deepEqual(items.CONSENT_ITEMS.map(item => item.href), [undefined, '/terms', '/privacy', '/privacy']);
  assert.equal(items.CONSENT_ITEMS.find(item => item.id === 'privacy').points.length, 4);
  for (const item of items.CONSENT_ITEMS) assert.match(html, new RegExp(`\\[필수\\]</span> ${item.label}`));
  assert.equal((html.match(/aria-expanded="false"/g) ?? []).length, 3); // 요약 보기 버튼은 셋
});

test('hint counts the unchecked items and flips when all four are agreed', () => {
  const none = items.noConsent();
  assert.equal(items.consentLeft(none), 4);
  assert.equal(items.consentHint(4), '필수 항목 4개가 남았어요. 모두 체크해야 시작할 수 있어요.');
  assert.equal(items.consentLeft({ ...none, age: true, terms: true }), 2);
  assert.equal(items.consentHint(0), '동의한 문서의 버전과 날짜를 기록해요.');
});

test('the consent route sets its own tab title and stays out of search', () => {
  assert.equal(page.metadata.title, '약관 동의 · SyncUp');
  assert.deepEqual(page.metadata.robots, { index: false });
  assert.match(renderToStaticMarkup(createElement(page.default)), /시작하기 전에 확인해 주세요/);
});
