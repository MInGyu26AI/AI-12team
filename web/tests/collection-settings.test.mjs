// 수집 설정의 '승인 대상 팀' 선택 칸 (src/components/collect/collection-settings.tsx)
// 팀이 아직 없을 때 빈 칸이 없으면 브라우저가 첫 팀을 고른 것처럼 보여 주고, 그 팀을 골라도 바뀐 것이 없어 저장되지 않는다.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "./load-ts.mjs";

const { CollectionSettings } = load("@/components/collect/collection-settings");

const status = (teamId) => ({
  teamId,
  teams: [{ id: "team-a", name: "A팀" }],
  projectTopic: "",
  endsAt: "2026-11-10T09:00:00.000Z",
});
const render = (teamId) => renderToStaticMarkup(createElement(CollectionSettings, { status: status(teamId), onChange: () => {} }));

test("팀이 없으면 '팀을 선택하세요' 빈 칸이 선택돼 있어, 첫 팀을 고르면 바뀐 것으로 저장된다", () => {
  const html = render(null);
  assert.match(html, /<option value="" disabled="" selected="">팀을 선택하세요<\/option>/);
  assert.doesNotMatch(html, /<option value="team-a" selected=""/);
  assert.match(html, /승인 대상 팀을 먼저 고르세요/);
});

test("묶인 팀이 소속 팀 목록에 없으면(권한 회수 등) 빈 칸이 선택되고 다시 고르라고 안내한다", () => {
  const html = render("team-gone");
  assert.match(html, /<option value="" disabled="" selected="">팀을 선택하세요<\/option>/);
  assert.doesNotMatch(html, /<option value="team-a" selected=""/);
  assert.match(html, /더 이상 접근할 수 없습니다/);
});

test("팀이 있으면 빈 칸과 안내 없이 그 팀이 선택돼 있다", () => {
  const html = render("team-a");
  assert.doesNotMatch(html, /팀을 선택하세요/);
  assert.match(html, /<option value="team-a" selected="">A팀<\/option>/);
  assert.doesNotMatch(html, /승인 대상 팀을 먼저 고르세요/);
});
