// 글 파일(.md·.txt) 바이트 → 글자. 한국 윈도우의 메모장 저장본(CP949)과 UTF-16 도 읽는다.

/** BOM 이 있으면 그 인코딩, 아니면 UTF-8 로 읽어 보고 깨지면 EUC-KR(CP949 포함) */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes); // UTF-8 BOM 은 떼어진다
  } catch {
    try {
      return new TextDecoder("euc-kr").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes); // 이 환경에 EUC-KR 이 없으면 깨진 글자는 대체 문자로
    }
  }
}
