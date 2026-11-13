// ChatGPT 대화 JSON(mapping / current_node) 공용 파서. 확장의 탭 클라이언트(계정 동기화)와 웹의 내보내기 파일 읽기가 같이 쓴다.
// 규칙은 docs/sync-contract.md 6장(설계 문서 6장). 기준은 extension/tests/fixtures/chatgpt/ 의 픽스처다.
import type { SyncWindow } from "./bridge";

// ── 원본 모양 (필요한 필드만, 모두 선택. 모양 검사는 탭 클라이언트가 한다) ──
export interface RawMessage {
  id?: string;
  author?: { role?: string };
  recipient?: string | null;
  create_time?: number | null; // 유닉스 초(소수)
  status?: string;
  end_turn?: boolean | null;
  content?: { content_type?: string; parts?: unknown[] };
  metadata?: {
    is_complete?: boolean;
    finish_details?: { type?: string };
    is_visually_hidden_from_conversation?: boolean;
    is_thinking_preamble_message?: boolean;
    model_dil_v2?: { fallbackMarkdown?: string };
    content_references?: { matched_text?: string }[];
    [key: string]: unknown;
  };
}

export interface RawNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: RawMessage | null;
}

export interface RawConversation {
  id?: string;
  conversation_id?: string;
  title?: string;
  create_time?: number | string;
  update_time?: number | string;
  current_node?: string;
  mapping?: Record<string, RawNode>;
}

// ── 정규화 결과 ──
export interface NormalizedMessage {
  id: string; // ChatGPT message.id (접두사 없음). 확장은 'chatgpt:' 를 붙여 보낸다
  role: "user" | "assistant";
  text: string;
  createdAt: string | null; // ISO. create_time 이 없으면 null
}

// 사용자 메시지 하나와 그 뒤 답변들. 답변 노드가 여러 개여도 합치지 않는다
export interface NormalizedTurn {
  turnId: string; // 사용자 메시지 id. 사용자 메시지 없이 시작하는 앞쪽 답변은 첫 답변 id
  messages: NormalizedMessage[];
  start: string | null; // 턴 안 메시지 시각의 최소 (ISO). 시각 없는 메시지가 있으면 null
  end: string | null; // 최대
  complete: boolean; // 마지막 보이는 assistant 노드가 finished_successfully + end_turn=true 인지 (사용자가 멈춘 답도 완료). 보이는 답이 없으면 false
}

export interface NormalizedConversation {
  turns: NormalizedTurn[]; // 대화 순서
  inProgress: boolean; // 마지막 턴이 미완료 (답변이 생성 중이거나 보이는 답이 아직 없음)
  inProgressAt: string | null; // 미완료인 마지막 턴의 메시지 시각 가운데 가장 늦은 것 (ISO). 완료됐거나 시각이 없으면 null
}

// ── 줄기 ──
const CYCLE_ERROR = "대화 파일의 연결 구조가 잘못되었습니다.";
const nodeAt = (mapping: Record<string, RawNode>, id: string | null | undefined): RawNode | undefined =>
  id != null && Object.prototype.hasOwnProperty.call(mapping, id) ? mapping[id] : undefined;

/** 유닉스 초(소수) → 밀리초. 없거나 0 이하이거나 날짜로 바꿀 수 없으면 null */
function msOf(sec: unknown): number | null {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec <= 0) return null;
  const ms = Math.round(sec * 1000);
  return Number.isNaN(new Date(ms).getTime()) ? null : ms;
}

/** current_node 가 없을 때 끝점: 자식이 없는 노드 가운데 create_time 이 가장 늦은 것 */
function latestLeaf(mapping: Record<string, RawNode>): string | undefined {
  const parents = new Set<string>();
  for (const node of Object.values(mapping)) if (node?.parent) parents.add(node.parent);
  let best: string | undefined;
  let bestMs = -Infinity;
  for (const [id, node] of Object.entries(mapping)) {
    if (!node || node.children?.length || parents.has(id)) continue;
    const ms = msOf(node.message?.create_time) ?? -Infinity;
    if (best === undefined || ms >= bestMs) {
      best = id;
      bestMs = ms;
    }
  }
  return best;
}

/** current_node 에서 parent 를 따라 올라가면 화면에 보이던 줄기 (처음부터 순서대로). 연결이 돌면 Error */
function trunkOf(conv: RawConversation): { nodeId: string; node: RawNode }[] {
  const mapping = conv.mapping ?? {};
  const out: { nodeId: string; node: RawNode }[] = [];
  const seen = new Set<string>();
  let id: string | undefined = conv.current_node ? conv.current_node : latestLeaf(mapping);
  for (let node = nodeAt(mapping, id); id !== undefined && node; node = nodeAt(mapping, id)) {
    if (seen.has(id)) throw new Error(CYCLE_ERROR);
    seen.add(id);
    out.push({ nodeId: id, node });
    id = node.parent ?? undefined;
  }
  return out.reverse();
}

