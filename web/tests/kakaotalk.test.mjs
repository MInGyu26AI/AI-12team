// 카톡 붙여넣기 (shared/kakaotalk.ts): 형식 알아보기, 자동 전처리, '내 글만'·'팀 전체', 다시 붙여넣기 때 같은 id
// 이름은 모두 가짜. 형식은 카카오 고객센터 안내와 오픈소스 파서의 정규식으로 만든 예시라 실제 파일과 다를 수 있다.
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const { parseKakao, kakaoSelection, defaultRole, MAX_PIECE } = load("@shared/kakaotalk");
const { parsePasted } = load("@shared/utterance");
const { toMessages } = load("@/lib/collector-intake");

const TODAY = new Date(2026, 10, 15, 3, 0);
const PC = `온길 님과 카카오톡 대화
저장한 날짜 : 2026-11-14 22:10
--------------- 2026년 11월 14일 금요일 ---------------
윤채원님이 들어왔습니다.
[김가명] [오후 9:02] 시연 영상은 3분 이내로 하자
[이가짜] [오후 9:03] 좋아. 자막은 내가 일요일까지 넣을게
[박조교] [오후 9:04] 제출은 LMS로 해 주세요
[김가명] [오후 9:06] 사진
[김가명] [오후 9:06] 이모티콘
[이가짜] [오후 9:06] 파일: 발표자료_v2.pptx
[김가명] [오후 9:07] 발표 순서는 문제 정의 → 시연 → 팀 소개로 가자
질문 시간은 2분 남기자
삭제된 메시지입니다.
--------------- 2026년 11월 15일 토요일 ---------------
[김가명] [오전 12:10] 자정 넘었네`;

const room = (roles, key = "room1") => ({ key, name: "온길", team: "온길", roles, teamConfirmed: false });
const ROLES = {
  김가명: { kind: "me" },
  이가짜: { kind: "member", name: "이서준" },
  박조교: { kind: "skip" },
};

test("카톡이 아닌 글은 null: ChatGPT 붙여넣기, 시각 없는 '[이름] 내용' 단톡방 예시", () => {
  assert.equal(parseKakao("나: 주제는 청년 주거로 하자\nChatGPT: 좋아요", TODAY), null);
  assert.equal(parseKakao("[도윤] 발표 슬라이드 초안은 채원이가 만들어 줘\n[채원] 좋아", TODAY), null);
  assert.equal(parseKakao("", TODAY), null);
});

test("PC 형식: 머리줄·날짜 구분선·시스템 줄·첨부를 빼고 여러 줄 메시지를 잇는다", () => {
  const p = parseKakao(PC, TODAY);
  assert.equal(p.roomName, "온길");
  assert.deepEqual(
    p.messages.map((m) => [m.speaker, m.minute, m.dated, m.text]),
    [
      ["김가명", "2026-11-14T21:02", true, "시연 영상은 3분 이내로 하자"],
      ["이가짜", "2026-11-14T21:03", true, "좋아. 자막은 내가 일요일까지 넣을게"],
      ["박조교", "2026-11-14T21:04", true, "제출은 LMS로 해 주세요"],
      ["김가명", "2026-11-14T21:07", true, "발표 순서는 문제 정의 → 시연 → 팀 소개로 가자\n질문 시간은 2분 남기자"],
      ["김가명", "2026-11-15T00:10", true, "자정 넘었네"],
    ],
  );
  assert.deepEqual(p.skipped, { attachments: 3, system: 2, unreadable: 0 });
  assert.deepEqual(p.speakers, [
    { name: "김가명", count: 3 },
    { name: "이가짜", count: 1 },
    { name: "박조교", count: 1 },
  ]);
});

test("모바일 형식: Android 한국어·영어, iOS(추정)와 시스템 줄", () => {
  const android = parseKakao(
    "2026년 11월 9일 월요일\n2026년 11월 9일 오후 3:12, 김가명 : 발표자료 초안 올렸어요\n2026년 11월 9일 오후 3:13, 이가짜님이 들어왔습니다.\n2026년 11월 9일 오전 12:05, 이가짜 : 시간: 비율은 3:1로",
    TODAY,
  );
  assert.deepEqual(
    android.messages.map((m) => [m.speaker, m.minute, m.text]),
    [
      ["김가명", "2026-11-09T15:12", "발표자료 초안 올렸어요"],
      ["이가짜", "2026-11-09T00:05", "시간: 비율은 3:1로"],
    ],
  );
  assert.equal(android.skipped.system, 1);
  const english = parseKakao("November 9, 2026, 3:12 PM, 김가명 : ship it\nNovember 9, 2026, 3:14 PM, 이가짜 : ok", TODAY);
  assert.deepEqual(english.messages.map((m) => [m.speaker, m.minute]), [["김가명", "2026-11-09T15:12"], ["이가짜", "2026-11-09T15:14"]]);
  const ios = parseKakao("2026. 11. 9. 오후 3:12, 김가명 : 회의는 화요일", TODAY);
  assert.deepEqual(ios.messages.map((m) => [m.speaker, m.minute, m.text]), [["김가명", "2026-11-09T15:12", "회의는 화요일"]]);
});

