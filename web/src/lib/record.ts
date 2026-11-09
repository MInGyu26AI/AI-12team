// 팀 보드 → AI 에 붙여넣기 좋은 마크다운
import { TAG_LABEL } from "@shared/labels";
import { SUBTOPICS, type Conflict, type RelatedCard } from "@shared/types";

export function boardToMarkdown(cards: RelatedCard[], conflicts: Conflict[]): string {
  const today = new Date().toLocaleDateString("ko-KR");
  const lines = [
    `# 싱크업 팀 기록 (${today})`,
    "",
    "아래는 우리 팀이 지금까지 합의한 내용입니다. 이 내용을 전제로 답해 주세요.",
  ];

  for (const subtopic of SUBTOPICS) {
    const inSection = cards.filter((c) => (c.subtopic ?? "기타") === subtopic);
    if (!inSection.length) continue;
    lines.push("", `## ${subtopic}`);
    for (const c of uniqueByTopic(inSection)) {
      const meta = [
        c.tag === "todo" ? `담당 ${c.owner ?? "미정"}` : c.owner && `결정 ${c.owner}`,
        c.tag === "todo" && `기한 ${c.due ?? "미정"}`,
      ].filter(Boolean);
      lines.push(
        `- [${TAG_LABEL[c.tag]}] ${c.topic_key ? `${c.topic_key}: ` : ""}${c.content}${meta.length ? ` (${meta.join(", ")})` : ""}`,
      );
    }
  }

  if (conflicts.length) {
    lines.push("", "## 아직 정리되지 않은 충돌");
    for (const x of conflicts) {
      lines.push(`- ${x.topic_key}: "${x.cardA.content}" vs "${x.cardB.content}"`);
    }
  }
  return lines.join("\n");
}

// 같은 세부 주제끼리 모으고(처음 나온 주제 순서), 같은 내용이 여러 번 승인됐으면 한 번만
function uniqueByTopic(cards: RelatedCard[]): RelatedCard[] {
  const byTopic = new Map<string, RelatedCard[]>();
  const seen = new Set<string>();
  for (const c of cards) {
    const key = `${c.tag}|${c.topic_key}|${c.content.replace(/\s/g, "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const topic = c.topic_key ?? "";
    const group = byTopic.get(topic);
    if (group) group.push(c);
    else byTopic.set(topic, [c]);
  }
  return [...byTopic.values()].flat();
}
