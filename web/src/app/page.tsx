"use client";

import { useEffect, useState } from "react";
import { SUBTOPICS, type RelatedCard } from "@shared/types";
import { BADGE_COLOR, TAG_LABEL, isShareable, statusBadges } from "@shared/labels";
import { MOCK_TEAM_CODE } from "@shared/mock";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// 팀 보드: subtopic별 섹션 → topic_key별 묶음 → 시간순 (CLAUDE.md §6 화면 규칙)
// 시간순은 서버가 주는 순서를 따른다 (Card 에 별도 시각 필드 없음)
export default function BoardPage() {
  const [cards, setCards] = useState<RelatedCard[] | null>(null);

  useEffect(() => {
    api.getBoard(MOCK_TEAM_CODE).then((all) => setCards(all.filter(isShareable)));
  }, []);

  return (
    <main className="mx-auto w-full max-w-3xl p-6 space-y-8">
      <h1 className="text-2xl font-bold">팀 결정 보드</h1>
      {!cards && <p className="text-muted-foreground">불러오는 중…</p>}
      {cards &&
        SUBTOPICS.map((subtopic) => {
          const inSection = cards.filter((c) => (c.subtopic ?? "기타") === subtopic);
          if (!inSection.length) return null;
          const groups = Map.groupBy(inSection, (c) => c.topic_key ?? "기타");
          return (
            <section key={subtopic} className="space-y-3">
              <h2 className="text-lg font-semibold">
                <Badge variant="outline" className={BADGE_COLOR.subtopic}>
                  {subtopic}
                </Badge>
              </h2>
              {[...groups].map(([topicKey, group]) => (
                <div key={topicKey} className="space-y-2">
                  <h3 className="text-sm font-medium text-muted-foreground">{topicKey}</h3>
                  {group.map((c) => (
                    <BoardCard key={c.id} card={c} />
                  ))}
                </div>
              ))}
            </section>
          );
        })}
    </main>
  );
}

function BoardCard({ card: c }: { card: RelatedCard }) {
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center gap-2">
        <Badge variant="outline" className={BADGE_COLOR.tag}>
          {TAG_LABEL[c.tag]}
        </Badge>
        {statusBadges(c).map((b) => (
          <Badge key={b.label} variant="outline" className={b.color}>
            {b.label}
          </Badge>
        ))}
        <CardTitle className="text-base">{c.content}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm text-muted-foreground">
        <p>“{c.sentence}”</p>
        <p>
          {[c.owner, c.due && `~${c.due}`, c.source].filter(Boolean).join(" · ")}
        </p>
      </CardContent>
    </Card>
  );
}
