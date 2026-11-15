// 구획 → 수집기 발화 (turns.append, site 'file-upload')
// 규칙 (수집기와 맞춘 계약):
//   conversationId = 'file-upload:' + sourceId           sourceId = 파일 바이트 SHA-256 의 앞 16자리(16진수)
//   turnId         = 'file-upload:' + sourceId + ':' + 구획 번호
//   id             = 'file-upload:' + sourceId + ':' + sha256(조각).slice(0,12) + ':' + 조각 번호(구획 안, 0부터)
//   collectedAt    = 파일 lastModified, 시간대(+09:00 같은 오프셋) 포함 ISO
// 같은 파일을 다시 올리면 모든 id 가 같아서 수집기가 '이미 보낸 내용'으로 알아본다.
import { FileImportError, type FileUploadMessage, type ParsedSection } from "./types";
import { chunkSection, MAX_CHUNK_CHARS, normalizeText } from "./text";

/** 한 파일에서 올리는 조각 수 상한. 넘으면 앞쪽만 올리고 알린다 */
export const MAX_CHUNKS_PER_FILE = 3000;

const toHex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new FileImportError("이 주소에서는 파일을 확인할 수 없어요. https 주소나 localhost 에서 열어 주세요.");
  return s;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return toHex(await subtle().digest("SHA-256", bytes as BufferSource));
}

/** 파일 바이트의 SHA-256 앞 16자리 */
export const sourceIdOf = async (bytes: ArrayBuffer | Uint8Array) => (await sha256Hex(bytes)).slice(0, 16);

/** 밀리초 → "2026-11-15T10:30:00+09:00". offsetMinutes 는 UTC 보다 앞선 분(한국 540), 빠뜨리면 이 브라우저의 시간대 */
export function isoWithOffset(ms: number, offsetMinutes?: number): string {
  const at = Number.isFinite(ms) && ms > 0 ? ms : Date.now();
  const offset = offsetMinutes ?? -new Date(at).getTimezoneOffset();
  const shifted = new Date(at + offset * 60000).toISOString().slice(0, 19); // 시간대만큼 옮긴 UTC 필드 = 그 시간대의 벽시계
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${shifted}${sign}${hh}:${mm}`;
}

export interface BuiltMessages {
  messages: FileUploadMessage[];
  truncated: boolean; // MAX_CHUNKS_PER_FILE 를 넘어 뒤쪽을 올리지 않음
}

export async function buildMessages(input: {
  sourceId: string;
  sections: ParsedSection[];
  collectedAt: string;
  maxChunks?: number;
}): Promise<BuiltMessages> {
  const { sourceId, sections, collectedAt } = input;
  const maxChunks = input.maxChunks ?? MAX_CHUNKS_PER_FILE;
  const conversationId = `file-upload:${sourceId}`;
  const messages: FileUploadMessage[] = [];
  let truncated = false;
  for (const [position, section] of sections.entries()) {
    const sectionIndex = section.index ?? position;
    const chunks = chunkSection(section, MAX_CHUNK_CHARS);
    for (const [chunkIndex, chunk] of chunks.entries()) {
      if (messages.length >= maxChunks) {
        truncated = true;
        break;
      }
      const text = normalizeText(chunk);
      messages.push({
        id: `file-upload:${sourceId}:${(await sha256Hex(text)).slice(0, 12)}:${chunkIndex}`,
        text,
        conversationId,
        site: "file-upload",
        role: "user",
        collectedAt,
        turnId: `file-upload:${sourceId}:${sectionIndex}`,
      });
    }
    if (truncated) break;
  }
  return { messages, truncated };
}
