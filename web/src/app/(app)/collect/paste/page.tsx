"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { mockClassify } from "@shared/classify";
import { DEMO_KNOWN_NAMES } from "@shared/mock";
import type { Utterance } from "@shared/utterance";
import { ExportUpload } from "@/components/review/export-upload";
import { PasteInput } from "@/components/review/paste-input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api, USE_MOCK } from "@/lib/api";
import { appendToCollector } from "@/lib/collector-intake";
import { useLocalCandidates } from "@/lib/local-candidates";
import { knownNamesOf, useTeam } from "@/lib/team";

// 확장 없이 쓰는 백업 입력: 대화 붙여넣기 · ChatGPT 내보내기 파일
// 실제 모드는 로컬 수집기로 보내 개인정보 검사와 외부 AI 분류를 거친다. 목업 모드만 이 브라우저 안에서 분류한다
export default function PastePage() {
  const router = useRouter();
  const team = useTeam();
  const local = useLocalCandidates();
  const [busy, setBusy] = useState(false);

  // 목업 모드: 브라우저 안 규칙 분류기로 바로 후보를 만든다 (기존 세부 주제 이름을 먼저 쓴다)
  const classifyInBrowser = async (utterances: Utterance[], label: string) => {
    const board = await api.getBoard().catch(() => []);
    const existingTopicKeys = [...new Set(board.map((c) => c.topic_key).filter((k): k is string => !!k))];
    const cards = mockClassify(utterances, {
      userName: team.me,
      knownNames: [...new Set([...knownNamesOf(team), ...DEMO_KNOWN_NAMES])],
      existingTopicKeys,
    });
    local.replace(cards, label);
  };

  const classify = (label: string) => async (utterances: Utterance[]) => {
    setBusy(true);
    try {
      if (USE_MOCK) {
        await classifyInBrowser(utterances, label);
        toast.success("분류했어요. 승인함에서 팀에 올릴 내용을 골라 주세요");
      } else {
        await appendToCollector(utterances);
        toast.success("분류 대기함에 저장했어요. 승인함에서 처리 결과를 확인하세요.");
      }
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
