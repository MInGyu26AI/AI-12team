// GitHub 레포 연동 화면: 상태 한 줄(shared/repo.ts repoLine), syncup.json 색인(repoIndex), SYNCUP.md 표시(components/markdown.tsx)
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { load } from "./load-ts.mjs";

const { repoLine, repoIndex, rawFileUrl, sinceText } = load("@shared/repo");
const { Markdown } = load("@/components/markdown");

const NOW = Date.parse("2026-11-14T12:00:00Z");
const linked = { linked: true, repo: "MInGyu26AI/AI-12team", branch: "main", state: "saved", pending: false,
  commit: { sha: "a1b2c3d4e5", url: "https://github.com/x/y/commit/a1b2c3d4e5", at: "2026-11-14T11:57:00Z" } };

test("연결 안 된 팀은 숨기고, 저장 상태마다 한 줄로 보여 준다", () => {
  assert.equal(repoLine({ linked: false }), null);
  assert.equal(repoLine(null), null);
  assert.deepEqual(repoLine(linked, NOW), { tone: "ok", text: "AI-12team · 레포에 저장됨 ✓ · 3분 전" });
  assert.equal(repoLine({ ...linked, pending: true }, NOW).text, "AI-12team · 레포에 저장 중…");
  assert.equal(repoLine({ ...linked, state: "failed", httpStatus: 422 }, NOW).tone, "error");
  assert.match(repoLine({ ...linked, state: "failed", httpStatus: 422 }, NOW).text, /저장 실패 \(HTTP 422\)/);
  assert.equal(repoLine({ ...linked, state: "unknown", commit: null }, NOW).tone, "muted");
});

test("raw 파일은 마지막 커밋 sha 로 읽고, 커밋이 없으면 브랜치로 읽는다", () => {
  assert.equal(rawFileUrl(linked, "SYNCUP.md"), "https://raw.githubusercontent.com/MInGyu26AI/AI-12team/a1b2c3d4e5/SYNCUP.md");
  assert.equal(rawFileUrl({ ...linked, commit: null }, "syncup.json"), "https://raw.githubusercontent.com/MInGyu26AI/AI-12team/main/syncup.json");
});

test("syncup.json 에서 할 일 ID 와 레포 반영 결정을 찾는다 (ID 는 서버 값 그대로)", () => {
  const { todoIds, savedDecisions } = repoIndex({
    syncup_version: 1,
    todos: [{ id: "SU-3", card_id: "card-9", content: "배포" }],
    decisions: [{ topic_key: "MVP 범위", current: [{ card_id: "d2", content: "확장 포함" }], history: [{ card_id: "d1", content: "확장 제외" }] }],
  });
  assert.equal(todoIds.get("card-9"), "SU-3");
  assert.deepEqual([...savedDecisions].sort(), ["d1", "d2"]);
  assert.equal(repoIndex(null).todoIds.size, 0);
});

test("시간 표시", () => {
  assert.equal(sinceText("2026-11-14T11:59:40Z", NOW), "방금 전");
  assert.equal(sinceText("2026-11-14T09:00:00Z", NOW), "3시간 전");
  assert.equal(sinceText("2026-11-12T12:00:00Z", NOW), "2일 전");
});

test("SYNCUP.md 형식을 그리고, HTML 은 글자로만 보여 준다", () => {
  const md = [
    "# SyncUp 팀 기록 — AI-12team",
    "> 기준 시각 2026-11-14T14:02+09:00",
    "## 현재 결정",
    "- **MVP 범위**: 확장 포함 — 김단비",
    "  - ~~확장 제외~~ (바뀜)",
    "## 할 일",
    "- [x] `SU-1` 배포 페이지",
    "- [ ] `SU-2` <script>alert(1)</script>",
  ].join("\n");
  const html = renderToStaticMarkup(createElement(Markdown, { source: md }));
  assert.match(html, /<strong>MVP 범위<\/strong>/);
  assert.match(html, /<s[^>]*>확장 제외<\/s>/);
  assert.match(html, /<code[^>]*>SU-1<\/code>/);
  assert.match(html, /☑/);
  assert.ok(!html.includes("<script>"), "HTML 을 그대로 넣지 않는다");
  assert.match(html, /&lt;script&gt;/);
});

test("브랜치 필터: by_branch 의 세부 주제·SU-n 으로 결정·할 일을 고르고, 없으면 거르지 않는다", () => {
  const { branchMatcher, branchNames } = load("@shared/repo");
  const state = {
    syncup_version: 1,
    by_branch: { "feat/github-sync": { members: ["author-a"], todos: ["SU-3"], decisions: ["레포 저장"] } },
  };
  const todoIds = new Map([["card-9", "SU-3"], ["card-1", "SU-1"]]);
  assert.deepEqual(branchNames(state), ["feat/github-sync"]);
  assert.deepEqual(branchNames(null), []);
  const m = branchMatcher(state, "feat/github-sync", todoIds);
  assert.equal(m.decision({ topic_key: "레포 저장" }), true);
  assert.equal(m.decision({ topic_key: "MVP 범위" }), false);
  assert.equal(m.decision({ topic_key: null }), false);
  assert.equal(m.todo({ id: "card-9" }), true);
  assert.equal(m.todo({ id: "card-1" }), false);
  assert.equal(m.todo({ id: "no-id" }), false); // ID 가 없는 할 일은 브랜치와 연결할 수 없다
  assert.deepEqual(m.members, ["author-a"]);
  assert.equal(branchMatcher(state, null, todoIds), null);
  assert.equal(branchMatcher(state, "없는 브랜치", todoIds), null);
});
