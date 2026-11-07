"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { nowSource, parsePasted, type Utterance } from "@/lib/classify";

// 시연용 예시 대화 (docs/classification.md 예시 + 새 충돌을 만드는 문장)
const SAMPLE = `나: 오늘 점심 김밥 먹었어.
나: 타깃은 대학생으로 가자. 승인 화면은 카드 형태로 하자.
나: 서비스명은 팀메모리로 바꾸자.
ChatGPT: 좋아요. 이름이 바뀌면 발표 자료도 같이 고쳐야 해요.
나: 분류 기준표는 내가 내일까지 만들게.
나: 발표 자료는 010-1234-5678로 보내 줘.
나: 심사 기준에 AI 활용도가 있대.
나: 주제를 청년 주거로 하면 어때?
나: 기준표 누가 좀 만들어야 할 텐데.
나: 수요일 병원 가서 회의 못 갈 것 같아.`;

export function PasteInput({ busy, onClassify }: { busy: boolean; onClassify: (u: Utterance[]) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="space-y-3">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder={"AI와 나눈 대화를 붙여넣으세요.\n줄 앞에 '나:' 또는 'ChatGPT:'가 있으면 누가 말했는지 구분해요."}
        className="bg-background"
      />
      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={() => setText(SAMPLE)}>
          예시 대화 넣기
        </Button>
        <Button disabled={!text.trim() || busy} onClick={() => onClassify(parsePasted(text, nowSource("붙여넣기")))}>
          <Sparkles />
          {busy ? "분류 중…" : "분류하기"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        붙여넣은 대화는 이 브라우저 안에서만 분류돼요. 팀에는 내가 체크해서 공유한 카드만 올라가요.
      </p>
    </div>
  );
}