test("날짜 줄 없이 복사한 PC 메시지는 오늘 날짜, dated=false, id 에는 시각만", () => {
  const p = parseKakao("[김가명] [오후 3:12] 회의는 화요일로 하자\n[이가짜] [오후 3:13] 좋아", TODAY);
  assert.deepEqual(p.messages.map((m) => [m.minute, m.dated]), [["2026-11-15T15:12", false], ["2026-11-15T15:13", false]]);
  const [u] = kakaoSelection(p, room(ROLES), "mine").utterances;
  assert.match(u.id, /^kakao:room1:t1512:[0-9a-f]{14}:0:0$/);
});

test("'내 글만': 내 메시지만, 본문 그대로, 수집기 형식(site manual, turnId, +09:00)", () => {
  const s = kakaoSelection(parseKakao(PC, TODAY), room(ROLES), "mine");
  assert.equal(s.mine, 3);
  assert.equal(s.members, 0);
  assert.deepEqual(s.utterances.map((u) => u.text), [
    "시연 영상은 3분 이내로 하자",
    "발표 순서는 문제 정의 → 시연 → 팀 소개로 가자\n질문 시간은 2분 남기자",
    "자정 넘었네",
  ]);
  const [u] = s.utterances;
  assert.equal(u.conversationId, "kakao:room1");
  assert.equal(u.collectedAt, "2026-11-14T21:02:00+09:00");
  assert.equal(u.speaker, "user");
  assert.equal(u.roleGuessed, false);
  assert.equal(u.site, "manual");
  assert.match(u.source, /^카카오톡, 2026-11-14 21:02$/);
  assert.equal(s.first, "2026-11-14T21:02");
  assert.equal(s.last, "2026-11-15T00:10");
});

test("'팀 전체': 팀원 메시지에 고친 이름을 붙이고, 빼기로 둔 화자는 보내지 않는다", () => {
  const s = kakaoSelection(parseKakao(PC, TODAY), room(ROLES), "team");
  assert.equal(s.mine, 3);
  assert.equal(s.members, 1);
  assert.deepEqual(s.utterances.map((u) => u.text).slice(0, 2), ["시연 영상은 3분 이내로 하자", "[이서준] 좋아. 자막은 내가 일요일까지 넣을게"]);
  assert.ok(!s.utterances.some((u) => u.text.includes("LMS")));
});

test("내 메시지는 두 모드에서 id·본문이 같고, 겹치게 다시 붙여 넣어도 같은 id", () => {
  const parsed = parseKakao(PC, TODAY);
  const mine = kakaoSelection(parsed, room(ROLES), "mine").utterances;
  const team = kakaoSelection(parsed, room(ROLES), "team").utterances;
  const byId = new Map(team.map((u) => [u.id, u.text]));
  for (const u of mine) assert.equal(byId.get(u.id), u.text);
  const tail = PC.split("\n").slice(9).join("\n"); // 9:07 메시지부터 다시 복사
  const again = kakaoSelection(parseKakao(`--------------- 2026년 11월 14일 금요일 ---------------\n${tail}`, TODAY), room(ROLES), "mine").utterances;
  assert.deepEqual(again.map((u) => u.id), mine.slice(1).map((u) => u.id));
  const other = kakaoSelection(parsed, room(ROLES, "room2"), "mine").utterances;
  assert.notEqual(other[0].id, mine[0].id); // 방이 다르면 다른 id
});

