// 파일 종류 판별과 지원하지 않는 형식의 안내 (확장자 기준)
import { FileImportError, type FileKind } from "./types";

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const ACCEPT_EXTENSIONS = [".md", ".markdown", ".txt", ".docx", ".xlsx", ".pdf", ".hwpx"];
export const SUPPORTED_LABEL = "md · txt · docx · xlsx · pdf · hwpx";

const KINDS: Record<string, FileKind> = {
  md: "markdown",
  markdown: "markdown",
  txt: "text",
  docx: "docx",
  xlsx: "xlsx",
  pdf: "pdf",
  hwpx: "hwpx",
};
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff", "svg"]);

export const extensionOf = (name: string) => /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";

/** 읽을 수 있는 종류. 아니면 이유와 대안을 담은 한국어 오류 */
export function detectKind(fileName: string): FileKind {
  const ext = extensionOf(fileName);
  const kind = KINDS[ext];
  if (kind) return kind;
  if (ext === "hwp") throw new FileImportError("한글(.hwp) 파일은 아직 읽을 수 없어요. 한글에서 .hwpx 나 PDF로 저장해서 올려 주세요.");
  if (IMAGES.has(ext)) throw new FileImportError("그림 파일은 아직 올릴 수 없어요. 글이 든 그림은 PDF로 만들어 올려 주세요.");
  if (ext === "doc") throw new FileImportError(".doc 은 옛 형식이라 읽을 수 없어요. .docx 로 저장하거나 PDF로 내보내서 올려 주세요.");
  if (ext === "xls") throw new FileImportError(".xls 는 옛 형식이라 읽을 수 없어요. .xlsx 로 저장하거나 PDF로 내보내서 올려 주세요.");
  if (ext === "ppt" || ext === "pptx") throw new FileImportError("발표 자료(.ppt·.pptx)는 아직 읽을 수 없어요. PDF로 내보내서 올려 주세요.");
  throw new FileImportError(`${ext ? `.${ext} ` : "이 "}형식은 읽을 수 없어요. ${SUPPORTED_LABEL} 파일을 올려 주세요.`);
}

/** 올릴 수 있는 파일인지만 가볍게 확인 (목록에 올릴 때). 아니면 오류 문구 */
export function unsupportedReason(fileName: string): string | null {
  try {
    detectKind(fileName);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}
