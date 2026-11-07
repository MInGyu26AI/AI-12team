"use client";

import { useEffect, useState } from "react";
import type { Card as CardT } from "@shared/types";
import { MOCK_TEAM_CODE } from "@shared/mock";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// 세팅 확인용 임시 보드. 다음 작업에서 필터 탭·충돌 경고·기록 복사로 교체.
export default function BoardPage() {
  const [cards, setCards] = useState<CardT[] | null>(null);

  useEffect(() => {
    api.getBoard(MOCK_TEAM_CODE).then(setCards);
  }, []);

  return (
    <main className="mx-auto w-full max-w-3xl p-6 space-y-4">
      <h1 className="text-2xl font-bold">팀 결정 보드</h1>
      {!cards && <p className="text-muted-foreground">불러오는 중…</p>}
      {cards?.map((c) => (
        <Card key={c.id}>
          <CardHeader className="flex-row items-center gap-2">
            <Badge>{c.category}</Badge>
            <Badge variant="outline">{c.topic}</Badge>
            <CardTitle className="text-base">{c.content}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {c.author} · {c.source} · {c.evidence}
          </CardContent>
        </Card>
      ))}
    </main>
  );
}
