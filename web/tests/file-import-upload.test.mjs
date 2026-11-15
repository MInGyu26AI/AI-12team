// 자료 올리기: 한 파일의 올리기 흐름과 결과 문구 (src/lib/file-import/upload.ts, mock.ts)
import assert from "node:assert/strict";
import test from "node:test";
import { load } from "./load-ts.mjs";

const { uploadFile } = load("@/lib/file-import/upload");
const { toMockUtterances } = load("@/lib/file-import/mock");

const mdFile = (text, name = "회의.md") => new File([text], name, { lastModified: Date.UTC(2026, 10, 15, 1, 0, 0) });
const pdfSource = (pages) => ({
  numPages: pages.length,
  getText: async (n) => pages[n - 1],
  renderPage: async () => ({ ok: true, image: "AAAA" }),
});

test("실제 모드: 읽고 → 보내고 → 수집기가 알려 준 개수로 결과를 만든다, 진행 단계를 차례로 알린다", async () => {
  const phases = [];
  const sentBatches = [];
  const outcome = await uploadFile(mdFile("# 결정\n금요일 발표\n\n## 근거\n일정이 빠듯"), {
    mock: false,
    ocr: null,
    send: async (messages, onProgress) => {
      sentBatches.push(messages);
      onProgress(messages.length, messages.length);
      return { sent: messages.length, stored: messages.length, quarantined: 0, teamRecord: 0, elsewhere: 0 };
    },
    onPhase: (p) => phases.push(p),
  });
  assert.equal(sentBatches.length, 1);
  assert.equal(sentBatches[0].length, 2);
  assert.deepEqual(phases, [{ phase: "reading" }, { phase: "sending", done: 0, total: 2 }, { phase: "sending", done: 2, total: 2 }]);
  assert.equal(outcome.tone, "success");
  assert.equal(outcome.text, "2조각을 분류 대기함에 넣었어요. 분류가 끝나면 승인함에 올라와요.");
  assert.equal(outcome.summary.stored, 2);
});

test("실제 모드: 읽지 못한 쪽이 있으면 성공이라고 하지 않고 쪽 수를 알린다 (나머지는 올린다)", async () => {
  const sent = [];
  const outcome = await uploadFile(new File(["%PDF"], "스캔.pdf"), {
    mock: false,
    ocr: async (pages) => pages.map((p) => ({ page: p.page, ok: false, reason: "model_unavailable" })),
    send: async (messages) => {
      sent.push(...messages);
      return { sent: messages.length, stored: messages.length, quarantined: 0, teamRecord: 0, elsewhere: 0 };
    },
    // pdf.js 대신 가짜 쪽: 첫 쪽은 글자, 둘째·셋째는 글자 없음
    openPdf: async () => pdfSource(["첫 쪽에는 글자가 충분히 들어 있습니다. 가나다라마바사", "", ""]),
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^\[스캔\.pdf · 1쪽\]\n/);
  assert.equal(outcome.tone, "warning");
  assert.equal(outcome.text, "1조각을 분류 대기함에 넣었어요. 분류가 끝나면 승인함에 올라와요. 읽지 못한 2쪽은 올리지 않았어요.");
  assert.deepEqual(outcome.read.unread.map((u) => [u.page, u.reason]), [[2, "model_unavailable"], [3, "model_unavailable"]]);
});

test("모든 쪽을 읽지 못했으면 보내지 않고, 읽지 못한 쪽을 알린다", async () => {
  let called = false;
  const outcome = await uploadFile(new File(["%PDF"], "스캔.pdf"), {
    mock: false,
    ocr: null, // 글자 인식을 쓸 수 없는 화면
    send: async () => {
      called = true;
      return { sent: 0, stored: 0, quarantined: 0, teamRecord: 0, elsewhere: 0 };
    },
    openPdf: async () => pdfSource(["", ""]),
  });
  assert.equal(called, false);
  assert.equal(outcome.text, "올릴 수 있는 내용이 없어요. 읽지 못한 2쪽은 올리지 않았어요.");
  assert.deepEqual(outcome.read.unread.map((u) => u.reason), ["ocr_off", "ocr_off"]);
});

test("읽을 내용이 없으면 보내지 않고 경고로 알린다", async () => {
  let called = false;
  const outcome = await uploadFile(mdFile("# 제목만 있고 본문이 없다\n"), {
    mock: false,
    ocr: null,
    send: async () => {
      called = true;
      return { sent: 0, stored: 0, quarantined: 0, teamRecord: 0, elsewhere: 0 };
    },
  });
  assert.equal(called, false);
  assert.equal(outcome.tone, "warning");
  assert.equal(outcome.text, "올릴 수 있는 내용이 없어요.");
  assert.equal(outcome.summary, null);
});

test("수집기 오류는 그대로 던진다 (성공처럼 보이지 않게)", async () => {
  await assert.rejects(
    uploadFile(mdFile("# a\nb"), {
      mock: false,
      ocr: null,
      send: async () => {
        throw new Error("로컬 수집기 실행 상태와 연결 파일을 확인하세요.");
      },
    }),
    /연결 파일을 확인하세요/,
  );
});

test("목업 모드: 수집기로 보내지 않고 읽기까지만", async () => {
  const outcome = await uploadFile(mdFile("# a\nb"), {
    mock: true,
    ocr: null,
    send: async () => assert.fail("목업 모드는 보내면 안 된다"),
  });
  assert.equal(outcome.tone, "success");
  assert.equal(outcome.text, "1조각을 읽었어요.");
  assert.equal(outcome.read.messages.length, 1);
});

test("목업 발화: 조각의 제목 줄은 떼고 본문을 사용자 발화로, 출처는 파일 이름", async () => {
  const outcome = await uploadFile(mdFile("# 결정\n금요일에 발표하기로 했다.", "회의, 최종.md"), { mock: true, ocr: null, send: async () => assert.fail() });
  const [u] = toMockUtterances("회의, 최종.md", outcome.read.messages, new Date(2026, 10, 15, 10, 30));
  assert.equal(u.text, "금요일에 발표하기로 했다.");
  assert.equal(u.speaker, "user");
  assert.equal(u.roleGuessed, false);
  assert.equal(u.source, "회의, 최종.md, 2026-11-15 10:30");
  assert.equal(u.id, outcome.read.messages[0].id);
});
