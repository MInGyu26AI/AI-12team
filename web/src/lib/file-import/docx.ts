// .docx 읽기: word/document.xml 의 문단을 순서대로. 제목(Heading1~3)마다 새 구획, 표는 탭으로 나눈 줄.
// 머리글·꼬리말·각주·그림은 읽지 않는다.
import { fileHeading, finalizeSections, type RawSection } from "./sections";
import { childNamed, childrenNamed, findAll, openZip, parseXml, readZipText, textOf, type XmlNode } from "./xml";
import { FileImportError, type ParseResult } from "./types";

const MAX_HEADING_LEVEL = 3;
// 그대로 안으로 들어가 문단·표를 찾는 껍데기 태그
const CONTAINERS = new Set(["w:sdt", "w:sdtContent", "w:ins", "w:smartTag", "w:customXml", "w:moveTo", "mc:AlternateContent", "mc:Choice"]);

/** styles.xml 에서 스타일 id → 제목 단계(1~) 표. 이름이 "heading 1"/"제목 1"/"title" 이거나 outlineLvl 이 있는 스타일 */
function headingStyles(stylesXml: string | null): Map<string, number> {
  const map = new Map<string, number>();
  if (!stylesXml) return map;
  for (const style of findAll(parseXml(stylesXml), "w:style")) {
    const id = style.attrs["w:styleId"];
    if (!id) continue;
    const name = childNamed(style, "w:name")?.attrs["w:val"] ?? "";
    const outline = findAll(style, "w:outlineLvl")[0]?.attrs["w:val"];
    const byName = /^(?:heading|제목)\s*(\d)$/i.exec(name.trim());
    if (byName) map.set(id, Number(byName[1]));
    else if (/^title$/i.test(name.trim())) map.set(id, 1);
    else if (outline !== undefined && /^\d$/.test(outline)) map.set(id, Number(outline) + 1);
  }
  return map;
}

function paragraphText(p: XmlNode): string {
  let out = "";
  const visit = (node: XmlNode) => {
    switch (node.name) {
      case "w:t":
        out += textOf(node);
        return;
      case "w:tab":
        out += "\t";
        return;
      case "w:br":
      case "w:cr":
        out += "\n";
        return;
      case "w:noBreakHyphen":
        out += "-";
        return;
      case "w:pPr": // 문단 서식 (안의 w:tab 은 탭 위치 설정이다)
      case "mc:Fallback": // 같은 내용을 한 번 더 담은 대체 표현
        return;
    }
    node.children.forEach(visit);
  };
  p.children.forEach(visit);
  return out;
}

function headingLevel(p: XmlNode, styles: Map<string, number>): number | null {
  const pPr = childNamed(p, "w:pPr");
  if (!pPr) return null;
  const styleId = childNamed(pPr, "w:pStyle")?.attrs["w:val"];
  let level: number | undefined = styleId ? styles.get(styleId) : undefined;
  if (level === undefined && styleId) level = Number(/^(?:heading|제목)\s*(\d)$/i.exec(styleId)?.[1]) || undefined; // styles.xml 이 없을 때
  if (level === undefined) {
    const outline = childNamed(pPr, "w:outlineLvl")?.attrs["w:val"];
    if (outline !== undefined && /^\d$/.test(outline)) level = Number(outline) + 1;
  }
  return level && level >= 1 && level <= MAX_HEADING_LEVEL ? level : null;
}

// 표 한 칸: 안의 문단(중첩 표 포함)을 공백으로 이은 한 줄
function cellText(cell: XmlNode): string {
  return findAll(cell, "w:p")
    .map((p) => paragraphText(p).replace(/[\t\n]+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
}

function tableLines(tbl: XmlNode): string[] {
  return childrenNamed(tbl, "w:tr")
    .map((row) => childrenNamed(row, "w:tc").map(cellText).join("\t").replace(/\t+$/, ""))
    .filter((line) => line.trim());
}

export async function parseDocx(bytes: ArrayBuffer, fileName: string): Promise<ParseResult> {
  const zip = await openZip(bytes, "Word");
  const documentXml = await readZipText(zip, "word/document.xml");
  if (!documentXml) throw new FileImportError("Word 문서가 아니에요. word/document.xml 이 없어요.");
  const styles = headingStyles(await readZipText(zip, "word/styles.xml"));
  const body = findAll(parseXml(documentXml), "w:body")[0];
  if (!body) throw new FileImportError("Word 문서에서 본문을 찾지 못했어요.");

  const raw: RawSection[] = [{ heading: fileHeading(fileName), text: "" }];
  let lines: string[] = [];
  const close = () => {
    raw[raw.length - 1]!.text = lines.join("\n");
    lines = [];
  };
  const walk = (nodes: XmlNode[]) => {
    for (const node of nodes) {
      if (node.name === "w:p") {
        const text = paragraphText(node).replace(/[ \t]+$/, "").trim();
        if (!text) continue;
        const level = headingLevel(node, styles);
        if (level) {
          close();
          raw.push({ heading: `${"#".repeat(level)} ${text.replace(/\s*\n\s*/g, " ")}`, text: "" });
        } else {
          const pPr = childNamed(node, "w:pPr");
          lines.push(pPr && childNamed(pPr, "w:numPr") ? `- ${text}` : text); // 글머리·번호 목록은 "- " 로
        }
      } else if (node.name === "w:tbl") {
        lines.push(...tableLines(node));
      } else if (CONTAINERS.has(node.name)) {
        walk(node.children);
      }
    }
  };
  walk(body.children);
  close();

  const sections = finalizeSections(raw);
  const warnings = sections.length ? [] : ["읽을 수 있는 글이 없어요. 그림만 있는 문서일 수 있어요."];
  return { sections, warnings };
}
