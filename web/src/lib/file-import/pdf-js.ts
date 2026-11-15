// pdf.js 어댑터 (브라우저 전용). 화면 컴포넌트가 정적으로 가져오지 말고 import() 로 필요할 때만 불러온다
// (서버 렌더링에서 pdf.js 가 실행되지 않게).
import { OCR_MAX_CALL_CHARS } from "./ocr-types";
import { joinTextItems, type PdfSource, type PdfTextItem } from "./pdf";
import { FileImportError } from "./types";

const TARGET_SCALE = 2; // 72dpi 의 2배
const MAX_SIDE_PX = 2000; // 긴 변 상한
// 큰 PNG 는 JPEG 로 줄여 보낸다 (스캔 쪽 PNG 는 수 MB 가 된다)
const JPEG_QUALITIES = [0.85, 0.6];

let configured = false;

async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  if (!configured) {
    // 번들러가 워커 파일을 같은 출처의 정적 파일로 내보낸다
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    configured = true;
  }
  return pdfjs;
}

/** base64 본문만 (data:...;base64, 머리를 뗀다) */
const base64Body = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(",") + 1);

function encodeCanvas(canvas: HTMLCanvasElement): string | null {
  const png = base64Body(canvas.toDataURL("image/png"));
  if (png.length <= OCR_MAX_CALL_CHARS / 2) return png;
  for (const quality of JPEG_QUALITIES) {
    const jpeg = base64Body(canvas.toDataURL("image/jpeg", quality));
    if (jpeg.length <= OCR_MAX_CALL_CHARS) return jpeg;
  }
  return null;
}

/** PDF 바이트를 연다. 쓰고 나면 destroy() */
export async function openPdfJs(bytes: Uint8Array): Promise<PdfSource & { destroy(): Promise<void> }> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }); // 워커가 버퍼를 가져가므로 사본을 준다
  let doc;
  try {
    doc = await task.promise;
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "PasswordException") throw new FileImportError("암호가 걸린 PDF는 읽을 수 없어요. 암호를 푼 파일을 올려 주세요.");
    throw new FileImportError("PDF 파일을 열 수 없어요. 손상된 파일일 수 있어요.");
  }
  return {
    numPages: doc.numPages,
    async getText(pageNumber) {
      const page = await doc.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        return joinTextItems(content.items as PdfTextItem[]);
      } finally {
        page.cleanup();
      }
    },
    async renderPage(pageNumber) {
      const page = await doc.getPage(pageNumber);
      const canvas = document.createElement("canvas");
      try {
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(TARGET_SCALE, MAX_SIDE_PX / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale });
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const context = canvas.getContext("2d");
        if (!context) return { ok: false, reason: "render_failed" };
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        const image = encodeCanvas(canvas);
        return image ? { ok: true, image } : { ok: false, reason: "too_large" };
      } catch {
        return { ok: false, reason: "render_failed" };
      } finally {
        canvas.width = 0; // 메모리를 바로 돌려준다
        canvas.height = 0;
        page.cleanup();
      }
    },
    destroy: () => doc.destroy(),
  };
}
