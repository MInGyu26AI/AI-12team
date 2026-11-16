// 고른 사진을 가운데 정사각형으로 잘라 256×256 으로 줄인다 (브라우저 안에서만, 원본은 서버로 보내지 않는다).
// WebP 를 먼저 쓰고 브라우저가 못 만들면 JPEG. 300KB 를 넘으면 화질을 낮춰 한 번 더 시도한다
import { PHOTO_SIZE, PHOTO_TYPES, validatePhotoDataUrl } from "@/lib/profile";

const MAX_SOURCE_BYTES = 20 * 1024 * 1024; // 너무 큰 원본은 열기 전에 거른다

export async function cropToDataUrl(file: File): Promise<string> {
  if (!(PHOTO_TYPES as readonly string[]).includes(file.type)) throw new Error("PNG·JPG·WebP 사진만 올릴 수 있어요.");
  if (file.size > MAX_SOURCE_BYTES) throw new Error("사진 파일이 너무 커요. 20MB 이하 사진을 골라 주세요.");
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error("사진을 열지 못했어요. 다른 사진을 골라 주세요."); }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (!side) throw new Error("사진을 열지 못했어요. 다른 사진을 골라 주세요.");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = PHOTO_SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("이 브라우저에서는 사진을 줄일 수 없어요.");
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
    let url = "";
    for (const quality of [0.85, 0.6]) {
      url = canvas.toDataURL("image/webp", quality);
      if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/jpeg", quality);
      if (validatePhotoDataUrl(url) === null) return url;
    }
    throw new Error("사진이 너무 커요. 더 작은 사진을 골라 주세요.");
  } finally { bitmap.close(); }
}
