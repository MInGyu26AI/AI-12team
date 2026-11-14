// 자료 올리기(파일 → 로컬 수집기 turns.append) 공용 모양.
// 파일은 이 브라우저에서만 읽고, 마음대로 보내는 곳은 없다 (수집기 RPC 하나뿐).

/** 파서가 돌려주는 한 구획: 마크다운·Word 제목 하나, PDF 한 쪽, 엑셀 시트 하나 */
export interface ParsedSection {
  heading: string; // 한 줄. 모든 조각의 첫 줄이 된다 (예: "[계획서.pdf · 3쪽]" · "## 설계 원칙")
  text: string; // 제목을 뺀 본문
  /** 조각이 둘 이상이면 둘째 조각부터 제목 밑에 다시 붙이는 줄 (표의 머리글 행) */
  repeat?: string;
  /** turnId 에 쓰는 구획 번호. 빠뜨리면 목록 위치. 빈 구획·읽지 못한 쪽이 빠져도 번호가 밀리지 않게 파서가 원래 위치를 준다 */
  index?: number;
}

export interface ParseResult {
  sections: ParsedSection[];
  warnings: string[];
}

/** 글자 인식(files.ocr)이 읽지 못한 쪽의 이유. 앞의 넷은 수집기 응답 그대로, 뒤는 웹이 붙인다 */
export type UnreadReason =
  | "model_unavailable"
  | "empty"
  | "too_large"
  | "bad_image"
  | "ocr_off" // 목업 모드 등 글자 인식을 쓸 수 없는 경우
  | "render_failed" // 쪽을 그림으로 만들지 못함
  | "rpc_error"; // 수집기에 요청하지 못했거나 응답에 그 쪽이 없음

export interface UnreadPage {
  page: number;
  reason: UnreadReason;
  detail?: string; // 수집기 오류 문구 등
}

export interface PdfParseResult extends ParseResult {
  unread: UnreadPage[];
  totalPages: number;
  ocrPages: number; // 글자 인식으로 읽은 쪽 수
}

/** 수집기 turns.append 가 받는 파일 올리기 발화 (shared/collector.ts CollectedMessage 의 site 'file-upload' 모양) */
export interface FileUploadMessage {
  id: string;
  text: string;
  conversationId: string;
  site: "file-upload";
  role: "user";
  collectedAt: string; // ISO, 시간대 포함 (수집기는 시간대가 없는 시각을 거절한다)
  turnId: string;
}

/** 사용자에게 그대로 보여 줘도 되는 파일 처리 오류 */
export class FileImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileImportError";
  }
}

export type FileKind = "markdown" | "text" | "docx" | "xlsx" | "pdf" | "hwpx";
