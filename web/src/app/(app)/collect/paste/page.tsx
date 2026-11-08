"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { mockClassify, type Utterance } from "@shared/classify";
import { DEMO_KNOWN_NAMES } from "@shared/mock";
import { ExportUpload } from "@/components/review/export-upload";
import { PasteInput } from "@/components/review/paste-input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, USE_MOCK } from "@/lib/api";
import { rpc } from "@/lib/rpc";
import { useLocalCandidates } from "@/lib/local-candidates";
import { knownNamesOf, useTeam } from "@/lib/team";

// 확장 없이 쓰는 백업 입력: 대화 붙여넣기 · ChatGPT 내보내기 파일 (이 브라우저 안에서만 분류)
export default function PastePage() {
  const router = useRouter();
  const [team] = useTeam();
  const local = useLocalCandidates();
  const [busy, setBusy] = useState(false);

  const classify = (label: string) => async (utterances: Utterance[]) => {
    setBusy(true);
    try {
      if (!USE_MOCK) {
        const conversationId = crypto.randomUUID();
        const messages = utterances.map((u, i) => ({ id: u.id ?? `${conversationId}:${i}`, conversationId: u.conversationId ?? conversationId,
          collectedAt: u.collectedAt ?? new Date().toISOString(), site: u.conversationId ? 'chatgpt-export' : 'manual',
          role: u.speaker === 'ai' ? 'assistant' : 'user', roleGuessed: u.roleGuessed ?? true, text: u.text }));
        for (let i=0; i<messages.length; i+=200) await rpc('turns.append', { messages: messages.slice(i,i+200), flush: i+200>=messages.length });
        toast.success('분류 대기함에 저장했어요. 승인함에서 처리 결과를 확인하세요.');
        router.push('/review');
        return;
      }
      const board = await api.getBoard().catch(() => []);
      const existingTopicKeys = [...new Set(board.map((c) => c.topic_key).filter((k): k is string => !!k))];
      // 지금은 목업 분류기. 로컬 수집기(하은 님 AI)는 확장을 통해서만 부를 수 있다
      const cards = mockClassify(utterances, {
        userName: team.me,
        knownNames: [...new Set([...knownNamesOf(team), ...DEMO_KNOWN_NAMES])],
        existingTopicKeys,
      });
      local.replace(cards, label);
      toast.success("분류했어요. 승인함에서 팀에 올릴 내용을 골라 주세요");
      router.push("/review");
    } catch (e) {
      toast.error(`분류 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-content space-y-6 px-gutter py-10">
      <Link href="/collect" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        대화 수집
      </Link>
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">대화 직접 넣기</h1>
        <p className="text-muted-foreground break-keep">
          대화를 붙여넣거나 내보내기 파일에서 필요한 대화를 선택하세요. 선택한 발화는 로컬에 보관하고 민감정보를 가린 뒤 AI 분류에 보냅니다. 팀에는 승인한 카드만 공유합니다.
        </p>
      </div>
      <section className="rounded-xl border bg-card p-6">
        <Tabs defaultValue="paste" className="gap-4">
          <TabsList className="w-full sm:w-fit">
            <TabsTrigger value="paste">붙여넣기</TabsTrigger>
            <TabsTrigger value="export">내보내기 파일 업로드</TabsTrigger>
          </TabsList>
          <TabsContent value="paste">
            <PasteInput busy={busy} onClassify={classify("붙여넣은 대화")} />
          </TabsContent>
          <TabsContent value="export">
            <ExportUpload busy={busy} onClassify={classify("ChatGPT 내보내기 파일")} />
          </TabsContent>
        </Tabs>
      </section>
    </div>
  );
}
