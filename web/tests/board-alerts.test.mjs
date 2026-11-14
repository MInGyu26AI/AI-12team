// 팀 보드 충돌 알림 3단계 (shared/labels.ts alertLevel): 충돌 빨강 · 확인 필요 노랑 · 변경 파랑
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const { alertLevel, ALERT_LEVEL } = load("@shared/labels");

test("판정과 확신도로 알림 단계를 정한다", () => {
  assert.equal(alertLevel({ judgement: "충돌" }), "conflict");
  assert.equal(alertLevel({ judgement: "변경", confidence: 0.9 }), "change");
  assert.equal(alertLevel({ judgement: "충돌", confidence: 0.6 }), "conflict"); // 0.6 은 확인 필요가 아니다
  assert.equal(alertLevel({ judgement: "충돌", confidence: 0.59 }), "review");
  assert.equal(alertLevel({ judgement: "변경", confidence: 0.3 }), "review"); // 확신이 낮으면 판정보다 우선
  assert.equal(alertLevel({ judgement: "확인 필요" }), "review"); // 서버가 '확인 필요'로 판정한 경우
});

test("단계마다 이름과 색 토큰이 있다", () => {
  assert.deepEqual(
    Object.entries(ALERT_LEVEL).map(([k, v]) => [k, v.label, v.badge.includes(`alert-${k}`)]),
    [["conflict", "충돌", true], ["review", "확인 필요", true], ["change", "변경", true]],
  );
});
