// 대화 수집·빈 승인함의 연결 상태 구분 (src/lib/local-collector.ts collectorLink):
// 확장이 요청을 받지 않으면 '확장 설치 필요', 확장은 받았지만 수집기가 꺼졌으면 '로컬 수집기 꺼짐'
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const { collectorLink } = load("@/lib/local-collector");
const status = { version: "1", configured: true, autoCollect: true, turnsPerBatch: 10, bufferedTurns: 0, endsAt: "", lastCollectedAt: null, lastClassifier: null, teamName: "팀", userName: "나", recent: [] };

test("확인 전 · 연결됨 · 확장 없음 · 수집기 꺼짐을 나눈다", () => {
  assert.equal(collectorLink({ checked: false, available: false, extensionMissing: false, status: null }), "checking");
  assert.equal(collectorLink({ checked: true, available: true, extensionMissing: false, status }), "connected");
  assert.equal(collectorLink({ checked: true, available: false, extensionMissing: true, status: null }), "extension-missing");
  assert.equal(collectorLink({ checked: true, available: false, extensionMissing: false, status: null }), "collector-off");
  // 예전에 연결됐다가 수집기가 꺼진 경우: 마지막 상태는 남아 있어도 꺼짐으로 본다
  assert.equal(collectorLink({ checked: true, available: false, extensionMissing: false, status }), "collector-off");
});