test("같은 분 같은 글은 순번으로 구분하고, 긴 메시지는 2000자 조각으로 나눠 같은 turnId", () => {
  const same = parseKakao("[김가명] [오후 3:12] ㅇㅋ\n[김가명] [오후 3:12] ㅇㅋ", TODAY);
  const ids = kakaoSelection(same, room(ROLES), "mine").utterances.map((u) => u.id);
  assert.equal(new Set(ids).size, 2);
  assert.match(ids[1], /:1:0$/);
  const long = parseKakao(`[김가명] [오후 3:12] ${"가".repeat(MAX_PIECE + 10)}`, TODAY);
  const pieces = kakaoSelection(long, room(ROLES), "mine").utterances;
  assert.equal(pieces.length, 2);
  assert.ok(pieces.every((u) => u.text.length <= MAX_PIECE));
  assert.equal(pieces[0].turnId, pieces[1].turnId);
  assert.deepEqual(pieces.map((u) => u.id.split(":").pop()), ["0", "1"]);
});

test("대화 덩어리: 10분 넘게 끊기면 새 turnId, 20개를 넘어도 새 turnId", () => {
  const gap = parseKakao("[김가명] [오후 3:00] 하나\n[김가명] [오후 3:10] 둘\n[김가명] [오후 3:21] 셋", TODAY);
  const turns = kakaoSelection(gap, room(ROLES), "mine").utterances.map((u) => u.turnId);
  assert.equal(turns[0], turns[1]);
  assert.notEqual(turns[1], turns[2]);
  const many = parseKakao(Array.from({ length: 21 }, (_, i) => `[김가명] [오후 3:00] 메시지 ${i}`).join("\n"), TODAY);
  const t = kakaoSelection(many, room(ROLES), "mine").utterances.map((u) => u.turnId);
  assert.equal(new Set(t.slice(0, 20)).size, 1);
  assert.notEqual(t[20], t[0]);
});

test("기본 역할: 내 이름은 나, 아는 팀원 이름은 팀원, 나머지는 빼기", () => {
  assert.deepEqual(defaultRole("김가명", "김가명", ["김가명", "이가짜"]), { kind: "me" });
  assert.deepEqual(defaultRole("이가짜", "김가명", ["김가명", "이가짜"]), { kind: "member", name: "이가짜" });
  assert.deepEqual(defaultRole("박조교", "김가명", ["김가명", "이가짜"]), { kind: "skip" });
});

test("수집기로 가는 메시지: 카톡은 site·turnId 를 그대로, 예전 붙여넣기는 예전처럼", () => {
  const [kakao] = toMessages(kakaoSelection(parseKakao(PC, TODAY), room(ROLES), "mine").utterances);
  assert.equal(kakao.site, "manual");
  assert.equal(kakao.role, "user");
  assert.equal(kakao.roleGuessed, false);
  assert.match(kakao.turnId, /^kakao:room1:/);
  assert.equal(kakao.conversationId, "kakao:room1");
  const [pasted] = toMessages(parsePasted("나: 주제는 청년 주거로 하자", "직접 입력"));
  assert.equal(pasted.site, "manual");
  assert.equal("turnId" in pasted, false);
  const [exported] = toMessages([{ id: "m1", conversationId: "c1", speaker: "user", text: "hi", source: "x", roleGuessed: false }]);
  assert.equal(exported.site, "chatgpt-export");
});

test("'팀 전체'의 여러 줄 팀원 메시지는 줄마다 이름을 붙이고, 목업 분류기는 같은 줄 뒤 문장에도 화자를 잇는다", () => {
  const { mockClassify } = load("@shared/classify");
  const p = parseKakao("[이가짜] [오후 3:12] 좋아. 자막은 내가 일요일까지 넣을게\n발표는 내가 할게\n[김가명] [오후 3:13] 고마워", TODAY);
  const s = kakaoSelection(p, room(ROLES), "team");
  assert.equal(s.utterances[0].text, "[이서준] 좋아. 자막은 내가 일요일까지 넣을게\n[이서준] 발표는 내가 할게");
  const cards = mockClassify(s.utterances, { userName: "김가명", knownNames: ["김가명", "이서준"], existingTopicKeys: [] });
  const owners = cards.filter((c) => c.relevance === "related" && c.tag === "todo").map((c) => c.owner);
  assert.deepEqual(owners, ["이서준", "이서준"]); // 자막은 내가 … / 발표는 내가 … 둘 다 그 줄의 화자
  const decided = cards.filter((c) => c.relevance === "related" && c.tag === "decision").map((c) => c.owner);
  assert.ok(decided.every((o) => o === "이서준"), JSON.stringify(cards.map((c) => [c.tag, c.owner, c.sentence])));
});
