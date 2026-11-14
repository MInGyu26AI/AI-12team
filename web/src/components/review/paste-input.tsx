"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { formatSource } from "@shared/format";
import { parsePasted, type Utterance } from "@shared/utterance";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { USE_MOCK } from "@/lib/api";

// 시연용 예시 대화: 목업 팀 '온길'(하은 님 합성 대화 H01, shared/mock.ts)에서 보드에 아직 없는 문장. 이름·연락처는 가짜.
// 목업 모드에서만 넣을 수 있다 (실제 모드에선 진짜 입력이 된다).
// 단톡방 줄의 할 일(담당 = 채원) · 전화번호 가림 · AI 답변 · 제안 · 개인 2줄
const SAMPLE = `나: 이거 우리 단톡방 내용이야.
[도윤] 발표 슬라이드 초안은 채원이가 일요일까지 만들어 줘. 급하면 010-3141-5926으로 연락해.
ChatGPT: 실외까지 넣으면 GPS 오차 처리가 추가로 필요해요.
[채원] QR 대신 NFC 태그는 어때?
[하준] 나 금요일에 치과 예약 있어서 저녁 회의 못 가.
[채원] 요즘 잠을 너무 못 자서 컨디션이 엉망이야.`;

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
        {USE_MOCK && (
          <Button variant="ghost" size="sm" onClick={() => setText(SAMPLE)}>
            예시 대화 넣기
          </Button>
        )}
        <Button
          className="ml-auto bg-brand hover:bg-brand-hover"
          disabled={!text.trim() || busy}
          onClick={() => onClassify(parsePasted(text, formatSource("ChatGPT")))}
        >
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
