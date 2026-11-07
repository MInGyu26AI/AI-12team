// ChatGPT 내보내기(zip 또는 conversations.json)를 브라우저 안에서만 연다.
// 원본 파일은 어디로도 전송하지 않는다 (CLAUDE.md §9).
import JSZip from "jszip";
import type { Utterance } from "./classify";
import { nowSource } from "./classify";

interface RawNode {
  parent?: string | null;
  message?: {
    author?: { role?: string };
    content?: { parts?: unknown[] };
    create_time?: number | null;
  } | null;
}
interface RawConversation {
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

const toDate = (sec?: number | null) => (sec ? new Date(sec * 1000) : null);

function toUtterances(conv: RawConversation): Utterance[] {
  const mapping = conv.mapping ?? {};
  // current_node 에서 parent 를 따라 올라가면 화면에 보이던 대화 한 줄기
  const chain: RawNode[] = [];
  let id = conv.current_node;
  while (id && mapping[id]) {
    chain.push(mapping[id]!);
    id = mapping[id]!.parent ?? undefined;
  }
  chain.reverse();

  const out: Utterance[] = [];
  for (const node of chain) {
    const m = node.message;
    const role = m?.author?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = (m?.content?.parts ?? []).filter((p): p is string => typeof p === "string").join("\n").trim();
    if (!text) continue;
    const at = toDate(m?.create_time) ?? toDate(conv.create_time) ?? new Date();
    out.push({ speaker: role === "user" ? "user" : "ai", text, source: nowSource("ChatGPT", at) });
  }
  return out;
}

export async function readChatGPTExport(file: File): Promise<ExportConversation[]> {
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
      utterances: toUtterances(c),
    }))
    .filter((c) => c.utterances.length > 0)
    .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
}
