"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { nowSource, parsePasted, type Utterance } from "@shared/classify";

// 시연용 예시 대화 (평가용 정답표와 겹치지 않는 새 문장).
// 할 일 · 요청 속 숨은 결정 · AI 답변 속 조사 · 단톡방 줄의 결정(화자 = 결정자, 기존 '싱크업'과 충돌) · 전화번호 가림 · 제안 · 개인
const SAMPLE = `나: 분류 기준표는 내가 내일까지 만들게.
나: 프론트는 Next.js 기준으로 화면 코드 짜 줘.
ChatGPT: 찾아보니 크롬 웹스토어 심사는 며칠이 걸릴 수 있어요. 해커톤에서는 개발자 모드로 설치해서 시연하는 경우가 많아요.
나: 이거 우리 단톡방 내용이야.
[유나] 로고랑 서비스명은 MemBridge로 하자
[서준] 발표 자료는 010-9876-5432로 보내 줘
나: 발표 순서는 기능 시연부터 하면 어때?
나: 아 난 오늘 저녁 약속 있어서 9시 넘어서 들어갈게.`;

export function PasteInput({ busy, onClassify }: { busy: boolean; onClassify: (u: Utterance[]) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="space-y-3">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        placeholder={
          "AI와 나눈 대화를 붙여넣으세요.\n줄 앞에 '나:' 또는 'ChatGPT:'가 있으면 누가 말했는지 구분해요.\n단톡방은 '[이름] 내용' 형식이면 그 줄을 말한 사람을 결정자로 봐요."
        }
        className="bg-background"
      />
      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={() => setText(SAMPLE)}>
          예시 대화 넣기
        </Button>
        <Button className="bg-brand hover:bg-brand-hover" disabled={!text.trim() || busy} onClick={() => onClassify(parsePasted(text, nowSource("ChatGPT")))}>
          <Sparkles />
          {busy ? "분류 중…" : "분류하기"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        선택한 발화는 로컬 수집기를 통해 AI 분류에 보내요. 팀에는 내가 승인한 카드만 올라가요.
      </p>
    </div>
  );
}
