// .xlsx 읽기: 시트마다 한 구획, 행은 탭으로 나눈 줄. 숨긴 시트는 읽지 않고, 시트당 2000행까지만 읽는다.
// 시트 XML 이 클 수 있어 행·칸은 정규식으로 훑는다 (2000행을 채우면 멈춘다).
import { fileHeading, finalizeSections, type RawSection } from "./sections";
import { decodeEntities, findAll, findFirst, openZip, parseXml, readZipText } from "./xml";
import { FileImportError, type ParseResult } from "./types";

export const MAX_ROWS_PER_SHEET = 2000;

const ROW = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
const CELL = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const T_ELEMENT = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;

const attr = (attrs: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];

// "AB12" → 27 (0부터)
function columnIndex(ref: string | undefined): number | null {
  const letters = /^([A-Z]+)/.exec(ref ?? "")?.[1];
  if (!letters) return null;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const textElements = (xml: string) => decodeEntities([...xml.matchAll(T_ELEMENT)].map((m) => m[1] ?? "").join(""));

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  for (const si of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    out.push(textElements((si[1] ?? "").replace(/<rPh\b[\s\S]*?<\/rPh>/g, ""))); // 후리가나(rPh)는 뺀다
  }
  return out;
}

// 내장 날짜·시간 서식 번호
const isBuiltinDateFormat = (id: number) => (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58);
const isCustomDateFormat = (code: string) => /[ymdhs]/i.test(code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, ""));

/** styles.xml 의 셀 서식(cellXfs) 순서대로 날짜 서식인지 */
function dateStyles(stylesXml: string | null): boolean[] {
  if (!stylesXml) return [];
  const root = parseXml(stylesXml);
  const codes = new Map(findAll(root, "numFmt").map((n) => [Number(n.attrs["numFmtId"]), n.attrs["formatCode"] ?? ""]));
  const xfs = findFirst(root, "cellXfs")?.children.filter((c) => c.name === "xf") ?? [];
  return xfs.map((xf) => {
    const id = Number(xf.attrs["numFmtId"]);
    return isBuiltinDateFormat(id) || (codes.has(id) && isCustomDateFormat(codes.get(id)!));
  });
}

/** 엑셀 날짜 일련번호 → "2026-11-15" · "2026-11-15 14:30" · "14:30" */
export function excelSerialToText(serial: number, date1904 = false): string {
  const totalMinutes = Math.round(serial * 1440);
  const days = Math.floor(totalMinutes / 1440);
  const minutes = totalMinutes - days * 1440;
  const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  if (days === 0) return time;
  const date = new Date((days - (date1904 ? 24107 : 25569)) * 86400000).toISOString().slice(0, 10);
  return minutes ? `${date} ${time}` : date;
}

function formatNumber(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(12)));
}

interface Context {
  shared: string[];
  dates: boolean[];
  date1904: boolean;
}

function cellValue(attrs: string, inner: string, ctx: Context): string {
  const type = attr(attrs, "t");
  const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
  if (type === "inlineStr") return textElements(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? "");
  if (v === undefined) return "";
  const value = decodeEntities(v);
  switch (type) {
    case "s":
      return ctx.shared[Number(value)] ?? "";
    case "b":
      return value === "1" ? "TRUE" : "FALSE";
    case "e": // 수식 오류(#N/A 등)는 내용이 아니다
      return "";
    case "str":
    case "d":
      return value;
    default: {
      const n = Number(value);
      const style = Number(attr(attrs, "s"));
      return Number.isFinite(n) && ctx.dates[style] ? excelSerialToText(n, ctx.date1904) : formatNumber(value);
    }
  }
}

const oneLineCell = (s: string) => s.replace(/[\t\r\n]+/g, " ").trim();

/** 시트 XML → 행 줄들. 2000행을 채우면 거기서 멈추고 truncated */
function sheetRows(xml: string, ctx: Context): { rows: string[]; truncated: boolean } {
  const rows: string[] = [];
  for (const row of xml.matchAll(ROW)) {
    const cells: string[] = [];
    let next = 0;
    for (const cell of (row[2] ?? "").matchAll(CELL)) {
      const col = columnIndex(attr(cell[1]!, "r")) ?? next;
      cells[col] = oneLineCell(cellValue(cell[1]!, cell[2] ?? "", ctx));
      next = col + 1;
    }
    const line = Array.from(cells, (c) => c ?? "").join("\t").replace(/\t+$/, "");
    if (!line.trim()) continue;
    if (rows.length >= MAX_ROWS_PER_SHEET) return { rows, truncated: true };
    rows.push(line);
  }
  return { rows, truncated: false };
}

// 워크북 관계(rId → 파일 경로)
function sheetPaths(relsXml: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!relsXml) return map;
  for (const rel of findAll(parseXml(relsXml), "Relationship")) {
    const target = rel.attrs["Target"];
    if (rel.attrs["Id"] && target) map.set(rel.attrs["Id"], target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  return map;
}

export async function parseXlsx(bytes: ArrayBuffer, fileName: string): Promise<ParseResult> {
  const zip = await openZip(bytes, "Excel");
  const workbookXml = await readZipText(zip, "xl/workbook.xml");
  if (!workbookXml) throw new FileImportError("Excel 문서가 아니에요. xl/workbook.xml 이 없어요.");
  const workbook = parseXml(workbookXml);
  const paths = sheetPaths(await readZipText(zip, "xl/_rels/workbook.xml.rels"));
  const ctx: Context = {
    shared: parseSharedStrings(await readZipText(zip, "xl/sharedStrings.xml")),
    dates: dateStyles(await readZipText(zip, "xl/styles.xml")),
    date1904: ["1", "true"].includes(findFirst(workbook, "workbookPr")?.attrs["date1904"] ?? ""),
  };

  const warnings: string[] = [];
  const raw: RawSection[] = [];
  let hidden = 0;
  for (const [i, sheet] of findAll(workbook, "sheet").entries()) {
    const name = sheet.attrs["name"] ?? `시트${i + 1}`;
    const state = sheet.attrs["state"];
    if (state === "hidden" || state === "veryHidden") {
      hidden += 1;
      raw.push({ heading: fileHeading(fileName, name), text: "" }); // 번호는 자리를 지킨다
      continue;
    }
    const path = paths.get(sheet.attrs["r:id"] ?? "") ?? `xl/worksheets/sheet${i + 1}.xml`;
    const xml = await readZipText(zip, path);
    const { rows, truncated } = xml ? sheetRows(xml, ctx) : { rows: [], truncated: false };
    if (truncated) warnings.push(`시트 '${name}' 는 ${MAX_ROWS_PER_SHEET}행까지만 읽었어요.`);
    raw.push({ heading: fileHeading(fileName, name), text: rows.join("\n"), repeat: rows.length > 1 ? rows[0] : undefined });
  }
  if (hidden) warnings.unshift(`숨긴 시트 ${hidden}개는 읽지 않았어요.`);
  const sections = finalizeSections(raw);
  if (!sections.length) warnings.push("읽을 수 있는 내용이 없어요.");
  return { sections, warnings };
}
