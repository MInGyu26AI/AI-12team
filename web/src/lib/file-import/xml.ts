// 작은 XML 읽기 (Word·한글 문서의 XML 용). DOMParser 가 없는 환경(시험)에서도 같게 돌도록 직접 읽는다.
// 이름은 접두사 그대로("w:p"). 네임스페이스는 풀지 않는다. 틀린 XML 은 가능한 만큼만 읽는다.
import JSZip from "jszip";
import { FileImportError } from "./types";

export interface XmlNode {
  name: string; // 태그 이름, 글자 노드는 "#text"
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string; // 글자 노드의 내용
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[body] ?? whole;
  });
}

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/?)([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const textNode = (text: string): XmlNode => ({ name: "#text", attrs: {}, children: [], text });
  for (const m of xml.matchAll(TOKEN)) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) {
      top.children.push(textNode(m[1])); // CDATA
    } else if (m[3] !== undefined) {
      const [, , closing, name, rawAttrs, selfClosing] = m;
      if (closing) {
        // 맞는 여는 태그까지 닫는다. 없으면 무시
        const at = stack.map((n) => n.name).lastIndexOf(name!);
        if (at > 0) stack.length = at;
      } else {
        const node: XmlNode = { name: name!, attrs: {}, children: [], text: "" };
        for (const a of rawAttrs!.matchAll(ATTR)) node.attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? "");
        top.children.push(node);
        if (!selfClosing) stack.push(node);
      }
    } else if (m[6] !== undefined) {
      top.children.push(textNode(decodeEntities(m[6])));
    }
  }
  return root;
}

/** 후손 중 이름이 맞는 노드를 문서 순서대로 */
export function findAll(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const child of node.children) {
    if (child.name === name) out.push(child);
    findAll(child, name, out);
  }
  return out;
}

export const findFirst = (node: XmlNode, name: string): XmlNode | undefined => findAll(node, name)[0];
export const childrenNamed = (node: XmlNode, name: string) => node.children.filter((c) => c.name === name);
export const childNamed = (node: XmlNode, name: string) => node.children.find((c) => c.name === name);

/** 노드 아래 글자 노드를 모두 이은 글자 */
export function textOf(node: XmlNode): string {
  if (node.name === "#text") return node.text;
  return node.children.map(textOf).join("");
}

// 압축을 풀면 이보다 크게 불어나는 파일은 열지 않는다 (압축 폭탄 방지)
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

/** zip 열기. 열 수 없으면 읽을 수 있는 한국어 오류 */
export async function openZip(bytes: ArrayBuffer, label: string): Promise<JSZip> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    let total = 0;
    for (const entry of Object.values(zip.files)) {
      total += (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    }
    if (total > MAX_UNCOMPRESSED_BYTES) throw new FileImportError(`${label} 파일이 너무 커서 열 수 없어요.`);
    return zip;
  } catch (error) {
    if (error instanceof FileImportError) throw error;
    throw new FileImportError(`${label} 파일을 열 수 없어요. 손상됐거나 암호가 걸린 파일일 수 있어요.`);
  }
}

/** zip 안 파일을 글자로. 없으면 null */
export async function readZipText(zip: JSZip, path: string): Promise<string | null> {
  const entry = zip.file(path);
  return entry ? entry.async("string") : null;
}