// ── 빼는 메시지와 본문 ──
const SKIPPED_CONTENT_TYPES = new Set(["code", "execution_output", "user_editable_context", "model_editable_context", "thoughts", "reasoning_recap"]);
const isSkippedContentType = (type: string | undefined) => !!type && (type.startsWith("tether_") || SKIPPED_CONTENT_TYPES.has(type));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** 본문 규칙 1~5 (6장). 첨부만 있으면 "[첨부 N개]" 한 줄이 본문이 된다 */
function bodyOf(m: RawMessage): string {
  const parts = Array.isArray(m.content?.parts) ? m.content.parts : [];
  const multimodal = m.content?.content_type === "multimodal_text";
  const texts: string[] = [];
  let attachments = 0;
  for (const part of parts) {
    if (typeof part === "string") texts.push(part);
    else if (multimodal && isRecord(part) && part.content_type === "audio_transcription" && typeof part.text === "string") texts.push(part.text);
    else attachments += 1;
  }
  let text = texts.join("\n");
  if (attachments > 0) text = `[첨부 ${attachments}개]\n${text}`;
  if (!text.trim()) {
    const fallback = m.metadata?.model_dil_v2?.fallbackMarkdown;
    if (typeof fallback === "string") text = fallback;
  }
  for (const ref of m.metadata?.content_references ?? []) {
    if (typeof ref?.matched_text === "string" && ref.matched_text) text = text.split(ref.matched_text).join("");
  }
  return text.trim();
}

/** 화면에 보이는 사용자·assistant 메시지만 (빼는 메시지는 null) */
function visibleMessage(m: RawMessage, nodeId: string): NormalizedMessage | null {
  const role = m.author?.role;
  if (role !== "user" && role !== "assistant") return null;
  if (m.recipient !== undefined && m.recipient !== null && m.recipient !== "all") return null;
  if (isSkippedContentType(m.content?.content_type)) return null;
  if (m.metadata?.is_visually_hidden_from_conversation || m.metadata?.is_thinking_preamble_message) return null;
  const text = bodyOf(m);
  if (!text) return null;
  const ms = msOf(m.create_time);
  return { id: m.id ?? nodeId, role, text, createdAt: ms === null ? null : new Date(ms).toISOString() };
}

// ── 턴과 완료 ──
/**
 * 턴의 마지막 보이는 assistant 노드가 끝났는지 (P7 실측으로 확정).
 * status 가 finished_successfully 이고 end_turn 이 true 일 때만 완료다. is_complete·finish_details 는 쓰지 않는다:
 * 도구 호출 노드(recipient=web.run 등)는 최종 답이 생성 중일 때도 완료 표시를 달고 있고, 사용자가 멈춘 답도 같은 값이다.
 */
const isDone = (m: RawMessage): boolean => m.status === "finished_successfully" && m.end_turn === true;

interface TurnDraft {
  turnId: string;
  messages: NormalizedMessage[];
  lastAnswer: RawMessage | null;
}

/** 시각이 있는 메시지 가운데 가장 늦은 것 (ISO). 하나도 없으면 null */
function latestTime(messages: NormalizedMessage[]): string | null {
  const times = messages.flatMap((m) => (m.createdAt === null ? [] : [Date.parse(m.createdAt)]));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/** 화면에 보이던 줄기를 정규화한다. 빼는 메시지·본문·완료 규칙은 6장. 연결 구조가 돌면 Error */
export function normalizeConversation(conv: RawConversation): NormalizedConversation {
  const drafts: TurnDraft[] = [];
  let current: TurnDraft | null = null;
  for (const { nodeId, node } of trunkOf(conv)) {
    const raw = node.message;
    const message = raw ? visibleMessage(raw, nodeId) : null;
    if (!raw || !message) continue;
    // 사용자 메시지마다 새 턴. 첫 사용자 메시지 앞의 답변은 첫 답변 id 를 turnId 로 하는 턴 하나로 묶는다
    if (message.role === "user" || !current) {
      current = { turnId: message.id, messages: [], lastAnswer: null };
      drafts.push(current);
    }
    current.messages.push(message);
    if (message.role === "assistant") current.lastAnswer = raw;
  }

  const turns = drafts.map<NormalizedTurn>(({ turnId, messages, lastAnswer }) => {
    const times = messages.map((m) => (m.createdAt === null ? null : Date.parse(m.createdAt)));
    const timed = times.every((t): t is number => t !== null);
    return {
      turnId,
      messages,
      start: timed ? new Date(Math.min(...times)).toISOString() : null,
      end: timed ? new Date(Math.max(...times)).toISOString() : null,
      complete: lastAnswer !== null && isDone(lastAnswer),
    };
  });
  const last = turns.at(-1);
  const inProgress = last?.complete === false;
  return { turns, inProgress, inProgressAt: last && inProgress ? latestTime(last.messages) : null };
}

/** 턴 전체가 어느 한 창 안에 있는 완료 턴만 (start ≥ 창 시작, end < 창 끝). 시각 없는 턴은 뺀다 */
export function turnsInWindows(turns: NormalizedTurn[], windows: SyncWindow[]): NormalizedTurn[] {
  const spans = windows.map((w) => [Date.parse(w.start), Date.parse(w.end)] as const).filter(([s, e]) => !Number.isNaN(s) && !Number.isNaN(e));
  return turns.filter((turn) => {
    if (!turn.complete || turn.start === null || turn.end === null) return false;
    const start = Date.parse(turn.start);
    const end = Date.parse(turn.end);
    return spans.some(([from, to]) => start >= from && end < to);
  });
}
