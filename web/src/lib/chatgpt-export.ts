// ChatGPT 내보내기(zip 또는 conversations.json)를 브라우저 안에서만 연다.
// 원본 파일은 어디로도 전송하지 않는다 (CLAUDE.md §9).
import JSZip from "jszip";
import { normalizeConversation, type RawConversation } from "@shared/chatgpt-conversation";
import { formatSource } from "@shared/format";
import type { Utterance } from "@shared/utterance";

export interface ExportConversation {
  id: string;
  title: string;
  date: Date | null;
  utterances: Utterance[];
}

const MAX_EXPORT_BYTES = 50 * 1024 * 1024;
const toDate = (sec?: number | string | null) => (typeof sec === "number" && sec ? new Date(sec * 1000) : null);

// 화면에 보이던 대화 한 줄기를 공용 파서(shared/chatgpt-conversation.ts)로 읽는다. 생성 중·미완료 턴도 그대로 넣는다 (파일은 이미 끝난 대화)
function toUtterances(conv: RawConversation, conversationId: string): Utterance[] {
  return normalizeConversation(conv)
    .turns.flatMap((turn) => turn.messages)
    .map((m) => {
      const at = (m.createdAt ? new Date(m.createdAt) : null) ?? toDate(conv.create_time) ?? new Date();
      return {
        id: m.id,
        conversationId,
        collectedAt: at.toISOString(),
        roleGuessed: false,
        speaker: m.role === "user" ? "user" : "ai",
        text: m.text,
        source: formatSource("ChatGPT", at),
      };
    });
}

export async function readChatGPTExport(file: File): Promise<ExportConversation[]> {
  if (file.size > MAX_EXPORT_BYTES) throw new Error("50MB 이하 파일을 선택하세요.");
  let raw: RawConversation[] = [];
  if (file.name.toLowerCase().endsWith(".zip")) {
    const zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files).filter((f) => !f.dir && /(^|\/)conversations[^/]*\.json$/i.test(f.name));
    if (!entries.length) throw new Error("zip 안에 conversations.json 이 없어요");
    for (const e of entries) raw = raw.concat(JSON.parse(await e.async("string")));
  } else {
    raw = JSON.parse(await file.text());
  }
  if (!Array.isArray(raw)) throw new Error("ChatGPT 내보내기 형식이 아니에요");

  return raw
    .map((c, i) => ({
      id: String(i),
      title: c.title?.trim() || "(제목 없음)",
      date: toDate(c.create_time),
      utterances: toUtterances(c, c.id ?? `export-${c.create_time}-${i}`),
    }))
    .filter((c) => c.utterances.length > 0)
    .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
}
