// 팀 보드 새로고침 (src/lib/use-board.ts): 실패해도 마지막 화면 유지, 늦게 온 옛 응답은 버림
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const { requestOrder, afterFailure } = load("@/lib/use-board");

test("나중 요청의 응답이 먼저 반영되면, 먼저 보낸 요청의 늦은 응답은 버린다", () => {
  const order = requestOrder();
  const first = order.next();
  const second = order.next();
  assert.equal(order.accept(second), true);
  assert.equal(order.accept(first), false); // 오래된 응답이 최신 화면을 덮어쓰지 않는다
  const third = order.next();
  assert.equal(order.accept(third), true);
});

test("요청이 늘 겹쳐도 차례대로 도착하면 모두 반영한다 (응답이 영영 안 그려지는 일 없음)", () => {
  const order = requestOrder();
  const a = order.next();
  const b = order.next();
  assert.equal(order.accept(a), true);
  assert.equal(order.accept(b), true);
});

test("한 번 읽은 뒤 실패하면 보드를 두고 stale 만 켜고, 처음 실패는 오류 화면", () => {
  const ready = { state: "ready", cards: [{ id: "c1" }], conflicts: [{ id: "x" }], done: new Set() };
  const kept = afterFailure(ready, "수집기 연결 실패");
  assert.equal(kept.state, "ready");
  assert.equal(kept.stale, true);
  assert.deepEqual(kept.conflicts, [{ id: "x" }]); // 열린 충돌 창의 목록도 그대로
  assert.deepEqual(afterFailure({ state: "loading" }, "실패"), { state: "error", message: "실패" });
});
