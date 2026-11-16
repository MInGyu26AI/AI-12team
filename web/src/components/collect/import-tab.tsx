"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { DocumentConnections } from "@/components/collect/document-connections";
import { FileUploadCard } from "@/components/collect/file-upload-card";
import { btnPrimary, panel, panelTitle } from "./collect-ui";
import { cn } from "@/lib/utils";

// 직접 가져오기 탭: 자동 수집이 못 읽는 대화·자료를 손으로 가져오는 길 (붙여넣기 · 내보내기 파일 · 자료 파일 · 노션·구글 문서).
// 붙여넣기와 내보내기 파일 입력은 /collect/paste 에 있고, 여기서는 그리로 안내한다. 셋 다 승인함 후보가 되고 팀에는 승인한 것만 올라간다
export function ImportTab({ connected }: { connected: boolean }) {
  return (
    <div className="grid grid-cols-1 items-start gap-4 @2xl:grid-cols-2">
      <section className={cn(panel, "flex flex-col gap-3 p-5")} aria-labelledby="paste-card-title">
        <h2 id="paste-card-title" className={panelTitle}>
          대화 붙여넣기 · ChatGPT 내보내기 파일
        </h2>
        <p className="text-sm leading-[1.6] text-ink-body break-keep">
          자동 수집이 못 읽은 대화는 복사해서 붙여넣거나, ChatGPT 내보내기 파일(zip 또는 conversations.json)에서 팀 관련 대화만 골라 가져와요. 가져온 내용은 승인함 후보가 되고, 팀에는 내가 승인한 것만 공유돼요.
        </p>
        <Link href="/collect/paste" className={cn(btnPrimary, "self-start")}>
          대화 직접 붙여넣기
          <ArrowRight />
        </Link>
        <p className="text-xs leading-[1.5] text-muted-foreground break-keep">
          카카오톡 대화나 텍스트도 붙여넣을 수 있어요. 내보내기 파일은 이 브라우저 안에서만 열어요.
        </p>
      </section>
      <FileUploadCard />
      <DocumentConnections connected={connected} />
    </div>
  );
}
