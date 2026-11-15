"use client";

import { NotionLinkForm } from "@/components/board/notion-link-form";

// 팀 기록을 저장할 노션 페이지 연결 (/board/notion). 보드·레포 연결 화면에서 들어오는 링크는 #10 이 합쳐진 뒤 단다
export default function NotionLinkPage() {
  return (
    <main className="mx-auto w-full max-w-[640px] px-4 py-10">
      <NotionLinkForm />
    </main>
  );
}
