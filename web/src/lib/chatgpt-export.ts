// ChatGPT 내보내기(zip 또는 conversations.json)를 브라우저 안에서만 연다.
// 원본 파일은 어디로도 전송하지 않는다 (CLAUDE.md §9).
import JSZip from "jszip";
import { formatSource } from "@shared/format";
import type { Utterance } from "@shared/utterance";

interface RawNode {
  parent?: string | null;
  message?: {
    author?: { role?: string };
    content?: { parts?: unknown[] };
    create_time?: number | null;
  } | null;
}
interface RawConversation {
  id?: string;
  title?: string;
  create_time?: number;
  current_node?: string;
  mapping?: Record<string, RawNode>;
}

export interface ExportConversation {
  id: string;
  title: string;
  date: Date | null;
  utterances: Utterance[];
}

const MAX_EXPORT_BYTES = 50 * 1024 * 1024;
const toDate = (sec?: number | null) => (sec ? new Date(sec * 1000) : null);

// current_node 에서 parent 를 따라 올라가면 화면에 보이던 대화 한 줄기 (처음 발화부터 순서대로)
function visibleBranch(conv: RawConversation): { id: string; node: RawNode }[] {
  const mapping = conv.mapping ?? {};
  const branch: { id: string; node: RawNode }[] = [];
  const seen = new Set<string>();
  let id = conv.current_node;
  while (id && mapping[id]) {
    if (seen.has(id)) throw new Error("대화 파일의 연결 구조가 잘못되었습니다.");
    seen.add(id);
    branch.push({ id, node: mapping[id] });
    id = mapping[id].parent ?? undefined;
  }
  return branch.reverse();
}

function toUtterances(conv: RawConversation, conversationId: string): Utterance[] {
  const out: Utterance[] = [];
  for (const { id, node } of visibleBranch(conv)) {
    const m = node.message;
    const role = m?.author?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = (m?.content?.parts ?? []).filter((p): p is string => typeof p === "string").join("\n").trim();
    if (!text) continue;
    const at = toDate(m?.create_time) ?? toDate(conv.create_time) ?? new Date();
    out.push({
      id,
      conversationId,
      collectedAt: at.toISOString(),
      roleGuessed: false,
      speaker: role === "user" ? "user" : "ai",
      text,
      source: formatSource("ChatGPT", at),
    });
  }
  return out;
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
