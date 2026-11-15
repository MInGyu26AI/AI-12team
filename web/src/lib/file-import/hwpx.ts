// .hwpx 읽기 (한글 문서의 XML 형식): Contents/section*.xml 의 글자(hp:t)를 문단 순서대로. 표는 탭으로 나눈 줄.
// 제목 단계는 알아내지 않고 구역(section) 파일마다 한 구획이다. 옛 .hwp(바이너리)는 읽지 않는다.
import { fileHeading, finalizeSections, type RawSection } from "./sections";
import { childrenNamed, findAll, openZip, parseXml, textOf, readZipText, type XmlNode } from "./xml";
import { FileImportError, type ParseResult } from "./types";

// 문단 글자. 안의 표는 따로 다루므로 내려가지 않는다
function paragraphText(p: XmlNode): string {
  let out = "";
  const visit = (node: XmlNode) => {
    if (node.name === "hp:tbl") return;
    if (node.name === "hp:t") {
      for (const child of node.children) {
        if (child.name === "hp:tab") out += "\t";
        else if (child.name === "hp:lineBreak") out += "\n";
        else out += textOf(child);
      }
      return;
    }
    node.children.forEach(visit);
  };
  p.children.forEach(visit);
  return out;
}

const cellText = (cell: XmlNode) =>
  findAll(cell, "hp:p")
    .map((p) => paragraphText(p).replace(/[\t\n]+/g, " ").trim())
    .filter(Boolean)
    .join(" ");

function tableLines(tbl: XmlNode): string[] {
  return childrenNamed(tbl, "hp:tr")
    .map((row) => childrenNamed(row, "hp:tc").map(cellText).join("\t").replace(/\t+$/, ""))
    .filter((line) => line.trim());
}

function sectionLines(root: XmlNode): string[] {
  const lines: string[] = [];
  const tables = (node: XmlNode) => {
    if (node.name === "hp:tbl") lines.push(...tableLines(node));
    else node.children.forEach(tables);
  };
  const visit = (node: XmlNode) => {
    if (node.name === "hp:tbl") {
      lines.push(...tableLines(node));
    } else if (node.name === "hp:p") {
      const text = paragraphText(node).trim();
      if (text) lines.push(text);
      node.children.forEach(tables); // 문단 안에 든 표
    } else {
      node.children.forEach(visit);
    }
  };
  visit(root);
  return lines;
}

export async function parseHwpx(bytes: ArrayBuffer, fileName: string): Promise<ParseResult> {
  const zip = await openZip(bytes, "한글(hwpx)");
  const paths = Object.keys(zip.files)
    .filter((p) => /^Contents\/section\d+\.xml$/i.test(p))
    .sort((a, b) => Number(/(\d+)\.xml$/i.exec(a)![1]) - Number(/(\d+)\.xml$/i.exec(b)![1]));
  if (!paths.length) throw new FileImportError("한글(hwpx) 문서가 아니에요. Contents/section0.xml 이 없어요.");

  const raw: RawSection[] = [];
  for (const [i, path] of paths.entries()) {
    const xml = await readZipText(zip, path);
    raw.push({
      heading: fileHeading(fileName, paths.length > 1 ? `${i + 1}번째 구역` : undefined),
      text: xml ? sectionLines(parseXml(xml)).join("\n") : "",
    });
  }
  const sections = finalizeSections(raw);
  return { sections, warnings: sections.length ? [] : ["읽을 수 있는 글이 없어요. 암호가 걸렸거나 그림뿐인 문서일 수 있어요."] };
}
