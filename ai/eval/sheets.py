"""민규 님 샘플 대화·정답표 읽기 (.xlsx 또는 .csv, 표준 라이브러리만).

  python3 -m eval.sheets  → data/ 안 파일들의 시트·컬럼 이름 출력 (아래 컬럼 주석과 같아야 한다)
"""
from __future__ import annotations

import csv
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}

# 컬럼 (민규 님 v1 파일 기준)
# sample_conversations: member, turn, date(엑셀 날짜), time(하루 중 비율), message_id, speaker, text
# answer_key: unit_id, message_id, text, relevance(관련/개인), subtopic, tag(결정/할 일/조사/해당 없음 (…)),
#             topic_key, owner_or_source, due(엑셀 날짜), is_change(0/1), masked(1), note
# conflict_key: pair_id, old_unit, old_text, new_unit, new_text, topic_key, label(충돌/같음/바뀜/비교 안 함), reason


def _col(ref: str) -> int:
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group():
        n = n * 26 + ord(ch) - 64
    return n - 1


def read_xlsx(path: Path) -> dict[str, list[list[str]]]:
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
                shared.append("".join(t.text or "" for t in si.iter(f"{{{NS['m']}}}t")))
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        target = {r.get("Id"): r.get("Target") for r in rels}
        sheets = {}
        for s in wb.find("m:sheets", NS):
            rid = s.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
            xml = ET.fromstring(z.read("xl/" + target[rid].lstrip("/").removeprefix("xl/")))
            rows = []
            for row in xml.iter(f"{{{NS['m']}}}row"):
                cells: dict[int, str] = {}
                for c in row.findall("m:c", NS):
                    v = c.find("m:v", NS)
                    if c.get("t") == "s" and v is not None:
                        val = shared[int(v.text)]
                    elif c.get("t") == "inlineStr":
                        val = "".join(t.text or "" for t in c.iter(f"{{{NS['m']}}}t"))
                    else:
                        val = v.text if v is not None else ""
                    cells[_col(c.get("r"))] = val or ""
                if cells:
                    rows.append([cells.get(i, "") for i in range(max(cells) + 1)])
            sheets[s.get("name")] = rows
        return sheets


def read_table(path: Path) -> list[dict[str, str]]:
    """첫 시트(또는 csv)를 [{컬럼: 값}] 으로."""
    if path.suffix == ".xlsx":
        rows = next(iter(read_xlsx(path).values()))
    else:
        with path.open(encoding="utf-8-sig", newline="") as f:
            rows = list(csv.reader(f))
    header, *body = rows
    return [dict(zip(header, r + [""] * (len(header) - len(r)))) for r in body if any(r)]


if __name__ == "__main__":
    files = [p for p in sorted(DATA.iterdir()) if p.suffix in (".xlsx", ".csv")] if DATA.exists() else []
    if not files:
        print(f"{DATA} 에 xlsx/csv 파일이 없습니다.", file=sys.stderr)
    for p in files:
        rows = read_table(p)
        print(f"\n## {p.name}  ({len(rows)}행)")
        print("컬럼:", list(rows[0].keys()) if rows else "(비어 있음)")
        for r in rows[:3]:
            print("  ", r)
