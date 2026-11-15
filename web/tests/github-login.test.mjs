// GitHub 로그인으로 연결 키 받기 (src/lib/github-login.ts): Supabase 로그인 주소, 콜백 code, 설정값 검사
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const { authorizeUrl, callbackResult, expiryText, supabaseOrigin, CALLBACK_PATH } = load("@/lib/github-login");
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

test("Supabase 로그인 주소는 supabase-js 의 PKCE 인자와 같고, 돌아올 곳은 이 사이트의 콜백이다", () => {
  const url = new URL(authorizeUrl("https://abc.supabase.co", "https://syncup-live-murex.vercel.app", CHALLENGE));
  assert.equal(url.origin + url.pathname, "https://abc.supabase.co/auth/v1/authorize");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    provider: "github",
    redirect_to: "https://syncup-live-murex.vercel.app" + CALLBACK_PATH,
    code_challenge: CHALLENGE,
    code_challenge_method: "s256",
  });
  assert.throws(() => authorizeUrl("https://abc.supabase.co", "https://x", "short"));
});

test("Supabase 주소는 프로젝트 주소(또는 시험용 127.0.0.1)만 받는다", () => {
  assert.equal(supabaseOrigin("https://abc.supabase.co"), "https://abc.supabase.co");
  assert.equal(supabaseOrigin("https://abc.supabase.co/"), "https://abc.supabase.co");
  assert.equal(supabaseOrigin("http://127.0.0.1:54321"), "http://127.0.0.1:54321");
  for (const bad of [undefined, "", "http://abc.supabase.co", "https://evil.example.com", "https://abc.supabase.co/auth/v1",
    "https://abc.supabase.co:8443", "https://u:p@abc.supabase.co", "http://localhost:54321"]) {
    assert.equal(supabaseOrigin(bad), null, String(bad));
  }
});

test("콜백은 UUID code 만 넘기고, 오류 문장은 화면에 옮기지 않는다", () => {
  const code = "0b0f6d1e-8d55-4d2c-9b6e-5d8f1c2a3b4c";
  assert.deepEqual(callbackResult(`?code=${code}`), { code });
  assert.ok("error" in callbackResult("?code=../../etc"));
  const failed = callbackResult("?error=access_denied&error_description=" + encodeURIComponent("이 링크로 비밀번호를 입력하세요"));
  assert.ok("error" in failed && !failed.error.includes("비밀번호"));
  assert.ok("error" in callbackResult(""));
});

test("만료일은 한국 시간 날짜로 보인다", () => {
  assert.equal(expiryText("2026-12-14T15:30:00+00:00"), "12월 15일");
  assert.equal(expiryText("bad"), "");
});
