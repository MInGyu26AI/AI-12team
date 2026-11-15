// 초대 링크 (src/lib/invite.ts): 코드 형식, 이름, 링크 상태, 설치 안내 판정
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const { cleanName, inviteState, inviteUrl, isInviteCode, needsInstall, previewProblem } = load("@/lib/invite");

test("초대 코드는 24자 base64url 만 받는다", () => {
  assert.equal(isInviteCode("abcdefghijklmnopqrstuv_-"), true);
  for (const bad of ["ONGIL-01", "abcdefghijklmnopqrstuv_", "abcdefghijklmnopqrstuv_-x", "abcdefghijklmnopqrstu!_-"]) {
    assert.equal(isInviteCode(bad), false, bad);
  }
  assert.equal(inviteUrl("https://x.vercel.app", "abcdefghijklmnopqrstuv_-"), "https://x.vercel.app/join/abcdefghijklmnopqrstuv_-");
});

test("이름은 앞뒤 공백을 빼고 1~40자, 제어 문자는 받지 않는다", () => {
  assert.equal(cleanName("  에린 "), "에린");
  assert.equal(cleanName("   "), null);
  assert.equal(cleanName("가".repeat(41)), null);
  assert.equal(cleanName("a\nb"), null);
});

test("링크 상태와 안내 문구", () => {
  const base = { id: "1", created_by: "Alice", created_at: "2026-11-15T00:00:00Z", expires_at: "2026-11-22T00:00:00Z", revoked_at: null, joined: 0 };
  assert.equal(inviteState(base, Date.parse("2026-11-16T00:00:00Z")), "open");
  assert.equal(inviteState(base, Date.parse("2026-11-23T00:00:00Z")), "expired");
  assert.equal(inviteState({ ...base, revoked_at: "2026-11-16T00:00:00Z" }), "revoked");
  assert.equal(previewProblem({ status: "valid", team: "A", expiresAt: "", members: 1, memberLimit: 8 }), null);
  assert.match(previewProblem({ status: "team_full" }), /가득/);
});

test("연결 프로그램이 없거나 팀 서버 주소 없이 설치됐으면 설치 안내로 보낸다", () => {
  assert.equal(needsInstall("Specified native messaging host not found."), true);
  assert.equal(needsInstall("이 PC의 연결 프로그램에 팀 서버 주소가 없습니다. native-setup을 …"), true);
  assert.equal(needsInstall("잠시 뒤 다시 시도하세요."), false);
});
